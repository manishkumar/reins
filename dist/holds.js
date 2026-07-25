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
exports.writeDecision = writeDecision;
exports.consumeDecision = consumeDecision;
exports.formatHoldReason = formatHoldReason;
exports.formatDeferReason = formatDeferReason;
exports.formatRefusalReason = formatRefusalReason;
const crypto = __importStar(require("node:crypto"));
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const paths_1 = require("./paths");
function pendingDir(payloadCwd) {
    return path.join((0, paths_1.reinsDir)(payloadCwd), "pending");
}
/** Decisions awaiting collection by the agent's next attempt (approved AND
 *  refused). Named "decided", not "allowed", because a refusal is a decision
 *  the boundary must also honor exactly once. */
function decidedDir(payloadCwd) {
    return path.join((0, paths_1.reinsDir)(payloadCwd), "decided");
}
/** Pre-0.4 one-shot approvals: .reins/allowed/<input_hash>.json. Still read, so
 *  upgrading reins mid-run never strands an approval the human already gave. */
function legacyAllowedDir(payloadCwd) {
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
    const existing = listPending(payloadCwd).find((p) => p.session_id === action.session_id &&
        // A replayed deferred call is literally the same call, id and all. Any
        // other retry is recognized by its form.
        (action.tool_use_id && p.tool_use_id
            ? p.tool_use_id === action.tool_use_id
            : p.input_hash === action.input_hash));
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
/**
 * The key a decision is filed under — and the whole reason defer is better than
 * deny. A deferred call comes back with the SAME tool_use_id, so its approval
 * is keyed to that one call and nothing else can spend it. A denied-and-retried
 * call gets a fresh tool_use_id, so it can only be recognized by its form: the
 * exact input hash, scoped to the session that proposed it (an unscoped hash
 * key let a second session consume the first's approval).
 */
function decisionKey(d) {
    if (d.transport === "defer" && d.tool_use_id)
        return "u-" + d.tool_use_id;
    return "h-" + shortHash(d.session_id) + "-" + d.input_hash;
}
function shortHash(s) {
    return crypto.createHash("sha256").update(s).digest("hex").slice(0, 8);
}
/** Record a human's answer for the agent to collect at the boundary. */
function writeDecision(payloadCwd, action, resolution, steer) {
    ensureDir(decidedDir(payloadCwd), payloadCwd);
    const decision = {
        action_id: action.id,
        session_id: action.session_id,
        tool: action.tool,
        input_hash: action.input_hash,
        tool_use_id: action.tool_use_id,
        transport: action.transport,
        rule_id: action.rule_id,
        resolution,
        ...(steer ? { steer } : {}),
        decided_ts: new Date().toISOString(),
    };
    fs.writeFileSync(path.join(decidedDir(payloadCwd), decisionKey(action) + ".json"), JSON.stringify(decision, null, 2) + "\n");
}
/**
 * Atomically consume the decision for this attempt, if a human left one.
 * Rename-first (the same trick as steering) so two agents racing on the
 * identical call can't both spend a one-shot answer.
 *
 * Tried in order: this exact deferred call (tool_use_id), then this session's
 * identical proposal (hash), then a pre-0.4 unscoped allowance. First match
 * wins and is consumed.
 */
function consumeDecision(payloadCwd, attempt) {
    const candidates = [];
    if (attempt.tool_use_id) {
        candidates.push(path.join(decidedDir(payloadCwd), "u-" + attempt.tool_use_id + ".json"));
    }
    candidates.push(path.join(decidedDir(payloadCwd), "h-" + shortHash(attempt.session_id) + "-" + attempt.input_hash + ".json"));
    for (const p of candidates) {
        const taken = takeJson(p);
        if (taken)
            return taken;
    }
    // Legacy: a one-shot approval written by reins < 0.4, keyed by bare hash.
    const legacy = takeJson(path.join(legacyAllowedDir(payloadCwd), attempt.input_hash + ".json"));
    if (legacy) {
        return {
            action_id: legacy.action_id,
            session_id: legacy.session_id,
            tool: legacy.tool,
            input_hash: attempt.input_hash,
            transport: "deny",
            rule_id: legacy.rule_id,
            resolution: "approved",
            decided_ts: new Date().toISOString(),
        };
    }
    return null;
}
/** Consume one JSON file atomically: rename out of the way, then read. */
function takeJson(p) {
    const tmp = p + ".consuming." + process.pid;
    try {
        fs.renameSync(p, tmp);
    }
    catch {
        return null; // nothing filed here
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
/**
 * The reason attached to a deferred hold. Unlike the deny reason above, this is
 * not a redirection: on defer the turn ends with the call still pending, so
 * there is no agent left mid-run to send elsewhere. It is written for the human
 * reading `reins pending` and the transcript afterwards.
 */
function formatDeferReason(id, ruleReason) {
    return (ruleReason +
        ` [reins hold] Parked for approval (id ${id}). The tool call is preserved as-is; ` +
        `\`reins approve ${id}\` then resuming the session runs this exact call.`);
}
/**
 * What the agent is told when it comes back for an action a human refused. It
 * carries the refusal (so the model stops proposing it) plus any alternative
 * the human supplied — this is the gate's reply channel, delivered at the
 * boundary rather than left to a steer that may never be consumed.
 */
function formatRefusalReason(id, ruleReason, steer) {
    return (ruleReason +
        ` [reins hold] The developer refused this action (id ${id}); do not propose it again.` +
        (steer ? ` Instead: ${steer}` : ""));
}
