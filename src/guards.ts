import * as fs from "node:fs";
import * as path from "node:path";
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
  /** Patterns that VETO a match of this rule — the exemption list. Same
   *  dialect as `pattern` (regex for "bash", glob for "path"/"tool").
   *
   *  Why this exists: six weeks of captured runs showed the recursive-rm guard
   *  firing 16 times and being *right* zero times — every hit was a build
   *  artifact (`rm -rf .next`) or a scratch file. A guard that is wrong every
   *  time is worse than absent: it trains the agent to route around it (which
   *  it did, 5/5, median 11 seconds) and trains the human to uninstall.
   *
   *  For "bash" the veto is evaluated PER COMMAND SEGMENT, not per command —
   *  see `splitCommandSegments`. Whole-command exemption would be a bypass:
   *  `rm -rf .next && rm -rf /` must still be blocked on its second segment.
   *  Omit for a rule that must never be exempt (see `rm-catastrophic`). */
  except?: string[];
  /** Where this rule came from. `default@<n>` marks a rule seeded from
   *  DEFAULT_RULES at policy version <n>, which is what makes `reins policy
   *  upgrade` possible: shipped rules can be refreshed while hand-written ones
   *  are left alone. Absent means hand-written (or a pre-0.4 file — those are
   *  matched by id instead, so existing installs are still upgradeable). */
  origin?: string;
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
  /** The DEFAULT_RULES generation this file was seeded from. Absent means a
   *  pre-0.4 file, which `reins policy upgrade` handles by matching rule ids. */
  version?: number;
}

/** Bump whenever DEFAULT_RULES changes in a way existing installs should get.
 *
 *  Before this existed there was no delivery path for a rule fix: a repo
 *  initialized in June was still running June's rules in late July, including
 *  a `rm -fr?` pattern that blocked plain `rm -f one-file.txt`. The fix had
 *  shipped weeks earlier and reached nobody. Shipping a rule change without
 *  bumping this is the same bug again. */
export const POLICY_VERSION = 2;

/** Policy file v1 renamed guards.json -> policy.json; the on-disk shape is
 *  unchanged (just a bigger rule vocabulary). Alias so call sites can adopt
 *  the new name without a mechanical rename of every `GuardsFile`. */
export type PolicyFile = GuardsFile;

