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
exports.resolveProjectDir = resolveProjectDir;
exports.findProjectDir = findProjectDir;
exports.reinsDir = reinsDir;
exports.ensureReinsDir = ensureReinsDir;
exports.steeringPath = steeringPath;
exports.guardsPath = guardsPath;
exports.policyPath = policyPath;
exports.configPath = configPath;
exports.dbPath = dbPath;
const path = __importStar(require("node:path"));
const fs = __importStar(require("node:fs"));
/**
 * Resolve the project root reins should operate in.
 *
 * The event `cwd` Claude Code sends is the working directory of the TOOL CALL,
 * not the project root — the Bash tool keeps a persistent shell cwd, so one
 * `cd packages/api` and every later event carries the subdirectory. Taking it
 * verbatim meant the hooks looked for `.reins/` there, found none, and treated
 * a configured project as an uninitialized one: the user's own rules silently
 * stopped applying (the built-in defaults still shipped, so nothing looked
 * broken), steering wasn't delivered at that boundary, filed approvals weren't
 * seen, and capture created a second .reins/ in the subdirectory. Silent,
 * because "no .reins" is indistinguishable from "not set up" by design.
 *
 * So the payload cwd is a starting point to walk up from, exactly as the
 * shell's cwd already was for user-facing commands.
 */
function resolveProjectDir(payloadCwd) {
    const projectDir = process.env.CLAUDE_PROJECT_DIR?.trim() || "";
    if (payloadCwd && payloadCwd.trim()) {
        // Bounded by the session root when Claude Code tells us one. Without a
        // bound, a project that was never `reins init`-ed would climb PAST itself
        // into any ancestor that happens to have a .reins (a stray ~/.reins from
        // an experiment) and start writing state there — trading a bug that loses
        // your rules for one that files them somewhere you'll never look.
        return findProjectDir(payloadCwd, projectDir || undefined);
    }
    if (projectDir)
        return projectDir;
    // User-facing commands: find the project by walking up to an existing .reins,
    // so `reins steer` works from any subdirectory instead of silently writing a
    // stray .reins/ that the agent (rooted at the project dir) never reads.
    return findProjectDir(process.cwd());
}
/**
 * Walk up from `start` to the first ancestor containing a `.reins/` directory.
 * Falls back to `start` if none is found (e.g. a not-yet-initialized project).
 *
 * `stopAt`, when given, is the highest directory the walk may consider — it
 * is checked, and nothing above it is. A `stopAt` that isn't an ancestor of
 * `start` is ignored rather than obeyed, since a bound that doesn't contain
 * the starting point can't describe the same project.
 *
 * Runs in the hook path on every tool call, so it never throws: an unreadable
 * directory mid-walk falls back to `start` rather than taking down the host
 * run (a hook must always fail open).
 */
function findProjectDir(start, stopAt) {
    const from = path.resolve(start);
    try {
        const bound = stopAt ? path.resolve(stopAt) : undefined;
        const bounded = bound !== undefined && isWithin(bound, from);
        let dir = from;
        // eslint-disable-next-line no-constant-condition
        while (true) {
            if (fs.existsSync(path.join(dir, ".reins")))
                return dir;
            if (bounded && dir === bound)
                return from; // checked the bound; go no higher
            const parent = path.dirname(dir);
            if (parent === dir)
                return from; // reached filesystem root
            dir = parent;
        }
    }
    catch {
        return from;
    }
}
/** Is `child` the same directory as `parent`, or inside it? */
function isWithin(parent, child) {
    if (child === parent)
        return true;
    const rel = path.relative(parent, child);
    return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}
/** Absolute path to the project's .reins directory (not guaranteed to exist). */
function reinsDir(payloadCwd) {
    return path.join(resolveProjectDir(payloadCwd), ".reins");
}
/** Ensure .reins exists and is self-gitignored, then return its path. */
function ensureReinsDir(payloadCwd) {
    const dir = reinsDir(payloadCwd);
    // 0700: .reins holds steering (write access == steering access) and the
    // trajectory log. Owner-only by default is defense-in-depth for the threat
    // model. Mode is best-effort (ignored on Windows) and applies on creation.
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const gitignore = path.join(dir, ".gitignore");
    if (!fs.existsSync(gitignore)) {
        // The .reins dir holds local state (steering, db) that must never be
        // committed. Self-ignore so the user doesn't have to touch root .gitignore.
        fs.writeFileSync(gitignore, "# Created by reins. Local agent state — never commit.\n*\n");
    }
    return dir;
}
function steeringPath(payloadCwd) {
    return path.join(reinsDir(payloadCwd), "steering.txt");
}
function guardsPath(payloadCwd) {
    return path.join(reinsDir(payloadCwd), "guards.json");
}
/** Policy file v1: guards.json evolved into policy.json (superset schema —
 *  `expires`, `tool` rules). Canonical target for all writes. `guardsPath`
 *  above is kept around forever as the pre-0.3 fallback read path — see
 *  `loadGuards` in guards.ts. */
function policyPath(payloadCwd) {
    return path.join(reinsDir(payloadCwd), "policy.json");
}
function configPath(payloadCwd) {
    return path.join(reinsDir(payloadCwd), "config.json");
}
function dbPath(payloadCwd) {
    return path.join(reinsDir(payloadCwd), "runs.db");
}
