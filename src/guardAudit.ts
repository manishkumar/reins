// Was the guard right?
//
// `reins audit <session>` answers "what did the gate decide". This answers the
// question after it: of everything the gate stopped, how much *deserved* it.
// Bypass reporting (src/bypass.ts) already computes half the answer live — it
// notices when a denied command's intent runs anyway — but it clears its ledger
// at the end of each run, so nobody can ever look back across a project and see
// the pattern. The DB kept the rows the whole time.
//
// Two verdicts, both deterministic, neither a guess:
//
//   stale        The recorded command does not match today's shipped rules at
//                all. That denial is not a judgement call that went the wrong
//                way; it is damage from a rule that was already fixed upstream.
//                (This is the freeze in fix(policy) seen from the other end: a
//                real repo took 14 of these before anyone noticed.)
//   worked around  A near-identical call executed later in the same session.
//                The veto didn't hold — either the rule is too broad for this
//                repo and the agent routed around it, or it needs to be a hold.
//
// Same containment measure as live bypass detection, so the two never disagree.
// Read-only, and reporting only: nothing here can influence a gate decision
// (invariants 1, 4 and 12). Capture is optional, so an install without SQLite
// simply has nothing to audit — it says so and exits 0.

import { SqlDb } from "./store";
import { GuardRule, GuardsFile, DEFAULT_RULES, checkGuards, loadGuards } from "./guards";
import { fingerprint, retryScore, BYPASS_WINDOW_MS } from "./bypass";

/** Gate rows wear their decision as a prefix in tool_calls.input_summary. */
const GATE_PREFIX = /^(DENIED|ASKED|HELD|APPROVED|REFUSED):\s*/;
/** ...and the rule that fired as a suffix. Both predate the decisions table. */
const GUARD_SUFFIX = /\s*\[guard:([^\]]+)\]\s*(\[hold:[^\]]+\])?\s*$/;

export interface Workaround {
  ts: string;
  summary: string;
  score: number;
  gapMs: number;
}

export interface DenialFact {
  session_id: string;
  ts: string;
  tool: string;
  /** The command/path as captured — normalized whitespace, possibly truncated. */
  summary: string;
  rule_id: string;
  /** The summary hit the capture length limit, so re-matching sees a prefix of
   *  the real command. Verdicts on these are reported, but marked. */
  truncated: boolean;
  /** Does this still match the rules on disk right now? */
  firesLocal: boolean;
  /** Does it match the rules reins ships today? False = the denial was damage
   *  from a rule that has since been fixed upstream. */
  firesShipped: boolean;
  workaround?: Workaround;
}

export interface RuleVerdict {
  rule_id: string;
  fired: number;
  /** Denials that today's shipped rules would not produce at all. */
  stale: number;
  /** Denials undone by a near-identical call that executed anyway. */
  workedAround: number;
  fastestWorkaroundMs: number | null;
  /** A few representative denials, worst first, for the human to read. */
  samples: DenialFact[];
}

export interface GuardAuditReport {
  denials: number;
  sessions: number;
  stale: number;
  workedAround: number;
  /** True when the policy on disk still produces denials the shipped rules
   *  wouldn't — i.e. `reins policy upgrade` has real work to do. */
  policyBehind: boolean;
  rules: RuleVerdict[];
}

interface RawCall {
  session_id: string;
  ts: string;
  tool: string;
  input_summary: string;
  ok: number | null;
}

/**
 * Every denial this project has recorded, oldest first.
 *
 * Read from both places they live. `decisions` is the clean table, but it only
 * exists from 0.4 — a project that has been running longer keeps its earlier
 * denials solely as tagged `tool_calls` rows, and those are exactly the history
 * worth auditing. Both are written in the same breath with the same timestamp
 * (see recordDecision), so (session, ts) dedupes them exactly.
 */
export function collectDenials(db: SqlDb): DenialFact[] {
  const seen = new Set<string>();
  const out: DenialFact[] = [];
  const add = (
    session_id: string,
    ts: string,
    tool: string,
    summary: string,
    rule_id: string,
  ): void => {
    const key = session_id + "|" + ts;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({
      session_id,
      ts,
      tool,
      summary,
      rule_id,
      truncated: summary.endsWith("…"),
      firesLocal: false,
      firesShipped: false,
    });
  };

  try {
    const rows = db
      .prepare(
        `SELECT session_id, ts, tool, input_summary, rule_id
           FROM decisions WHERE decision = 'deny' ORDER BY ts`,
      )
      .all() as Array<{
      session_id: string;
      ts: string;
      tool: string;
      input_summary: string;
      rule_id: string;
    }>;
    for (const r of rows) add(r.session_id, r.ts, r.tool, r.input_summary, r.rule_id || "?");
  } catch {
    // Pre-0.4 runs.db has no decisions table; the tool_calls sweep below is the
    // whole history there.
  }

  try {
    const rows = db
      .prepare(
        `SELECT session_id, ts, tool, input_summary
           FROM tool_calls WHERE input_summary LIKE 'DENIED:%' ORDER BY ts`,
      )
      .all() as Array<{ session_id: string; ts: string; tool: string; input_summary: string }>;
    for (const r of rows) {
      const m = GUARD_SUFFIX.exec(r.input_summary);
      const summary = r.input_summary.replace(GATE_PREFIX, "").replace(GUARD_SUFFIX, "");
      add(r.session_id, r.ts, r.tool, summary, m ? m[1] : "?");
    }
  } catch {
    /* no tool_calls to read — leave whatever decisions gave us */
  }

  out.sort((a, b) => a.ts.localeCompare(b.ts));
  return out;
}

