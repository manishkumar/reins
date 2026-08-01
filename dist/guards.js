"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_RULES = exports.POLICY_VERSION = void 0;
exports.policySource = policySource;
exports.loadGuards = loadGuards;
exports.saveGuards = saveGuards;
exports.globToRegExp = globToRegExp;
exports.matchesPathGlob = matchesPathGlob;
exports.isExpired = isExpired;
exports.stripQuoted = stripQuoted;
exports.splitCommandSegments = splitCommandSegments;
exports.tokenizeArgs = tokenizeArgs;
exports.checkGuards = checkGuards;
exports.validateRules = validateRules;
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const paths_1 = require("./paths");
/** Bump whenever DEFAULT_RULES changes in a way existing installs should get.
 *
 *  Before this existed there was no delivery path for a rule fix: a repo
 *  initialized in June was still running June's rules in late July, including
 *  a `rm -fr?` pattern that blocked plain `rm -f one-file.txt`. The fix had
 *  shipped weeks earlier and reached nobody. Shipping a rule change without
 *  bumping this is the same bug again. */
exports.POLICY_VERSION = 2;
// A small, sane default denylist. Hard vetoes only — things almost no run
// legitimately needs and that are expensive/irreversible when wrong.
// Fully overridable: `reins guard remove <id>` or edit .reins/guards.json.
exports.DEFAULT_RULES = [
    {
        // Recursive rm aimed at a target you cannot rebuild: the filesystem root,
        // your home directory, a top-level system directory, or the parent of the
        // project. Deliberately listed BEFORE rm-rf and deliberately has no
        // `except` — first match wins, so `rm -rf .next && rm -rf /` is caught here
        // no matter how generous the exemption list below gets.
        id: "rm-catastrophic",
        type: "bash",
        pattern: "\\brm\\b[^\\n]*?\\s(?:-[a-z]*r[a-z]*|--recursive)\\b[^\\n]*?\\s[\"']?(?:" +
            "/(?:\\*|\\s|$)" + // `rm -rf /`, `rm -rf /*`
            "|~(?:/(?:\\*|\\s|$)|\\s|$)" + // `rm -rf ~`, `~/`, `~/*`
            "|\\$\\{?HOME\\}?" + // `rm -rf $HOME`
            "|\\.\\.(?:/(?:\\*|\\s|$)|\\s|$)" + // `rm -rf ..`
            "|/(?:etc|usr|var|bin|sbin|lib|opt|boot|dev|proc|sys|System|Library|Applications|Users|home)/?(?:\\s|$)" +
            ")",
        reason: "Recursive rm targeting the filesystem root, home, or a system directory is blocked by a reins guard.",
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
function readRulesFile(file) {
    try {
        const raw = fs.readFileSync(file, "utf8");
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed.rules))
            return null;
        return parsed;
    }
    catch {
        return null;
    }
}
/** Which file is actually backing the active policy — for `reins doctor`. */
function policySource(payloadCwd) {
    if (readRulesFile((0, paths_1.policyPath)(payloadCwd)))
        return "policy.json";
    if (readRulesFile((0, paths_1.guardsPath)(payloadCwd)))
        return "guards.json";
    return "defaults";
}
function loadGuards(payloadCwd) {
    // policy.json is canonical. guards.json (pre-0.3) keeps working forever —
    // an existing install must never break just because the name changed.
    // Neither present/valid => ship the defaults so guards work out of the box.
    return (readRulesFile((0, paths_1.policyPath)(payloadCwd)) ??
        readRulesFile((0, paths_1.guardsPath)(payloadCwd)) ??
        { rules: [...exports.DEFAULT_RULES], version: exports.POLICY_VERSION });
}
function saveGuards(guards, payloadCwd) {
    (0, paths_1.ensureReinsDir)(payloadCwd);
    // Always write the canonical file. If only guards.json existed, this IS the
    // one-time migration: policy.json now exists alongside it, and guards.json
    // is left in place untouched — it's the user's file, never delete it out
    // from under them.
    // Stamp the generation on every write so a file created today can be told
    // apart from one created before a rule fix shipped. A file with no version
    // is treated as pre-0.4 and upgraded by matching rule ids instead.
    const out = { ...guards, version: guards.version ?? exports.POLICY_VERSION };
    fs.writeFileSync((0, paths_1.policyPath)(payloadCwd), JSON.stringify(out, null, 2) + "\n");
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
function globToRegExp(glob) {
    let re = "";
    for (let i = 0; i < glob.length; i++) {
        const c = glob[i];
        if (c === "*") {
            if (glob[i + 1] === "*") {
                i++; // consume the second '*'
                if (glob[i + 1] === "/") {
                    re += "(?:.*/)?"; // **/ => zero or more whole leading segments
                    i++;
                }
                else {
                    re += ".*"; // trailing ** (or **suffix) crosses separators
                }
            }
            else {
                re += "[^/]*";
            }
        }
        else if (c === "?") {
            re += "[^/]";
        }
        else {
            re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
        }
    }
    return new RegExp("^" + re + "$");
}
/** Normalize a path for matching: Windows backslashes -> forward slashes. */
function normalizePath(p) {
    return p.replace(/\\/g, "/");
}
/** Segment-aligned suffixes of a path: "a/b/c" -> ["a/b/c","b/c","c"]. */
function pathSuffixes(p) {
    const out = [p];
    for (let i = 0; i < p.length; i++) {
        if (p[i] === "/" && i + 1 < p.length)
            out.push(p.slice(i + 1));
    }
    return out;
}
/** True if a path glob matches the (normalized) path or any of its suffixes. */
function matchesPathGlob(re, rawPath) {
    const norm = normalizePath(rawPath);
    return pathSuffixes(norm).some((s) => re.test(s));
}
/** Collect file-path-like fields from a tool input. */
function pathsFromInput(input) {
    const keys = ["file_path", "path", "notebook_path"];
    const out = [];
    for (const k of keys) {
        if (typeof input[k] === "string")
            out.push(input[k]);
    }
    return out;
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
function isExpired(rule, now = new Date()) {
    if (!rule.expires)
        return false;
    const t = Date.parse(rule.expires);
    if (Number.isNaN(t))
        return false; // malformed => not expired (fail-open toward still guarding)
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
function stripQuoted(cmd) {
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
function splitCommandSegments(cmd) {
    const segments = [];
    let current = "";
    let quote = null;
    for (let i = 0; i < cmd.length; i++) {
        const ch = cmd[i];
        if (quote) {
            current += ch;
            if (ch === "\\" && quote === '"' && i + 1 < cmd.length) {
                current += cmd[++i]; // escaped char inside double quotes stays paired
            }
            else if (ch === quote) {
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
function tokenizeArgs(segment) {
    const tokens = [];
    let current = "";
    let started = false;
    let quote = null;
    for (let i = 0; i < segment.length; i++) {
        const ch = segment[i];
        if (quote) {
            if (ch === "\\" && quote === '"' && i + 1 < segment.length) {
                current += segment[++i];
            }
            else if (ch === quote) {
                quote = null;
            }
            else {
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
            if (started)
                tokens.push(current);
            current = "";
            started = false;
            continue;
        }
        current += ch;
        started = true;
    }
    if (started)
        tokens.push(current);
    return tokens;
}
/** Compile a rule's `except` list, skipping entries that don't compile.
 *  A malformed exemption must not silently disable the rule it belongs to —
 *  it's dropped (so the rule keeps guarding) and `reins doctor` reports it. */
function compileExcept(rule, compile) {
    if (!rule.except || rule.except.length === 0)
        return [];
    const out = [];
    for (const p of rule.except) {
        try {
            out.push(compile(p));
        }
        catch {
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
function segmentConfinedTo(args, cwd) {
    const base = path.resolve(cwd);
    const prefix = base.endsWith(path.sep) ? base : base + path.sep;
    for (const arg of args) {
        if (!arg || arg.startsWith("-"))
            continue; // a flag, not a path
        if (/[$`]/.test(arg))
            return false; // unexpanded expansion — destination unknown
        if (arg.startsWith("~") || path.isAbsolute(arg))
            return false; // points outside by construction
        let resolved;
        try {
            resolved = path.resolve(base, arg);
        }
        catch {
            return false;
        }
        if (resolved !== base && !resolved.startsWith(prefix))
            return false; // climbed out via ..
    }
    return true;
}
/** Returns the first matching guard rule for a tool call, or null.
 *
 *  `cwd` is the session's working directory (Claude Code sends it on every hook
 *  payload). It is used ONLY to resolve relative arguments while testing
 *  exemptions — never to decide a match. Omitting it is always the safer
 *  direction: fewer exemptions apply, so the guard fires more, not less. */
function checkGuards(guards, toolName, toolInput, cwd) {
    const input = (toolInput ?? {});
    for (const rule of guards.rules) {
        if (isExpired(rule))
            continue; // expired rule = absent, as if never written
        if (rule.type === "bash") {
            if (toolName !== "Bash")
                continue;
            const command = typeof input.command === "string" ? input.command : "";
            if (!command)
                continue;
            let re;
            try {
                re = new RegExp(rule.pattern, "i");
            }
            catch {
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
                if (!re.test(stripped))
                    continue;
                // Exemptions are matched per ARGUMENT (see tokenizeArgs), so an
                // exemption clears a rule only when some argument really is the
                // exempted thing — not merely when the word appears somewhere in the
                // command text. Bounded further by rm-catastrophic carrying no
                // exemptions at all: nothing can wave through `rm -rf /`.
                if (exempt.length > 0) {
                    const args = tokenizeArgs(segment);
                    // An argument that IS the exempted thing, as written.
                    if (args.some((arg) => exempt.some((ex) => ex.test(arg))))
                        continue;
                    // Or: the session is sitting in exempted space and this segment never
                    // reaches outside it, which is how the same deletion looks when the
                    // agent has already cd'd there (`rm -rf home` in a scratchpad).
                    if (relBase && exempt.some((ex) => ex.test(relBase)) && segmentConfinedTo(args, relBase)) {
                        continue;
                    }
                }
                return { rule };
            }
        }
        else if (rule.type === "path") {
            const paths = pathsFromInput(input);
            if (paths.length === 0)
                continue;
            let re;
            try {
                re = globToRegExp(rule.pattern);
            }
            catch {
                continue;
            }
            const exempt = compileExcept(rule, globToRegExp);
            for (const p of paths) {
                // Match against the path and every segment-aligned suffix, so a rule
                // like `infra/**` catches absolute paths and works on Windows too.
                if (!matchesPathGlob(re, p))
                    continue;
                if (exempt.some((ex) => matchesPathGlob(ex, p)))
                    continue;
                return { rule };
            }
        }
        else if (rule.type === "tool") {
            // NAME glob against the tool itself (e.g. `mcp__stripe__*`, `WebFetch`) —
            // where MCP tools live, and where bash/path matching can't reach them.
            // Reuses globToRegExp directly (no suffix matching): tool names have no
            // path segments, and case sensitivity here is deliberate — tool names
            // are exact identifiers, not user-typed paths.
            let re;
            try {
                re = globToRegExp(rule.pattern);
            }
            catch {
                continue;
            }
            if (!re.test(toolName))
                continue;
            const exempt = compileExcept(rule, globToRegExp);
            if (exempt.some((ex) => ex.test(toolName)))
                continue;
            return { rule };
        }
    }
    return null;
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
function validateRules(rules) {
    const problems = [];
    const seenIds = new Set();
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
        }
        else if (rule.type === "bash") {
            try {
                new RegExp(rule.pattern);
            }
            catch (e) {
                problems.push({ ruleId, severity: "error", message: `invalid regex: ${e.message}` });
            }
        }
        else {
            try {
                globToRegExp(rule.pattern);
            }
            catch (e) {
                problems.push({ ruleId, severity: "error", message: `invalid glob: ${e.message}` });
            }
        }
        if (rule.action !== undefined &&
            rule.action !== "deny" &&
            rule.action !== "ask" &&
            rule.action !== "hold") {
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
            }
            else if (isExpired(rule)) {
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
            }
            else {
                const compile = rule.type === "bash" ? (p) => new RegExp(p) : globToRegExp;
                for (const p of rule.except) {
                    if (typeof p !== "string") {
                        problems.push({ ruleId, severity: "error", message: "except entries must be strings" });
                        continue;
                    }
                    try {
                        compile(p);
                    }
                    catch (e) {
                        // A dead exemption is a rule that fires MORE than intended, not
                        // less — the safe direction, but still not what was written.
                        problems.push({
                            ruleId,
                            severity: "error",
                            message: `invalid except pattern "${p}": ${e.message} — ignored, so the rule may over-fire`,
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
