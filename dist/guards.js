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
exports.DEFAULT_RULES = void 0;
exports.policySource = policySource;
exports.loadGuards = loadGuards;
exports.saveGuards = saveGuards;
exports.globToRegExp = globToRegExp;
exports.matchesPathGlob = matchesPathGlob;
exports.isExpired = isExpired;
exports.stripQuoted = stripQuoted;
exports.checkGuards = checkGuards;
exports.validateRules = validateRules;
const fs = __importStar(require("node:fs"));
const paths_1 = require("./paths");
// A small, sane default denylist. Hard vetoes only — things almost no run
// legitimately needs and that are expensive/irreversible when wrong.
// Fully overridable: `reins guard remove <id>` or edit .reins/guards.json.
exports.DEFAULT_RULES = [
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
        { rules: [...exports.DEFAULT_RULES] });
}
function saveGuards(guards, payloadCwd) {
    (0, paths_1.ensureReinsDir)(payloadCwd);
    // Always write the canonical file. If only guards.json existed, this IS the
    // one-time migration: policy.json now exists alongside it, and guards.json
    // is left in place untouched — it's the user's file, never delete it out
    // from under them.
    fs.writeFileSync((0, paths_1.policyPath)(payloadCwd), JSON.stringify(guards, null, 2) + "\n");
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
/** Returns the first matching guard rule for a tool call, or null. */
function checkGuards(guards, toolName, toolInput) {
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
            if (re.test(stripQuoted(command)))
                return { rule };
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
            for (const p of paths) {
                // Match against the path and every segment-aligned suffix, so a rule
                // like `infra/**` catches absolute paths and works on Windows too.
                if (matchesPathGlob(re, p))
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
            if (re.test(toolName))
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
