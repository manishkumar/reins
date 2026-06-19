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
exports.configPath = configPath;
exports.dbPath = dbPath;
const path = __importStar(require("node:path"));
const fs = __importStar(require("node:fs"));
/**
 * Resolve the project root reins should operate in.
 *
 * For hook invocations, Claude Code provides the session cwd in the event
 * payload and also sets $CLAUDE_PROJECT_DIR. For user-facing commands we use
 * the shell's cwd. Explicit payload cwd wins so the .reins dir always tracks
 * the project the agent is actually running in.
 */
function resolveProjectDir(payloadCwd) {
    if (payloadCwd && payloadCwd.trim())
        return payloadCwd;
    if (process.env.CLAUDE_PROJECT_DIR && process.env.CLAUDE_PROJECT_DIR.trim()) {
        return process.env.CLAUDE_PROJECT_DIR;
    }
    // User-facing commands: find the project by walking up to an existing .reins,
    // so `reins steer` works from any subdirectory instead of silently writing a
    // stray .reins/ that the agent (rooted at the project dir) never reads.
    return findProjectDir(process.cwd());
}
/**
 * Walk up from `start` to the first ancestor containing a `.reins/` directory.
 * Falls back to `start` if none is found (e.g. a not-yet-initialized project).
 */
function findProjectDir(start) {
    let dir = path.resolve(start);
    // eslint-disable-next-line no-constant-condition
    while (true) {
        if (fs.existsSync(path.join(dir, ".reins")))
            return dir;
        const parent = path.dirname(dir);
        if (parent === dir)
            return path.resolve(start); // reached filesystem root
        dir = parent;
    }
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
function configPath(payloadCwd) {
    return path.join(reinsDir(payloadCwd), "config.json");
}
function dbPath(payloadCwd) {
    return path.join(reinsDir(payloadCwd), "runs.db");
}