/**
 * Re-run a recorded denial against a rule set.
 *
 * The input is reconstructed from the summary, which is lossy in two known
 * ways: whitespace (including newlines) was collapsed at capture, and long
 * commands were truncated. Both can only make a match LESS likely, never more —
 * so a "would still fire" verdict is solid, and a "wouldn't fire" verdict on a
 * truncated row is the one to mark. cwd is deliberately not supplied: without
 * it, relative-path exemptions don't widen, which again errs toward "still
 * fires". Under-claiming staleness is the right direction to be wrong in.
 */
export function firesUnder(rules: GuardRule[], tool: string, summary: string): boolean {
  const input = tool === "Bash" ? { command: summary } : { file_path: summary };
  const file: GuardsFile = { rules };
  try {
    return checkGuards(file, tool, input) !== null;
  } catch {
    return true; // can't tell — assume the denial stands rather than accuse a rule
  }
}

/**
 * Find the call that undid each denial, if there was one.
 *
 * Same session, same window, same containment threshold as live detection, so
 * this can't contradict what the Stop hook already told the user. Gate rows are
 * skipped: a HELD or ASKED row is not something that executed.
 */
export function attributeWorkarounds(db: SqlDb, denials: DenialFact[]): void {
  const bySession = new Map<string, RawCall[]>();
  for (const d of denials) {
    if (d.tool !== "Bash") continue; // bypass tracking is command-shaped
    let calls = bySession.get(d.session_id);
    if (!calls) {
      calls = db
        .prepare(
          `SELECT session_id, ts, tool, input_summary, ok
             FROM tool_calls WHERE session_id = ? AND tool = 'Bash'
              AND (ok IS NULL OR ok = 1) ORDER BY ts`,
        )
        .all(d.session_id) as RawCall[];
      calls = calls.filter((c) => !GATE_PREFIX.test(c.input_summary));
      bySession.set(d.session_id, calls);
    }
    const deniedFp = fingerprint(d.summary);
    if (deniedFp.length === 0) continue;
    const t0 = Date.parse(d.ts);
    let best: Workaround | undefined;
    for (const call of calls) {
      const gapMs = Date.parse(call.ts) - t0;
      if (!(gapMs > 0 && gapMs <= BYPASS_WINDOW_MS)) continue;
      const score = retryScore(deniedFp, fingerprint(call.input_summary));
      if (score === 0) continue;
      if (!best || score > best.score) {
        best = { ts: call.ts, summary: call.input_summary, score, gapMs };
      }
    }
    if (best) d.workaround = best;
  }
}

/** The whole audit: denials, their verdicts, rolled up per rule. */
export function auditGuards(db: SqlDb, cwd?: string): GuardAuditReport {
  const denials = collectDenials(db);
  attributeWorkarounds(db, denials);

  const local = loadGuards(cwd).rules;
  for (const d of denials) {
    d.firesLocal = firesUnder(local, d.tool, d.summary);
    d.firesShipped = firesUnder(DEFAULT_RULES, d.tool, d.summary);
  }

  const byRule = new Map<string, RuleVerdict>();
  const sessions = new Set<string>();
  for (const d of denials) {
    sessions.add(d.session_id);
    const v =
      byRule.get(d.rule_id) ??
      ({
        rule_id: d.rule_id,
        fired: 0,
        stale: 0,
        workedAround: 0,
        fastestWorkaroundMs: null,
        samples: [],
      } as RuleVerdict);
    v.fired++;
    if (!d.firesShipped) v.stale++;
    if (d.workaround) {
      v.workedAround++;
      if (v.fastestWorkaroundMs === null || d.workaround.gapMs < v.fastestWorkaroundMs) {
        v.fastestWorkaroundMs = d.workaround.gapMs;
      }
    }
    v.samples.push(d);
    byRule.set(d.rule_id, v);
  }

  // Lead with the rule that cost the most: worked-around denials first (the
  // guard didn't hold), then stale ones (the guard shouldn't have fired).
  const rules = [...byRule.values()].sort(
    (a, b) => b.workedAround - a.workedAround || b.stale - a.stale || b.fired - a.fired,
  );
  for (const v of rules) {
    v.samples.sort(
      (a, b) => Number(!!b.workaround) - Number(!!a.workaround) || a.ts.localeCompare(b.ts),
    );
  }

  return {
    denials: denials.length,
    sessions: sessions.size,
    stale: denials.filter((d) => !d.firesShipped).length,
    workedAround: denials.filter((d) => d.workaround).length,
    // Only worth telling someone to upgrade if their CURRENT rules are what's
    // producing the noise. A project that already upgraded still sees its old
    // denials in the history; that's not a call to action.
    policyBehind: denials.some((d) => d.firesLocal && !d.firesShipped),
    rules,
  };
}

export function humanGap(ms: number): string {
  return ms < 1000 ? `${ms}ms` : ms < 60000 ? `${Math.round(ms / 1000)}s` : `${Math.round(ms / 60000)}m`;
}