// A small, sane default denylist. Hard vetoes only — things almost no run
// legitimately needs and that are expensive/irreversible when wrong.
// Fully overridable: `reins guard remove <id>` or edit .reins/guards.json.
export const DEFAULT_RULES: GuardRule[] = [
  {
    // Recursive rm aimed at a target you cannot rebuild: the filesystem root,
    // your home directory, a top-level system directory, or the parent of the
    // project. Deliberately listed BEFORE rm-rf and deliberately has no
    // `except` — first match wins, so `rm -rf .next && rm -rf /` is caught here
    // no matter how generous the exemption list below gets.
    id: "rm-catastrophic",
    type: "bash",
    pattern:
      "\\brm\\b[^\\n]*?\\s(?:-[a-z]*r[a-z]*|--recursive)\\b[^\\n]*?\\s[\"']?(?:" +
      "/(?:\\*|\\s|$)" + // `rm -rf /`, `rm -rf /*`
      "|~(?:/(?:\\*|\\s|$)|\\s|$)" + // `rm -rf ~`, `~/`, `~/*`
      "|\\$\\{?HOME\\}?" + // `rm -rf $HOME`
      "|\\.\\.(?:/(?:\\*|\\s|$)|\\s|$)" + // `rm -rf ..`
      "|/(?:etc|usr|var|bin|sbin|lib|opt|boot|dev|proc|sys|System|Library|Applications|Users|home)/?(?:\\s|$)" +
      ")",
    reason:
      "Recursive rm targeting the filesystem root, home, or a system directory is blocked by a reins guard.",
  },
  {
    // Blocks RECURSIVE rm in any flag form — the dangerous part. Catches short
    // combos (-rf, -fr, -Rf, -r) and the long form (--recursive), while leaving
    // a single-file `rm -f x` / `rm --force x` alone. The leading \s anchors the
    // match to a real flag TOKEN (whitespace then dash), so a hyphen inside a
    // FILENAME — e.g. `rm -f /tmp/reins-pr-body.md`, where `-pr` reads like a
    // recursive short flag — is not mistaken for one. Two separate branches keep
    // `--force` (which contains an 'r') from matching the short-flag form.
    //
    // The `except` list is the whole reason this rule is still worth having.
    // Measured over 2,396 captured tool calls, every single firing of this rule
    // was a build artifact or a scratch file — and the agent re-ran the same
    // deletion without the flag seconds later. Exempting the regenerable
    // directories costs nothing real (they are, by definition, rebuildable) and
    // buys back the credibility the rule needs on the day it is right.
    id: "rm-rf",
    type: "bash",
    pattern: "\\brm\\b[^;&|]*?\\s(?:-[a-z]*r[a-z]*\\b|--recursive\\b)",
    // Each entry is matched against a whole ARGUMENT, anchored, so the exempted
    // name has to BE a path component rather than merely appear in the text.
    // `rm -rf "my build dir"` stays blocked; `rm -rf /Users/x/p/build` does not.
    except: [
      // Build output and tool caches — regenerable by definition.
      "^(?:.*/)?(?:\\.next|\\.nuxt|\\.svelte-kit|\\.turbo|\\.cache|\\.parcel-cache|\\.pytest_cache|\\.mypy_cache|\\.gradle|__pycache__|node_modules|bower_components)(?:/.*)?$",
      "^(?:.*/)?(?:dist|build|out|target|coverage|\\.output|\\.vercel|\\.netlify)(?:/.*)?$",
      // Scratch space: /tmp, macOS /private/tmp + /var/folders, and the
      // per-session scratchpad Claude Code hands the agent.
      "^/(?:private/)?(?:tmp|var/folders)/",
      "^(?:.*/)?scratchpad(?:/.*)?$",
    ],
    reason: "Recursive rm (rm -rf / --recursive) is blocked by a reins guard.",
  },
  {
    id: "git-force-push",
    type: "bash",
    pattern: "git\\s+push\\b.*(--force\\b|--force-with-lease\\b|-f\\b)",
    reason: "Force-pushing is blocked by a reins guard (history rewrite).",
  },
  {
    // Deleting a remote branch. Added because the captured data showed the risk
    // ordering was backwards: `git push --force-with-lease` (the *safe* form of
    // a force push, on a feature branch) was denied, while
    // `git push origin --delete <branch>` — which destroys a ref other people
    // may be relying on — passed straight through. Covers both spellings:
    // `--delete`/`-d` and the older colon refspec (`git push origin :branch`).
    id: "git-delete-remote-branch",
    type: "bash",
    pattern: "git\\s+push\\b[^\\n]*?(?:\\s(?:--delete|-d)\\b|\\s:[\\w./-]+)",
    reason: "Deleting a remote branch is blocked by a reins guard.",
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
    { rules: [...DEFAULT_RULES], version: POLICY_VERSION }
  );
}

