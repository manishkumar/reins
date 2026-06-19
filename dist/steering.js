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
exports.writeSteering = writeSteering;
exports.appendSteering = appendSteering;
exports.peekSteering = peekSteering;
exports.clearSteering = clearSteering;
exports.consumeSteering = consumeSteering;
exports.formatSteeringContext = formatSteeringContext;
const fs = __importStar(require("node:fs"));
const paths_1 = require("./paths");
/** Queue a steering message for the next tool boundary, replacing any pending. */
function writeSteering(message, payloadCwd) {
    (0, paths_1.ensureReinsDir)(payloadCwd);
    fs.writeFileSync((0, paths_1.steeringPath)(payloadCwd), message.trim() + "\n");
}
/**
 * Append a nudge to any pending steering instead of clobbering it. Two quick
 * `reins steer` calls before the next tool boundary should both reach the
 * agent, not silently drop the first. Returns the number of nudges now queued.
 */
function appendSteering(message, payloadCwd) {
    const existing = peekSteering(payloadCwd);
    if (!existing) {
        writeSteering(message, payloadCwd);
        return 1;
    }
    const combined = existing + "\n" + message.trim();
    fs.writeFileSync((0, paths_1.steeringPath)(payloadCwd), combined + "\n");
    return combined.split("\n").filter((l) => l.trim()).length;
}
/** Return the pending steering message without consuming it (for `reins steer`). */
function peekSteering(payloadCwd) {
    try {
        const s = fs.readFileSync((0, paths_1.steeringPath)(payloadCwd), "utf8").trim();
        return s ? s : null;
    }
    catch {
        return null;
    }
}
function clearSteering(payloadCwd) {
    try {
        fs.rmSync((0, paths_1.steeringPath)(payloadCwd));
    }
    catch {
        /* nothing to clear */
    }
}
/**
 * Atomically read AND clear the pending steering message (one-shot delivery).
 * Returns null if nothing is queued. Renaming first means a concurrent `steer`
 * write can't be silently dropped between read and delete.
 */
function consumeSteering(payloadCwd) {
    const p = (0, paths_1.steeringPath)(payloadCwd);
    const tmp = p + ".consuming." + process.pid;
    try {
        fs.renameSync(p, tmp);
    }
    catch {
        return null; // no pending steering
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
