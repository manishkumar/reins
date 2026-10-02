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
exports.parseVersion = parseVersion;
exports.claudeVersionFromEnv = claudeVersionFromEnv;
exports.readHooksSeen = readHooksSeen;
exports.markHookRan = markHookRan;
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const paths_1 = require("./paths");
// Kept here, not in claudeVersion.ts, so the hook path never loads child_process.
function parseVersion(text) {
    const m = /(\d+)\.(\d+)\.(\d+)/.exec(text);
    return m ? `${Number(m[1])}.${Number(m[2])}.${Number(m[3])}` : null;
}
const FILE = "hooks-seen.json";
const EVERY_MS = 60_000;
/** The version of the Claude Code that spawned this process, from the environment it sets. */
function claudeVersionFromEnv(env = process.env) {
    // AI_AGENT=claude-code_2-1-287_agent
    const agent = /^claude-code_(\d+)-(\d+)-(\d+)/.exec(env.AI_AGENT ?? "");
    if (agent)
        return `${Number(agent[1])}.${Number(agent[2])}.${Number(agent[3])}`;
    // CLAUDE_CODE_EXECPATH=…/claude/versions/2.1.287
    const exec = /[\\/]versions[\\/](\d+\.\d+\.\d+)(?:$|[\\/])/.exec(env.CLAUDE_CODE_EXECPATH ?? "");
    return exec ? parseVersion(exec[1]) : null;
}
function readHooksSeen(dir) {
    try {
        const seen = JSON.parse(fs.readFileSync(path.join(dir, FILE), "utf8"));
        if (!seen || typeof seen.events !== "object" || seen.events === null)
            return null;
        return { events: seen.events, claude: typeof seen.claude === "string" ? (parseVersion(seen.claude) ?? undefined) : undefined };
    }
    catch {
        return null;
    }
}
function markHookRan(event, sessionId, payloadCwd, now = new Date()) {
    if (!sessionId)
        return;
    try {
        const dir = (0, paths_1.reinsDir)(payloadCwd);
        if (!fs.existsSync(dir))
            return;
        const seen = readHooksSeen(dir) ?? { events: {} };
        const claude = claudeVersionFromEnv() ?? undefined;
        const last = Date.parse(seen.events[event] ?? "");
        if (Number.isFinite(last) && now.getTime() - last < EVERY_MS && seen.claude === claude)
            return;
        seen.events[event] = now.toISOString();
        if (claude)
            seen.claude = claude;
        else
            delete seen.claude;
        const file = path.join(dir, FILE);
        const tmp = `${file}.${process.pid}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(seen) + "\n", { mode: 0o600 });
        fs.renameSync(tmp, file);
    }
    catch {
        /* never the tool call's problem */
    }
}
