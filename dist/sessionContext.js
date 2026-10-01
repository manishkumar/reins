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
exports.NO_CONTEXT = void 0;
exports.readSessionContext = readSessionContext;
exports.parseTail = parseTail;
const fs = __importStar(require("node:fs"));
exports.NO_CONTEXT = { title: null, asked: null, branch: null };
/** Title, prompt and branch lines repeat every turn, so the tail is enough. */
const TAIL_BYTES = 256 * 1024;
/** Metadata lines are short. Longer lines are messages and are never parsed. */
const MAX_META_LINE = 64 * 1024;
const BRANCH_RE = /"gitBranch":"((?:[^"\\]|\\.)*)"/;
const cache = new Map();
function readSessionContext(transcriptPath) {
    if (!transcriptPath || !transcriptPath.endsWith(".jsonl"))
        return exports.NO_CONTEXT;
    try {
        const stat = fs.statSync(transcriptPath);
        if (!stat.isFile())
            return exports.NO_CONTEXT;
        const hit = cache.get(transcriptPath);
        if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size)
            return hit.ctx;
        const ctx = parseTail(readTail(transcriptPath, stat.size));
        cache.set(transcriptPath, { mtimeMs: stat.mtimeMs, size: stat.size, ctx });
        return ctx;
    }
    catch {
        return exports.NO_CONTEXT;
    }
}
function readTail(file, size) {
    const len = Math.min(size, TAIL_BYTES);
    const buf = Buffer.alloc(len);
    const fd = fs.openSync(file, "r");
    try {
        fs.readSync(fd, buf, 0, len, size - len);
    }
    finally {
        fs.closeSync(fd);
    }
    const text = buf.toString("utf8");
    // A tail that starts mid-file starts mid-line; drop the partial one.
    return len < size ? text.slice(text.indexOf("\n") + 1) : text;
}
/** Exported for tests. Later lines win, so the newest title and prompt are kept. */
function parseTail(text) {
    let custom = null;
    let ai = null;
    let asked = null;
    let branch = null;
    for (const line of text.split("\n")) {
        if (!line)
            continue;
        const b = BRANCH_RE.exec(line);
        if (b)
            branch = unescape(b[1]) ?? branch;
        if (line.length > MAX_META_LINE)
            continue;
        if (!line.includes('"custom-title"') && !line.includes('"ai-title"') && !line.includes('"last-prompt"'))
            continue;
        let obj;
        try {
            obj = JSON.parse(line);
        }
        catch {
            continue;
        }
        // Checked on the parsed top level, so a tool result that quotes one of
        // these lines is not mistaken for one.
        if (obj.type === "custom-title")
            custom = text1(obj.customTitle) ?? custom;
        else if (obj.type === "ai-title")
            ai = text1(obj.aiTitle) ?? ai;
        else if (obj.type === "last-prompt")
            asked = text1(obj.lastPrompt) ?? asked;
    }
    return { title: custom ?? ai, asked, branch };
}
function text1(v) {
    if (typeof v !== "string")
        return null;
    const t = v.replace(/\s+/g, " ").trim();
    return t || null;
}
function unescape(raw) {
    try {
        return text1(JSON.parse(`"${raw}"`));
    }
    catch {
        return null;
    }
}
