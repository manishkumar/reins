import * as fs from "node:fs";
import { guardsPath, policyPath, ensureReinsDir } from "./paths";

export type GuardType = "bash" | "path" | "tool";

/** What a matching rule does at the tool boundary.
 *  "deny" — hard veto, the agent cannot proceed (the default).
 *  "ask"  — escalate: surface Claude Code's native permission prompt with our
 *           reason, letting the human decide. The middle hardness for actions
 *           that are sometimes fine (git push, prod-adjacent commands). Note:
 *           in a headless/non-interactive run there is no one to ask, so "ask"
 *           effectively denies there.
 *  "hold" — park for asynchronous approval: the call is denied *this time*, the
 *           proposed action is queued (`reins pending`), and the agent is told
 *           to continue with other work. `reins approve <id>` writes a one-shot
 *           allowance for the exact input, so the identical retry passes once.
 *           This is "ask" for the run nobody is watching. */
export type GuardAction = "deny" | "ask" | "hold";

export interface GuardRule {
  id: string;
  type: GuardType;
  /** For "bash": a regex tested against the command string.
   *  For "path": a glob tested against file paths in the tool input.
   *  For "tool": a NAME glob tested against the tool name itself (e.g.
   *  `mcp__stripe__*`, `WebFetch`) — how you catch MCP tools, which live
   *  outside bash/path entirely. */
  pattern: string;
  reason: string;
  /** Absent means "deny" — every pre-0.2 guards.json stays valid unchanged. */
  action?: GuardAction;
  /** Optional ISO-8601 date (e.g. "2026-08-01") after which this rule stops
   *  matching — a temporary hold on a risky area shouldn't outlive its reason.
   *  Treated as valid through the END of that day (UTC); see `isExpired`.
   *  A value that doesn't parse is treated as NOT expired — i.e. the rule
   *  stays ACTIVE. That's a deliberate fail-open choice: a typo in a date
   *  should not silently delete a guard the user believes is protecting them.
   *  `reins doctor` flags a malformed `expires` as a real error so it doesn't
   *  go unnoticed. */
  expires?: string;
}

export interface GuardsFile {
  rules: GuardRule[];
}

/** Policy file v1 renamed guards.json -> policy.json; the on-disk shape is
 *  unchanged (just a bigger rule vocabulary). Alias so call sites can adopt
 *  the new name without a mechanical rename of every `GuardsFile`. */
export type PolicyFile = GuardsFile;

// A small, sane default denylist. Hard vetoes only — things almost no run
// legitimately needs and that are expensive/irreversible when wrong.
// Fully overridable: `reins guard remove <id>` or edit .reins/guards.json.
export const DEFAULT_RULES: GuardRule[] = [
  {
    // Blocks RECURSIVE rm in any flag form — the dangerous part. Catches short
    // combos (-rf, -fr, -Rf, -r) and the long form (--recursive), while leaving
    // a single-file `rm -f x` / `rm --force x` alone. The leading \s anchors the
    // match to a real flag TOKEN (whitespace then dash), so a hyphen inside a
    // FILENAME — e.g. `rm -f /tmp/reins-pr-body.md`, where `-pr` reads like a
    // recursive short flag — is not mistaken for one. Two separate branches keep
    // `--force` (which contains an 'r') from matching the short-flag form.
    id: "rm-rf",
    type: "bash",
    pattern: "\\brm\\b[^;&|]*?\\s(?:-[a-z]*r[a-z]*\\b|--recursive\\b)",
    reason: "Recursive rm (rm -rf / --recursive) is blocked by a reins guard.",
  },
  {
    id: "git-force-push",
    type: "bash",
    pattern: "git\\s+push\\b.*(--force\\b|--force-with-lease\\b|-f\\b)",
    reason: "Force-pushing is blocked by a reins guard (history rewrite).",
  },
  {
    id: "git-hard-reset",
    type: "bash",
    pattern: "git\\s+reset\\s+--hard\\b",
    reason: "git reset --hard is blocked by a reins guard (discards work).",
  },
  {
    id: "sql-drop",
    type: "bash",
    pattern: "\\b(DROP\\s+(TABLE|DATABASE|SCHEMA)|TRUNCATE\\s+TABLE)\\b",
    reason: "Destructive SQL (DROP/TRUNCATE) is blocked by a reins guard.",
  },
  {
    id: "curl-pipe-shell",
    type: "bash",
    pattern: "(curl|wget)\\b[^|]*\\|\\s*(sudo\\s+)?(sh|bash|zsh)\\b",
    reason: "Piping a downloaded script straight into a shell is blocked by a reins guard.",
  },
  {
    // Covers the whole secret family: .env, .env.local, .env.production, etc.
    id: "write-dotenv",
    type: "path",
    pattern: "**/.env*",
    reason: "Writing to a .env file is blocked by a reins guard (secrets).",
  },
  {
    // Close the obvious bypass of write-dotenv: a shell redirect/copy into a
    // .env file. Pattern guards are speed bumps, not a sandbox — see README.
    id: "write-dotenv-bash",
    type: "bash",
    pattern: "(>>?|\\btee\\b|\\bcp\\b|\\bmv\\b)\\s*[^|;&]*\\.env(\\.[\\w.-]+)?(\\s|$|\"|')",
    reason: "Writing to a .env file via the shell is blocked by a reins guard (secrets).",
  },
  {
    id: "touch-git-internals",
    type: "path",
    pattern: "**/.git/**",
    reason: "Modifying .git internals is blocked by a reins guard.",
  },
];

