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
exports.steeringFileFor = steeringFileFor;
exports.writeSteering = writeSteering;
exports.appendSteering = appendSteering;
exports.peekSteering = peekSteering;
exports.clearSteering = clearSteering;
exports.pendingTargetedSessions = pendingTargetedSessions;
exports.consumeSteering = consumeSteering;
exports.formatSteeringContext = formatSteeringContext;
exports.formatSteeringStopReason = formatSteeringStopReason;
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const paths_1 = require("./paths");
/**
 * Steering can be a broadcast (global) or targeted at one session. With several
 * agents in one repo, a global nudge lands on whichever session hits the next
 * tool boundary first; targeting one writes a per-session file the hook prefers.
 *
 *   global   -> .reins/steering.txt
 *   targeted -> .reins/steering.<sessionId>.txt
 */
function steeringFileFor(payloadCwd, sessionId) {
    if (!sessionId)
        return (0, paths_1.steeringPath)(payloadCwd);
    return path.join((0, paths_1.reinsDir)(payloadCwd), `steering.${sanitize(sessionId)}.txt`);
}
function sanitize(id) {
    return id.replace(/[^a-zA-Z0-9_.-]/g, "_");
}
/** Queue a steering message for the next tool boundary, replacing any pending. */
function writeSteering(message, payloadCwd, sessionId) {
    (0, paths_1.ensureReinsDir)(payloadCwd);
    fs.writeFileSync(steeringFileFor(payloadCwd, sessionId), message.trim() + "\n");
}
/**
 * Append a nudge to any pending steering instead of clobbering it. Two quick
 * `reins steer` calls before the next tool boundary should both reach the
 * agent, not silently drop the first. Returns the number of nudges now queued.
 */
function appendSteering(message, payloadCwd, sessionId) {
    const existing = peekSteering(payloadCwd, sessionId);
    if (!existing) {
        writeSteering(message, payloadCwd, sessionId);
        return 1;
    }
    const combined = existing + "\n" + message.trim();
    fs.writeFileSync(steeringFileFor(payloadCwd, sessionId), combined + "\n");
    return combined.split("\n").filter((l) => l.trim()).length;
}
/** Return the pending steering message without consuming it (for `reins steer`). */
function peekSteering(payloadCwd, sessionId) {
    try {
        const s = fs.readFileSync(steeringFileFor(payloadCwd, sessionId), "utf8").trim();
        return s ? s : null;
    }
    catch {
        return null;
    }
}
function clearSteering(payloadCwd, sessionId) {
    try {
        fs.rmSync(steeringFileFor(payloadCwd, sessionId));
    }
    catch {
        /* nothing to clear */
    }
}
/** List all session ids that currently have targeted steering pending. */
function pendingTargetedSessions(payloadCwd) {
    try {
        return fs
            .readdirSync((0, paths_1.reinsDir)(payloadCwd))
            .map((f) => /^steering\.(.+)\.txt$/.exec(f)?.[1])
            .filter((x) => !!x);
    }
    catch {
        return [];
    }
}
/**
 * Atomically read AND clear the pending steering for this tool boundary.
 * A session-targeted nudge (matching this session_id) is preferred; otherwise
 * the global broadcast is consumed. Renaming first means a concurrent `steer`
 * write can't be silently dropped between read and delete.
 */
function consumeSteering(payloadCwd, sessionId) {
    if (sessionId) {
        const targeted = consumeFile(steeringFileFor(payloadCwd, sessionId));
        if (targeted)
            return targeted;
    }
    return consumeFile((0, paths_1.steeringPath)(payloadCwd));
}
function consumeFile(p) {
    const tmp = p + ".consuming." + process.pid;
    try {
        fs.renameSync(p, tmp);
    }
    catch {
        return null; // not present
    }
    try {
        const s = fs.readFileSync(tmp, "utf8").trim();
        return s ? s : null;
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
 * The exact text injected as PreToolUse additionalContext.
 *
 * Framing is load-bearing (verified in the build spike): the model weighs
 * hook-injected context against the user's original prompt and resists anything
 * that reads like a hijack ("STOP, ignore previous"). Steering is the detail
 * the same author forgot to put in the original prompt — additive spec that
 * composes with the goal, never an order that overrides it. Phrase it that way.
 */
function formatSteeringContext(message) {
    return ("[reins — live steering from the developer running this session]\n" +
        message +
        "\n\nTreat this as additional detail for the task in progress, from the same " +
        "person who wrote the original request — spec they want folded into the " +
        "current work. It refines the goal; it does not replace it.");
}
/**
 * The Stop-hook variant: steering that arrived after the agent's last tool
 * boundary is delivered by blocking the stop (this text is the block reason).
 * Same author-framing as above, plus explicit instruction on what "continue"
 * means here — address the note, then finish; don't restart the task.
 */
function formatSteeringStopReason(message) {
    return ("[reins — steering from the developer, delivered as you were finishing]\n" +
        message +
        "\n\nThis note was queued before you stopped and would otherwise have been " +
        "lost. It is additional detail from the same person who wrote the original " +
        "request. Address it — adjusting or extending the work you just did as " +
        "needed — and then finish. It refines the goal; it does not replace it.");
}
