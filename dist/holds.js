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
exports.parkAction = parkAction;
exports.listPending = listPending;
exports.pendingForSession = pendingForSession;
exports.findPending = findPending;
exports.removePending = removePending;
exports.writeAllowance = writeAllowance;
exports.consumeAllowance = consumeAllowance;
exports.formatHoldReason = formatHoldReason;
const crypto = __importStar(require("node:crypto"));
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const paths_1 = require("./paths");
function pendingDir(payloadCwd) {
    return path.join((0, paths_1.reinsDir)(payloadCwd), "pending");
}
function allowedDir(payloadCwd) {
    return path.join((0, paths_1.reinsDir)(payloadCwd), "allowed");
}
/** 0700 like .reins itself: a pending action's input can contain secrets. */
function ensureDir(dir, payloadCwd) {
    (0, paths_1.ensureReinsDir)(payloadCwd);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}
/**
 * Park a proposed action. If this session already has the identical proposal
 * parked (same input hash), return the existing entry instead of duplicating —
 * an agent retrying a held call is asking about the same decision, not filing
 * a new one.
 */
function parkAction(payloadCwd, action) {
    const existing = listPending(payloadCwd).find((p) => p.session_id === action.session_id && p.input_hash === action.input_hash);
    if (existing)
        return { id: existing.id, existed: true };
    const id = crypto.randomBytes(4).toString("hex");
    ensureDir(pendingDir(payloadCwd), payloadCwd);
    fs.writeFileSync(path.join(pendingDir(payloadCwd), id + ".json"), JSON.stringify({ id, ...action }, null, 2) + "\n");
    return { id, existed: false };
}
/** All parked actions, oldest first (the queue order a reviewer works in). */
function listPending(payloadCwd) {
    let files;
    try {
        files = fs.readdirSync(pendingDir(payloadCwd)).filter((f) => f.endsWith(".json"));
    }
    catch {
        return [];
    }
    const out = [];
    for (const f of files) {
        try {
            const parsed = JSON.parse(fs.readFileSync(path.join(pendingDir(payloadCwd), f), "utf8"));
            if (parsed && parsed.id && parsed.input_hash)
                out.push(parsed);
        }
        catch {
            /* skip unreadable/corrupt entries rather than break the queue */
        }
    }
    return out.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
}
/** Parked actions belonging to one session (for lastrun/sessions/stop). */
function pendingForSession(payloadCwd, sessionId) {
    return listPending(payloadCwd).filter((p) => p.session_id === sessionId);
}
/**
 * Resolve an id or unique prefix to parked actions. Returns every match so the
 * caller can tell "not found" (0) from "ambiguous" (>1) and say so.
 */
function findPending(payloadCwd, idPrefix) {
    return listPending(payloadCwd).filter((p) => p.id.startsWith(idPrefix));
}
function removePending(payloadCwd, id) {
    try {
        fs.rmSync(path.join(pendingDir(payloadCwd), id + ".json"));
    }
    catch {
        /* already gone */
    }
}
/** Write the one-shot allowance for a parked action (the "approve" half). */
function writeAllowance(payloadCwd, action) {
    ensureDir(allowedDir(payloadCwd), payloadCwd);
    const allowance = {
        action_id: action.id,
        session_id: action.session_id,
        tool: action.tool,
        input_hash: action.input_hash,
        rule_id: action.rule_id,
        approved_ts: new Date().toISOString(),
    };
    fs.writeFileSync(path.join(allowedDir(payloadCwd), action.input_hash + ".json"), JSON.stringify(allowance, null, 2) + "\n");
}
/**
 * Atomically consume the allowance for this exact input hash, if one exists.
 * Rename-first (same trick as steering) so two agents racing on the identical
 * call can't both spend a one-shot approval.
 */
function consumeAllowance(payloadCwd, inputHash) {
    const p = path.join(allowedDir(payloadCwd), inputHash + ".json");
    const tmp = p + ".consuming." + process.pid;
    try {
        fs.renameSync(p, tmp);
    }
    catch {
        return null; // no allowance for this hash
    }
    try {
        return JSON.parse(fs.readFileSync(tmp, "utf8"));
    }
    catch {
        return null;
    }
    finally {
        try {
            fs.rmSync(tmp);
        }
        catch {
            /* ignore */
        }
    }
}
/**
 * The deny reason the agent sees when its action is parked. Load-bearing
 * framing, like the steering text: it must (a) carry the human-set rule reason,
 * (b) hand over the id so the run's report mentions it, and (c) redirect the
 * agent to other work instead of leaving it to die against a wall or hammer
 * the same call.
 */
function formatHoldReason(id, ruleReason) {
    return (ruleReason +
        ` [reins hold] This action is parked for approval (id ${id}) — it will not run ` +
        `until the developer approves it (\`reins approve ${id}\`). Do not retry it now: ` +
        `continue with work that does not depend on it, and mention the parked action ` +
        `(with its id) when you report back. If nothing else remains, finish and note it.`);
}
