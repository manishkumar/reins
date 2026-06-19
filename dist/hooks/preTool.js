"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.runPreTool = runPreTool;
const util_1 = require("../util");
const paths_1 = require("../paths");
const guards_1 = require("../guards");
const steering_1 = require("../steering");
const hookio_1 = require("../hookio");
/**
 * PreToolUse: the moment of decision. Order is deliberate.
 *   1. Guard (hard veto) — short-circuits; nothing else runs.
 *   2. Steering (soft nudge) — injected once, then cleared.
 *   3. Passthrough.
 * Capture is best-effort and never allowed to affect the decision.
 */
async function runPreTool() {
    const payload = await (0, util_1.readStdinJson)();
    const cwd = payload.cwd || undefined;
    // Real Claude Code events always carry a session_id. Its absence means a
    // manual/test invocation — guard + steer still run, but we don't record a
    // phantom "unknown" session into the trajectory log.
    const sessionId = payload.session_id || "";
    const toolName = payload.tool_name || "";
    const toolInput = payload.tool_input ?? {};
    // 1. GUARD — hard veto. If anything here is uncertain we fail open (allow),
    //    but the matching itself is deterministic and self-contained.
    try {
        const guards = (0, guards_1.loadGuards)(cwd);
        const match = (0, guards_1.checkGuards)(guards, toolName, toolInput);
        if (match) {
            (0, hookio_1.emitDeny)(match.rule.reason);
            recordDenied(cwd, sessionId, toolName, toolInput);
            return; // do NOT consume steering on a denied call; leave it for next time
        }
    }
    catch (e) {
        warn("guard check failed (failing open): " + String(e));
    }
    // 2. STEERING — soft, one-shot, overridable by the model's judgment.
    try {
        const message = (0, steering_1.consumeSteering)(cwd, sessionId || undefined);
        if (message) {
            (0, hookio_1.emitPreToolContext)((0, steering_1.formatSteeringContext)(message));
            return;
        }
    }
    catch (e) {
        warn("steering injection failed: " + String(e));
    }
    // 3. PASSTHROUGH — allow, inject nothing.
}
function recordDenied(cwd, sessionId, toolName, toolInput) {
    if (!sessionId)
        return; // manual/test invocation — don't pollute the log
    try {
        const { openDb, upsertSessionStart, insertToolCall, } = require("../db");
        const db = openDb(cwd);
        if (!db)
            return; // no SQLite backend — capture disabled, decision already made
        upsertSessionStart(db, sessionId, (0, paths_1.resolveProjectDir)(cwd), (0, util_1.nowIso)());
        insertToolCall(db, {
            session_id: sessionId,
            tool: toolName,
            input_summary: "DENIED: " + (0, util_1.summarizeToolInput)(toolName, toolInput),
            input_hash: (0, util_1.hashToolInput)(toolName, toolInput),
            ok: 0,
            ts: (0, util_1.nowIso)(),
        });
    }
    catch (e) {
        warn("capture (denied) failed: " + String(e));
    }
}
function warn(msg) {
    process.stderr.write("[reins] " + msg + "\n");
}