export function saveGuards(guards: GuardsFile, payloadCwd?: string): void {
  ensureReinsDir(payloadCwd);
  // Always write the canonical file. If only guards.json existed, this IS the
  // one-time migration: policy.json now exists alongside it, and guards.json
  // is left in place untouched — it's the user's file, never delete it out
  // from under them.
  // Write the version the caller actually has, and invent nothing. Stamping an
  // unversioned file with the CURRENT generation — which this used to do — is
  // how a stale install becomes a permanently stale one: a `reins guard add` on
  // a pre-0.4 policy.json rewrote it as "v2" while its rule bodies stayed at
  // June's, and `policy upgrade` then read the version, concluded nothing new
  // had shipped, and treated every stale rule as the user's own customization.
  // Measured in a real repo: a `rm-rf` rule with no exemptions, stamped current
  // and frozen there, denying `rm -rf .next` fourteen times. A file with no
  // version stays unversioned; upgrade handles it by matching rule ids.
  const out: GuardsFile = { ...guards };
  fs.writeFileSync(policyPath(payloadCwd), JSON.stringify(out, null, 2) + "\n");
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

/**
 * Split a shell command into independently-executed segments on `;`, `&&`,
 * `||`, `|` and newlines.
 *
 * This exists so exemptions can be judged per segment. Testing an `except`
 * against the whole command string would be a bypass with a friendly face:
 * `rm -rf .next && rm -rf /` contains `.next`, so a whole-command exemption
 * would wave through the part that ends your afternoon. Judging each segment
 * on its own means segment 1 is exempt and segment 2 still gets vetoed.
 *
 * Splitting happens OUTSIDE quotes so a separator inside an argument
 * (`git commit -m "build; then deploy"`) doesn't manufacture a segment. This
 * is a lexical split, not a shell parser — command substitution, heredocs and
 * `bash -c "…"` bodies are not descended into. That limit is the same one the
 * README already states for guards generally: they match form, not intent.
 */
export function splitCommandSegments(cmd: string): string[] {
  const segments: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    if (quote) {
      current += ch;
      if (ch === "\\" && quote === '"' && i + 1 < cmd.length) {
        current += cmd[++i]; // escaped char inside double quotes stays paired
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === "\n" || ch === ";") {
      segments.push(current);
      current = "";
      continue;
    }
    if ((ch === "&" || ch === "|") && cmd[i + 1] === ch) {
      segments.push(current);
      current = "";
      i++; // consume the doubled operator
      continue;
    }
    if (ch === "|" || ch === "&") {
      segments.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  segments.push(current);
  return segments.filter((s) => s.trim().length > 0);
}

/**
 * Split one command segment into argument tokens, honouring quotes and dropping
 * the quote characters themselves. `rm -rf "my build dir" src` yields
 * ["rm", "-rf", "my build dir", "src"].
 *
 * Exemptions are matched against these tokens rather than against the raw text,
 * and the difference is load-bearing in both directions. Matching raw text lets
 * a phrase inside a quoted argument ("my build dir") satisfy a `build`
 * exemption, waving through a deletion nobody exempted. Matching the
 * quote-stripped text instead (what `stripQuoted` produces) erases quoted PATHS
 * entirely, so `rm -rf "$TMP/build"` could never be exempted while its unquoted
 * twin could. Tokens are the level at which "is this argument a build
 * directory?" is actually a well-formed question.
 */
export function tokenizeArgs(segment: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let started = false;
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i];
    if (quote) {
      if (ch === "\\" && quote === '"' && i + 1 < segment.length) {
        current += segment[++i];
      } else if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (started) tokens.push(current);
      current = "";
      started = false;
      continue;
    }
    current += ch;
    started = true;
  }
  if (started) tokens.push(current);
  return tokens;
}

/** Compile a rule's `except` list, skipping entries that don't compile.
 *  A malformed exemption must not silently disable the rule it belongs to —
 *  it's dropped (so the rule keeps guarding) and `reins doctor` reports it. */
function compileExcept(rule: GuardRule, compile: (p: string) => RegExp): RegExp[] {
  if (!rule.except || rule.except.length === 0) return [];
  const out: RegExp[] = [];
  for (const p of rule.except) {
    try {
      out.push(compile(p));
    } catch {
      // skip — validateRules reports it loudly
    }
  }
  return out;
}

/**
 * Is every argument in this segment confined to `cwd` — i.e. is the segment's
 * whole blast radius inside the working directory?
 *
 * This is the question that makes cwd usable for exemptions at all. The obvious
 * approach — resolve each argument against cwd and exempt if ANY resolved form
 * matches — is wrong in a way that is easy to miss and expensive to ship: the
 * command word itself is an argument token, so `rm` resolves to `<cwd>/rm`,
 * which matches a `^/private/tmp/` exemption and clears the rule no matter what
 * the real target was. From a scratch cwd that would have exempted
 * `rm -rf /Users/you/project`. Asking instead whether EVERY argument stays
 * inside cwd has no such hole: one absolute path, one `~`, one `..` that climbs
 * out, and the answer is no.
 *
 * An unexpanded `$VAR` or backtick means we cannot know where the argument
 * points, so it counts as unconfined — the guard fires rather than guesses.
 */
function segmentConfinedTo(args: string[], cwd: string): boolean {
  const base = path.resolve(cwd);
  const prefix = base.endsWith(path.sep) ? base : base + path.sep;
  for (const arg of args) {
    if (!arg || arg.startsWith("-")) continue; // a flag, not a path
    if (/[$`]/.test(arg)) return false; // unexpanded expansion — destination unknown
    if (arg.startsWith("~") || path.isAbsolute(arg)) return false; // points outside by construction
    let resolved: string;
    try {
      resolved = path.resolve(base, arg);
    } catch {
      return false;
    }
    if (resolved !== base && !resolved.startsWith(prefix)) return false; // climbed out via ..
  }
  return true;
}

/** Returns the first matching guard rule for a tool call, or null.
 *
 *  `cwd` is the session's working directory (Claude Code sends it on every hook
 *  payload). It is used ONLY to resolve relative arguments while testing
 *  exemptions — never to decide a match. Omitting it is always the safer
 *  direction: fewer exemptions apply, so the guard fires more, not less. */
export function checkGuards(
  guards: GuardsFile,
  toolName: string,
  toolInput: unknown,
  cwd?: string,
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
      const exempt = compileExcept(rule, (p) => new RegExp(p, "i"));
      // A `cd` anywhere in the command means the hook's cwd is no longer where
      // a later relative argument actually points (`cd / && rm -rf home`), so
      // relative resolution is dropped for the whole command rather than
      // guessed at. Dropping it can only make the guard fire more.
      const relBase = cwd && !/(?:^|[\s;&|(])cd\s/.test(command) ? cwd : undefined;
      // Evaluate segment by segment so an exemption can clear ONE command
      // without clearing its neighbours. With no `except` the behaviour is
      // identical to matching the whole command: a pattern that matched the
      // full string matches the segment it lives in.
      for (const segment of splitCommandSegments(command)) {
        const stripped = stripQuoted(segment);
        if (!re.test(stripped)) continue;
        // Exemptions are matched per ARGUMENT (see tokenizeArgs), so an
        // exemption clears a rule only when some argument really is the
        // exempted thing — not merely when the word appears somewhere in the
        // command text. Bounded further by rm-catastrophic carrying no
        // exemptions at all: nothing can wave through `rm -rf /`.
        if (exempt.length > 0) {
          const args = tokenizeArgs(segment);
          // An argument that IS the exempted thing, as written.
          if (args.some((arg) => exempt.some((ex) => ex.test(arg)))) continue;
          // Or: the session is sitting in exempted space and this segment never
          // reaches outside it, which is how the same deletion looks when the
          // agent has already cd'd there (`rm -rf home` in a scratchpad).
          if (relBase && exempt.some((ex) => ex.test(relBase)) && segmentConfinedTo(args, relBase)) {
            continue;
          }
        }
        return { rule };
      }
    } else if (rule.type === "path") {
      const paths = pathsFromInput(input);
      if (paths.length === 0) continue;
      let re: RegExp;
      try {
        re = globToRegExp(rule.pattern);
      } catch {
        continue;
      }
      const exempt = compileExcept(rule, globToRegExp);
      for (const p of paths) {
        // Match against the path and every segment-aligned suffix, so a rule
        // like `infra/**` catches absolute paths and works on Windows too.
        if (!matchesPathGlob(re, p)) continue;
        if (exempt.some((ex) => matchesPathGlob(ex, p))) continue;
        return { rule };
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
      if (!re.test(toolName)) continue;
      const exempt = compileExcept(rule, globToRegExp);
      if (exempt.some((ex) => ex.test(toolName))) continue;
      return { rule };
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

    if (rule.except !== undefined) {
      if (!Array.isArray(rule.except)) {
        problems.push({
          ruleId,
          severity: "error",
          message: "except must be an array of patterns",
        });
      } else {
        const compile = rule.type === "bash" ? (p: string) => new RegExp(p) : globToRegExp;
        for (const p of rule.except) {
          if (typeof p !== "string") {
            problems.push({ ruleId, severity: "error", message: "except entries must be strings" });
            continue;
          }
          try {
            compile(p);
          } catch (e) {
            // A dead exemption is a rule that fires MORE than intended, not
            // less — the safe direction, but still not what was written.
            problems.push({
              ruleId,
              severity: "error",
              message: `invalid except pattern "${p}": ${(e as Error).message} — ignored, so the rule may over-fire`,
            });
          }
          if (TRIVIAL_PATTERNS.has(p.trim())) {
            problems.push({
              ruleId,
              severity: "warning",
              message: `except "${p}" matches everything — this rule can never fire`,
            });
          }
        }
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
