"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.runPreTool = runPreTool;
const util_1 = require("../util");
const paths_1 = require("../paths");
const guards_1 = require("../guards");
const steering_1 = require("../steering");
const holds_1 = require("../holds");
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
    // 1. GUARD — the decision point. "deny" is the hard veto; "ask" escalates to
    //    the human via the native permission prompt. If anything here is uncertain
    //    we fail open (allow), but the matching itself is deterministic.
    try {
        const guards = (0, guards_1.loadGuards)(cwd);
        const match = (0, guards_1.checkGuards)(guards, toolName, toolInput);
        if (match) {
            if (match.rule.action === "hold") {
                // Manual/test invocation (no session): deny, but don't park — the same
                // "don't record phantom sessions" principle as capture. The message
                // says why, so a by-hand `reins hook pre-tool` check explains itself.
                if (!sessionId) {
                    (0, hookio_1.emitDeny)(match.rule.reason + " [reins hold] (no session — denied, not parked)");
                    return;
                }
                // The async gate. First: is this exact call already approved? A
                // one-shot allowance (written by `reins approve`) keyed on the input
                // hash lets the identical retry through — once — and we emit an
                // explicit allow so the human isn't asked twice for the same decision.
                const inputHash = (0, util_1.hashToolInput)(toolName, toolInput);
                const allowance = (0, holds_1.consumeAllowance)(cwd, inputHash);
                if (allowance) {
                    (0, hookio_1.emitAllow)(`Approved via reins (hold ${allowance.action_id}, rule ${allowance.rule_id}).`);
                    recordDecision(cwd, sessionId, toolName, toolInput, match.rule, "APPROVED", allowance.action_id);
                    return;
                }
                // Not approved (yet): park the proposal and deny THIS attempt, with a
                // reason that redirects the agent to other work instead of a dead end.
                // The park is by file, not DB, so it holds even where capture can't run.
                // Gate decisions bias CLOSED, alone in reins: if parking itself fails
                // (unwritable .reins?), the call is still denied — a hold rule's action
                // must never run un-approved just because the queue misbehaved.
                try {
                    const { id, existed } = (0, holds_1.parkAction)(cwd, {
                        session_id: sessionId,
                        tool: toolName,
                        input: toolInput,
                        input_hash: inputHash,
                        rule_id: match.rule.id,
                        reason: match.rule.reason,
                        ts: (0, util_1.nowIso)(),
                    });
                    (0, hookio_1.emitDeny)((0, holds_1.formatHoldReason)(id, match.rule.reason));
                    // A retry of an already-parked action is the same decision, not a
                    // new audit event — record the HELD row only the first time.
                    if (!existed) {
                        recordDecision(cwd, sessionId, toolName, toolInput, match.rule, "HELD", id);
                    }
                }
                catch (e) {
                    warn("hold parking failed (denying anyway): " + String(e));
                    (0, hookio_1.emitDeny)(match.rule.reason +
                        " [reins hold] Parking for approval failed, so this call is denied outright.");
                }
            }
            else if (match.rule.action === "ask") {
                (0, hookio_1.emitAsk)(match.rule.reason);
                recordDecision(cwd, sessionId, toolName, toolInput, match.rule, "ASKED");
            }
            else {
                (0, hookio_1.emitDeny)(match.rule.reason);
                recordDecision(cwd, sessionId, toolName, toolInput, match.rule, "DENIED");
            }
            return; // do NOT consume steering on a gated call; leave it for next time
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
/**
 * Record a gate decision with its provenance (which rule fired, and for holds,
 * which queue entry). The rule id in the summary is the seed of the audit
 * trail: `lastrun` shows not just that a call was stopped, but by which rule.
 *
 * ASKED / HELD / APPROVED rows get a decision-derived hash on purpose: when the
 * real call eventually executes, PostToolUse records it with the true input
 * hash — a gate row sharing that hash would inflate the loop alarm's repeat
 * count. Only DENIED keeps the true hash: an agent repeatedly slamming into
 * the same hard veto *is* a loop worth alarming on.
 */
function recordDecision(cwd, sessionId, toolName, toolInput, rule, decision, holdId) {
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
            input_summary: `${decision}: ` +
                (0, util_1.summarizeToolInput)(toolName, toolInput) +
                ` [guard:${rule.id}]` +
                (holdId ? ` [hold:${holdId}]` : ""),
            input_hash: decision === "DENIED"
                ? (0, util_1.hashToolInput)(toolName, toolInput)
                : (0, util_1.hashToolInput)(decision + ":" + toolName, toolInput),
            // DENIED and HELD are definitive non-executions of this attempt. An
            // ask's resolution is unknown here, and an APPROVED row is a marker —
            // the executed call gets its own PostToolUse row with the real ok.
            ok: decision === "DENIED" || decision === "HELD" ? 0 : null,
            ts: (0, util_1.nowIso)(),
        });
    }
    catch (e) {
        warn("capture (" + decision.toLowerCase() + ") failed: " + String(e));
    }
}
function warn(msg) {
    process.stderr.write("[reins] " + msg + "\n");
}
