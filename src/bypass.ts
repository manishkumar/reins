// Did the guard actually stop anything?
//
// Six weeks of captured runs in a real repo answered "no". Sixteen denials,
// and in five of the five cases where the agent still wanted the outcome, it
// reran a trivially-altered command that sailed through — median gap eleven
// seconds. The most common edit was dropping a flag:
//
//     14:34:21  DENIED   rm -f src/app/harness/page.tsx && rmdir src/app/harness
//     14:34:30  ALLOWED  rm    src/app/harness/page.tsx && rmdir src/app/harness
//
// A single denial is not news — it's the guard doing its job. A denial that is
// undone seconds later is news, because it means one of two things and the
// human needs to know which: the rule is wrong and is fighting legitimate work,
// or it is right and is not holding. Both are worth interrupting for; neither is
// visible today.
//
// This is REPORTING, never enforcement. Detection happens in PostToolUse, from
// the far side of execution — the call already ran. Nothing here may influence
// a gate decision, and the state lives in a plain file rather than the DB so it
// keeps working where SQLite doesn't (capture is optional; this isn't).

import * as fs from "node:fs";
import * as path from "node:path";
import { reinsDir, ensureReinsDir } from "./paths";

/** How much of the denied command must reappear before it counts as a retry. */
export const BYPASS_SIMILARITY = 0.8;
/** Floor on shared tokens, so a two-word command can't match on one accident. */
const MIN_SHARED_TOKENS = 2;
/** How long a denial stays "recent" enough for a retry to be attributed to it. */
export const BYPASS_WINDOW_MS = 15 * 60 * 1000;
/** Cap on the ledger so a long-running project can't grow it without bound. */
const MAX_RECORDS = 300;

export interface DenialRecord {
  session_id: string;
  ts: string;
  rule_id: string;
  tool: string;
  summary: string;
  /** Normalized token set — see fingerprint(). */
  fp: string[];
  /** Set once a near-identical call is seen to have executed. */
  bypassed_ts?: string;
  bypassed_by?: string;
  similarity?: number;
}

function ledgerPath(cwd?: string): string {
  return path.join(reinsDir(cwd), "denials.jsonl");
}

/**
 * Reduce a command to the tokens that carry its INTENT, discarding the parts an
 * agent rewrites when it's working around a veto.
 *
 * Flags are dropped outright, which looks aggressive until you notice that
 * every observed bypass was precisely a flag edit: `rm -rf x` → `rm -r x` →
 * `rm x`. What survives is the verb and the targets, which is what actually
 * determines whether the same thing happened.
 */
export function fingerprint(command: string): string[] {
  const tokens = command
    .replace(/["']/g, " ")
    .split(/\s+/)
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean)
    // Flags: the thing that gets edited to slip past a pattern.
    .filter((t) => !t.startsWith("-"))
    // Shell punctuation and redirections carry no intent.
    .filter((t) => !/^(?:&&|\|\||[;|&]|\d?>{1,2}&?\d?|<)$/.test(t))
    .filter((t) => !/^\d?>{1,2}/.test(t))
    // Normalize path noise so ./x, x and /abs/proj/x agree.
    .map((t) => t.replace(/^\.\//, "").replace(/\/+$/, ""));
  return Array.from(new Set(tokens)).sort();
}

/**
 * How much of the DENIED command reappears in the executed one: |A∩B| / |A|.
 *
 * Deliberately asymmetric, and that asymmetry is the whole design. The question
 * worth answering is "did the thing I vetoed happen anyway?", not "are these two
 * commands equally similar to each other". A symmetric measure (Jaccard) gets
 * this wrong on real data: one of the observed bypasses re-ran the denied
 * deletion with `&& echo removed` appended, and those two extra tokens dragged
 * the score below threshold — reporting no bypass for a command that plainly
 * was one. Growth in the retry is normal; shrinkage of the original is not.
 */
export function containment(denied: string[], executed: string[]): number {
  const A = new Set(denied);
  if (A.size === 0) return 0;
  const B = new Set(executed);
  let shared = 0;
  for (const x of A) if (B.has(x)) shared++;
  // A one-token overlap on a short command is coincidence, not a retry.
  if (shared < Math.min(MIN_SHARED_TOKENS, A.size)) return 0;
  return shared / A.size;
}

function readLedger(cwd?: string): DenialRecord[] {
  try {
    const raw = fs.readFileSync(ledgerPath(cwd), "utf8");
    const out: DenialRecord[] = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line) as DenialRecord);
      } catch {
        // A torn line (concurrent append) is skipped, not fatal.
      }
    }
    return out;
  } catch {
    return [];
  }
}

function writeLedger(records: DenialRecord[], cwd?: string): void {
  ensureReinsDir(cwd);
  const kept = records.slice(-MAX_RECORDS);
  fs.writeFileSync(ledgerPath(cwd), kept.map((r) => JSON.stringify(r)).join("\n") + "\n");
}

/** Append a denial to the ledger. Best-effort: never throws into the hook. */
export function recordDenial(cwd: string | undefined, rec: DenialRecord): void {
  try {
    ensureReinsDir(cwd);
    fs.appendFileSync(ledgerPath(cwd), JSON.stringify(rec) + "\n");
    // Trim opportunistically rather than on every call.
    const all = readLedger(cwd);
    if (all.length > MAX_RECORDS * 2) writeLedger(all, cwd);
  } catch {
    /* reporting is never allowed to break a run */
  }
}

