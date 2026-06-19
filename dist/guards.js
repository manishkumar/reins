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
exports.loadGuards = loadGuards;
exports.saveGuards = saveGuards;
exports.globToRegExp = globToRegExp;
exports.matchesPathGlob = matchesPathGlob;
exports.stripQuoted = stripQuoted;
exports.checkGuards = checkGuards;
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
function loadGuards(payloadCwd) {
    try {
        const raw = fs.readFileSync((0, paths_1.guardsPath)(payloadCwd), "utf8");
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed.rules))
            return { rules: [...exports.DEFAULT_RULES] };
        return parsed;
    }
    catch {
        // No file yet => ship the defaults so guards work out of the box.
        return { rules: [...exports.DEFAULT_RULES] };
    }
}
function saveGuards(guards, payloadCwd) {
    (0, paths_1.ensureReinsDir)(payloadCwd);
    fs.writeFileSync((0, paths_1.guardsPath)(payloadCwd), JSON.stringify(guards, null, 2) + "\n");
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
    }
    return null;
}
