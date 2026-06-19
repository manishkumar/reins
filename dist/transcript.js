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
exports.readTranscriptTotals = readTranscriptTotals;
const fs = __importStar(require("node:fs"));
/**
 * Best-effort token/cost extraction from a session transcript (JSONL).
 *
 * The hook payload does not carry per-call cost cleanly, so we read the
 * transcript Claude Code references via transcript_path. Format varies across
 * versions, so this is intentionally defensive: any failure yields nulls (a
 * null column is harmless), never an exception that could disrupt the Stop hook.
 */
function readTranscriptTotals(transcriptPath) {
    const none = { totalTokens: null, totalCost: null };
    if (!transcriptPath)
        return none;
    let text;
    try {
        text = fs.readFileSync(transcriptPath, "utf8");
    }
    catch {
        return none;
    }
    let tokens = 0;
    let sawTokens = false;
    let cost = 0;
    let sawCost = false;
    for (const line of text.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed)
            continue;
        let obj;
        try {
            obj = JSON.parse(trimmed);
        }
        catch {
            continue;
        }
        // Cost, if the transcript records it per-line.
        const costVal = numericField(obj, "costUSD") ?? numericField(obj, "cost");
        if (costVal !== null) {
            cost += costVal;
            sawCost = true;
        }
        // Usage block lives on assistant messages.
        const message = obj.message;
        const usage = message?.usage ??
            obj.usage;
        if (usage) {
            const u = sumUsage(usage);
            if (u !== null) {
                tokens += u;
                sawTokens = true;
            }
        }
    }
    return {
        totalTokens: sawTokens ? tokens : null,
        totalCost: sawCost ? Math.round(cost * 1e6) / 1e6 : null,
    };
}
function numericField(obj, key) {
    const v = obj[key];
    return typeof v === "number" && isFinite(v) ? v : null;
}
function sumUsage(usage) {
    const keys = [
        "input_tokens",
        "output_tokens",
        "cache_creation_input_tokens",
        "cache_read_input_tokens",
    ];
    let total = 0;
    let saw = false;
    for (const k of keys) {
        const v = usage[k];
        if (typeof v === "number" && isFinite(v)) {
            total += v;
            saw = true;
        }
    }
    return saw ? total : null;
}