/** Read+parse one rules file. Returns null on anything wrong (missing, bad
 *  JSON, `rules` not an array) — the caller falls back, never crashes. */
function readRulesFile(file: string): GuardsFile | null {
  try {
    const raw = fs.readFileSync(file, "utf8");
    const parsed = JSON.parse(raw) as GuardsFile;
    if (!Array.isArray(parsed.rules)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Which file is actually backing the active policy — for `reins doctor`. */
export function policySource(payloadCwd?: string): "policy.json" | "guards.json" | "defaults" {
  if (readRulesFile(policyPath(payloadCwd))) return "policy.json";
  if (readRulesFile(guardsPath(payloadCwd))) return "guards.json";
  return "defaults";
}

export function loadGuards(payloadCwd?: string): GuardsFile {
  // policy.json is canonical. guards.json (pre-0.3) keeps working forever —
  // an existing install must never break just because the name changed.
  // Neither present/valid => ship the defaults so guards work out of the box.
  return (
    readRulesFile(policyPath(payloadCwd)) ??
    readRulesFile(guardsPath(payloadCwd)) ??
    { rules: [...DEFAULT_RULES] }
  );
}

export function saveGuards(guards: GuardsFile, payloadCwd?: string): void {
  ensureReinsDir(payloadCwd);
  // Always write the canonical file. If only guards.json existed, this IS the
  // one-time migration: policy.json now exists alongside it, and guards.json
  // is left in place untouched — it's the user's file, never delete it out
  // from under them.
  fs.writeFileSync(policyPath(payloadCwd), JSON.stringify(guards, null, 2) + "\n");
}

// Translate a minimal glob into a fully-anchored RegExp.
//   `*` and `?`         match within a single path segment (never cross "/").
//   `**`                crosses separators.
//   a "globstar slash"  (two stars then a slash) means zero or more WHOLE
//                       leading segments, compiled to `(?:.*/)?`.
//
// The result is anchored ^...$ and is meant to be tested against a path AND
// each of its segment-aligned suffixes (see matchesPathGlob). That combination
// makes `infra/**` catch the ABSOLUTE paths Claude Code actually sends
// (e.g. /Users/x/proj/infra/main.tf) while keeping a `.env*` rule from falsely
// matching `server.env.log`. A path guard that silently never fires is the
// worst failure mode for a safety feature (false security), so this matters.
export function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        i++; // consume the second '*'
        if (glob[i + 1] === "/") {
          re += "(?:.*/)?"; // **/ => zero or more whole leading segments
          i++;
        } else {
          re += ".*"; // trailing ** (or **suffix) crosses separators
        }
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp("^" + re + "$");
}

/** Normalize a path for matching: Windows backslashes -> forward slashes. */
function normalizePath(p: string): string {
  return p.replace(/\\/g, "/");
}

/** Segment-aligned suffixes of a path: "a/b/c" -> ["a/b/c","b/c","c"]. */
function pathSuffixes(p: string): string[] {
  const out = [p];
  for (let i = 0; i < p.length; i++) {
    if (p[i] === "/" && i + 1 < p.length) out.push(p.slice(i + 1));
  }
  return out;
}

/** True if a path glob matches the (normalized) path or any of its suffixes. */
export function matchesPathGlob(re: RegExp, rawPath: string): boolean {
  const norm = normalizePath(rawPath);
  return pathSuffixes(norm).some((s) => re.test(s));
}

/** Collect file-path-like fields from a tool input. */
function pathsFromInput(input: Record<string, unknown>): string[] {
  const keys = ["file_path", "path", "notebook_path"];
  const out: string[] = [];
  for (const k of keys) {
    if (typeof input[k] === "string") out.push(input[k] as string);
  }
  return out;
}

export interface GuardMatch {
  rule: GuardRule;
}

/**
 * True if `rule.expires` has passed, so it should be treated as absent at
 * match time. A date-only value (the expected case, e.g. "2026-08-01") is
 * read as "valid through the end of that day" (UTC) rather than the instant
 * of midnight — the more forgiving reading of a human-picked date.
 *
 * A value that fails to parse is NOT expired — the rule stays ACTIVE. That's
 * the fail-open direction: a typo in a date must not silently remove a guard
 * the user believes is protecting them. `validateRules` reports the typo as a
 * real error so it doesn't go unnoticed instead.
 */
export function isExpired(rule: Pick<GuardRule, "expires">, now: Date = new Date()): boolean {
  if (!rule.expires) return false;
  const t = Date.parse(rule.expires);
  if (Number.isNaN(t)) return false; // malformed => not expired (fail-open toward still guarding)
  const endOfDay = t + 24 * 60 * 60 * 1000 - 1;
  return now.getTime() > endOfDay;
}

/**
 * Remove quoted string literals from a command before guard matching, so a
 * pattern mentioned inside an ARGUMENT (e.g. `git commit -m "removed rm -rf"`,
 * `echo "DROP TABLE"`) is not falsely blocked. Quoted text is data, not an
 * executed command. The known trade-off — content inside `bash -c "…"` is also
 * skipped — is consistent with guards being speed bumps, not a sandbox.
 */
export function stripQuoted(cmd: string): string {
  return cmd
    .replace(/"(?:[^"\\]|\\.)*"/g, " ")
    .replace(/'[^']*'/g, " ");
}

/** Returns the first matching guard rule for a tool call, or null. */
export function checkGuards(
  guards: GuardsFile,
  toolName: string,
  toolInput: unknown,
): GuardMatch | null {
  const input = (toolInput ?? {}) as Record<string, unknown>;
  for (const rule of guards.rules) {
    if (isExpired(rule)) continue; // expired rule = absent, as if never written
    if (rule.type === "bash") {
      if (toolName !== "Bash") continue;
      const command = typeof input.command === "string" ? input.command : "";
      if (!command) continue;
      let re: RegExp;
      try {
        re = new RegExp(rule.pattern, "i");
      } catch {
        continue; // skip malformed user regex rather than crash the guard
      }
      if (re.test(stripQuoted(command))) return { rule };
    } else if (rule.type === "path") {
      const paths = pathsFromInput(input);
      if (paths.length === 0) continue;
      let re: RegExp;
      try {
        re = globToRegExp(rule.pattern);
      } catch {
        continue;
      }
      for (const p of paths) {
        // Match against the path and every segment-aligned suffix, so a rule
        // like `infra/**` catches absolute paths and works on Windows too.
        if (matchesPathGlob(re, p)) return { rule };
      }
    } else if (rule.type === "tool") {
      // NAME glob against the tool itself (e.g. `mcp__stripe__*`, `WebFetch`) —
      // where MCP tools live, and where bash/path matching can't reach them.
      // Reuses globToRegExp directly (no suffix matching): tool names have no
      // path segments, and case sensitivity here is deliberate — tool names
      // are exact identifiers, not user-typed paths.
      let re: RegExp;
      try {
        re = globToRegExp(rule.pattern);
      } catch {
        continue;
      }
      if (re.test(toolName)) return { rule };
    }
  }
  return null;
}

export type PolicyProblemSeverity = "error" | "warning";

export interface PolicyProblem {
  ruleId: string;
  severity: PolicyProblemSeverity;
  message: string;
}

// Patterns that match (almost) any input — the rule "works" but guards
// nothing in particular, which is almost always a mistake rather than intent.
const TRIVIAL_PATTERNS = new Set([".*", ".", "*", "**"]);

/**
 * Validate rules for `reins doctor`. Read-only and never throws — a bad rule
 * is reported here, not crashed on; matching itself already fails open
 * (skips) around these same defects, so this is the loud complaint that
 * compensates for that quiet skip.
 *
 * Severity: "error" means the rule is broken or misconfigured in a way that's
 * never intentional (bad regex/glob, unknown type/action, duplicate id,
 * missing reason, unparsable expires) — these count toward doctor's exit
 * code. "warning" means the rule works exactly as written but the write may
 * not be what the human wants (an already-expired rule, a headless-hostile
 * `ask`, a pattern broad enough to match everything) — informational, no
 * exit-code impact, matching doctor's existing convention of not failing the
 * process over things that aren't actually broken.
 */
export function validateRules(rules: GuardRule[]): PolicyProblem[] {
  const problems: PolicyProblem[] = [];
  const seenIds = new Set<string>();
  for (const rule of rules) {
    const ruleId = rule.id || "(missing id)";

    if (rule.id) {
      if (seenIds.has(rule.id)) {
        problems.push({ ruleId, severity: "error", message: `duplicate rule id "${rule.id}"` });
      }
      seenIds.add(rule.id);
    }

    if (rule.type !== "bash" && rule.type !== "path" && rule.type !== "tool") {
      problems.push({
        ruleId,
        severity: "error",
        message: `unknown type "${String(rule.type)}" (expected bash, path, or tool)`,
      });
    } else if (rule.type === "bash") {
      try {
        new RegExp(rule.pattern);
      } catch (e) {
        problems.push({ ruleId, severity: "error", message: `invalid regex: ${(e as Error).message}` });
      }
    } else {
      try {
        globToRegExp(rule.pattern);
      } catch (e) {
        problems.push({ ruleId, severity: "error", message: `invalid glob: ${(e as Error).message}` });
      }
    }

    if (
      rule.action !== undefined &&
      rule.action !== "deny" &&
      rule.action !== "ask" &&
      rule.action !== "hold"
    ) {
      problems.push({
        ruleId,
        severity: "error",
        message: `unknown action "${String(rule.action)}" (expected deny, ask, or hold)`,
      });
    }

    if (!rule.reason || !rule.reason.trim()) {
      problems.push({ ruleId, severity: "error", message: "missing reason" });
    }

    if (rule.expires !== undefined) {
      if (Number.isNaN(Date.parse(rule.expires))) {
        problems.push({
          ruleId,
          severity: "error",
          message: `malformed expires "${rule.expires}" — treated as ACTIVE (fail-open); fix or remove it`,
        });
      } else if (isExpired(rule)) {
        problems.push({
          ruleId,
          severity: "warning",
          message: `expired ${rule.expires} — inactive, skipped at match time`,
        });
      }
    }

    if (TRIVIAL_PATTERNS.has(rule.pattern.trim())) {
      problems.push({
        ruleId,
        severity: "warning",
        message: `pattern "${rule.pattern}" matches everything — almost certainly too broad`,
      });
    }

    if (rule.action === "ask") {
      problems.push({
        ruleId,
        severity: "warning",
        message: "ask cannot prompt anyone in a headless/non-interactive run — it effectively denies there",
      });
    }
  }
  return problems;
}