export interface BypassHit {
  denial: DenialRecord;
  score: number;
  gapMs: number;
}

/**
 * Did this executed command undo a recent denial in the same session?
 *
 * Scoped to one session on purpose: two developers hitting the same rule in
 * different runs is not a bypass, and cross-session attribution would produce
 * exactly the kind of confident-but-wrong claim that makes people stop reading
 * the output.
 */
export function findBypass(
  cwd: string | undefined,
  sessionId: string,
  command: string,
  now: Date = new Date(),
): BypassHit | null {
  if (!sessionId || !command) return null;
  const fp = fingerprint(command);
  if (fp.length === 0) return null;
  let best: BypassHit | null = null;
  for (const denial of readLedger(cwd)) {
    if (denial.session_id !== sessionId) continue;
    if (denial.bypassed_ts) continue; // already reported once
    const gapMs = now.getTime() - Date.parse(denial.ts);
    if (!(gapMs >= 0 && gapMs <= BYPASS_WINDOW_MS)) continue;
    const score = containment(denial.fp ?? [], fp);
    if (score < BYPASS_SIMILARITY) continue;
    if (!best || score > best.score) best = { denial, score, gapMs };
  }
  return best;
}

/** Mark a denial as bypassed so it is reported once, not on every later call. */
export function markBypassed(
  cwd: string | undefined,
  hit: BypassHit,
  executedSummary: string,
  now: Date = new Date(),
): void {
  try {
    const all = readLedger(cwd);
    for (const r of all) {
      if (r.session_id === hit.denial.session_id && r.ts === hit.denial.ts && !r.bypassed_ts) {
        r.bypassed_ts = now.toISOString();
        r.bypassed_by = executedSummary;
        r.similarity = Math.round(hit.score * 100) / 100;
        break;
      }
    }
    writeLedger(all, cwd);
  } catch {
    /* best-effort */
  }
}

export interface GuardSummary {
  fired: number;
  bypassed: number;
  byRule: Array<{ rule_id: string; fired: number; bypassed: number }>;
  fastestBypassMs: number | null;
}

/** Roll up one session's guard activity — the input to the Stop-hook summary. */
export function summarizeSession(cwd: string | undefined, sessionId: string): GuardSummary {
  const rows = readLedger(cwd).filter((r) => r.session_id === sessionId);
  const byRule = new Map<string, { rule_id: string; fired: number; bypassed: number }>();
  let bypassed = 0;
  let fastest: number | null = null;
  for (const r of rows) {
    const entry = byRule.get(r.rule_id) ?? { rule_id: r.rule_id, fired: 0, bypassed: 0 };
    entry.fired++;
    if (r.bypassed_ts) {
      entry.bypassed++;
      bypassed++;
      const gap = Date.parse(r.bypassed_ts) - Date.parse(r.ts);
      if (Number.isFinite(gap) && (fastest === null || gap < fastest)) fastest = gap;
    }
    byRule.set(r.rule_id, entry);
  }
  return {
    fired: rows.length,
    bypassed,
    byRule: [...byRule.values()].sort((a, b) => b.fired - a.fired),
    fastestBypassMs: fastest,
  };
}

/** Drop a session's rows once its run is summarized, so the ledger stays small
 *  and a later session can't be told about a stale denial. */
export function clearSession(cwd: string | undefined, sessionId: string): void {
  try {
    const kept = readLedger(cwd).filter((r) => r.session_id !== sessionId);
    writeLedger(kept, cwd);
  } catch {
    /* best-effort */
  }
}

function human(ms: number): string {
  return ms < 1000 ? `${ms}ms` : ms < 60000 ? `${Math.round(ms / 1000)}s` : `${Math.round(ms / 60000)}m`;
}

/**
 * The session summary. Written for the person who walked away and came back —
 * the per-event warning serves whoever is watching; this serves whoever isn't.
 *
 * It leads with the bypass count rather than the fire count because that's the
 * fact that changes what the reader should do. "3 guards fired" invites a nod;
 * "3 fired, 3 bypassed in under 15s" invites fixing the rules.
 */
export function formatSummary(summary: GuardSummary, heldCount: number): string | null {
  if (summary.fired === 0 && heldCount === 0) return null;
  const parts: string[] = [];
  if (summary.fired > 0) {
    const rules = summary.byRule
      .map((r) => `${r.fired}× ${r.rule_id}${r.bypassed > 0 ? ` (${r.bypassed} bypassed)` : ""}`)
      .join(", ");
    parts.push(`${summary.fired} guard${summary.fired === 1 ? "" : "s"} fired: ${rules}.`);
    if (summary.bypassed > 0) {
      const fastest =
        summary.fastestBypassMs !== null ? `, the fastest after ${human(summary.fastestBypassMs)}` : "";
      parts.push(
        `${summary.bypassed} of them ${summary.bypassed === 1 ? "was" : "were"} worked around by a ` +
          `near-identical call that ran anyway${fastest}. Guards match the form of a command, not its ` +
          `intent — either these rules are too broad for this repo, or they need to be holds.`,
      );
    }
  }
  if (heldCount > 0) {
    parts.push(
      `${heldCount} action${heldCount === 1 ? "" : "s"} still parked for approval — reins pending.`,
    );
  }
  return "[reins] " + parts.join(" ");
}
