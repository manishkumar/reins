"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.runPreTool = runPreTool;
const util_1 = require("../util");
const paths_1 = require("../paths");
const guards_1 = require("../guards");
const steering_1 = require("../steering");
const holds_1 = require("../holds");
const defer_1 = require("../defer");
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
    // Claude Code's id for this specific tool call. A deferred (parked) call is
    // replayed through this hook on resume carrying the SAME id, which is what
    // lets an approval be bound to one exact call rather than to its form.
    const toolUseId = payload.tool_use_id || "";
    // 1. GUARD — the decision point. "deny" is the hard veto; "ask" escalates to
    //    the human via the native permission prompt. If anything here is uncertain
    //    we fail open (allow), but the matching itself is deterministic.
    try {
        const guards = (0, guards_1.loadGuards)(cwd);
        const match = (0, guards_1.checkGuards)(guards, toolName, toolInput, cwd);
        if (match) {
            if (match.rule.action === "hold") {
                // Manual/test invocation (no session): deny, but don't park — the same
                // "don't record phantom sessions" principle as capture. The message
                // says why, so a by-hand `reins hook pre-tool` check explains itself.
                if (!sessionId) {
                    (0, hookio_1.emitDeny)(match.rule.reason + " [reins hold] (no session — denied, not parked)");
                    return;
                }
                // The async gate. First: did a human already answer this proposal?
                // A decision is one-shot and keyed either to this exact deferred call
                // (tool_use_id — the replay of a parked call) or to this session's
                // identical proposal (input hash — a retry after a deny-transport
                // hold). Either way the human is never asked twice for one decision.
                const inputHash = (0, util_1.hashToolInput)(toolName, toolInput);
                const decided = (0, holds_1.consumeDecision)(cwd, {
                    tool_use_id: toolUseId,
                    session_id: sessionId,
                    input_hash: inputHash,
                });
                if (decided) {
                    if (decided.resolution === "approved") {
                        (0, hookio_1.emitAllow)(`Approved via reins (hold ${decided.action_id}, rule ${decided.rule_id}).`);
                        recordDecision(cwd, sessionId, toolName, toolInput, match.rule, "APPROVED", decided.action_id);
                    }
                    else {
                        // A refusal is delivered at the boundary, not left to a steer that
                        // may never be consumed: the agent learns the answer exactly when
                        // it asks, and (if the human supplied one) what to do instead.
                        (0, hookio_1.emitDeny)((0, holds_1.formatRefusalReason)(decided.action_id, match.rule.reason, decided.steer));
                        recordDecision(cwd, sessionId, toolName, toolInput, match.rule, "REFUSED", decided.action_id);
                    }
                    return;
                }
                // Not answered (yet): park the proposal. How the call is stopped is the
                // transport — defer keeps Claude Code's own tool call alive so that
                // approving later runs the ORIGINAL proposal; deny vetoes this attempt
                // and asks the agent to retry after approval. defer is only honored in
                // print mode and only for a solo tool call, so canDefer() decides, and
                // when it cannot be sure the answer is deny — a hold that silently
                // failed to hold would be the worst bug reins could ship.
                //
                // The park is by file, not DB, so it holds even where capture can't
                // run. Gate decisions bias CLOSED, alone in reins: if parking itself
                // fails (unwritable .reins?), the call is still denied — a hold rule's
                // action must never run un-approved just because the queue misbehaved.
                const transport = (0, defer_1.canDefer)(payload) ? "defer" : "deny";
                try {
                    const { id, existed } = (0, holds_1.parkAction)(cwd, {
                        session_id: sessionId,
                        tool: toolName,
                        input: toolInput,
                        input_hash: inputHash,
                        tool_use_id: toolUseId || undefined,
                        transport,
                        rule_id: match.rule.id,
                        reason: match.rule.reason,
                        ts: (0, util_1.nowIso)(),
                    });
                    // The notice goes to the human, the reason to the agent — one JSON
                    // object carrying both. Only on the FIRST park: a retry of an
                    // already-parked action is the same decision, and re-notifying would
                    // train the reader to ignore the line that matters.
                    const notice = existed ? undefined : (0, holds_1.formatHoldNotice)(id, toolName, toolInput);
                    if (transport === "defer") {
                        (0, hookio_1.emitDefer)((0, holds_1.formatDeferReason)(id, match.rule.reason), notice);
                    }
                    else {
                        (0, hookio_1.emitDeny)((0, holds_1.formatHoldReason)(id, match.rule.reason), notice);
                    }
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
                noteDenialForBypassCheck(cwd, sessionId, toolName, toolInput, match.rule);
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
        const { openDb, upsertSessionStart, insertToolCall, insertDecision, } = require("../db");
        const db = openDb(cwd);
        if (!db)
            return; // no SQLite backend — capture disabled, decision already made
        upsertSessionStart(db, sessionId, (0, paths_1.resolveProjectDir)(cwd), (0, util_1.nowIso)());
        const inputHash = decision === "DENIED"
            ? (0, util_1.hashToolInput)(toolName, toolInput)
            : (0, util_1.hashToolInput)(decision + ":" + toolName, toolInput);
        const ts = (0, util_1.nowIso)();
        insertToolCall(db, {
            session_id: sessionId,
            tool: toolName,
            input_summary: `${decision}: ` +
                (0, util_1.summarizeToolInput)(toolName, toolInput) +
                ` [guard:${rule.id}]` +
                (holdId ? ` [hold:${holdId}]` : ""),
            input_hash: inputHash,
            // DENIED, HELD and REFUSED are definitive non-executions of this attempt.
            // An ask's resolution is unknown here, and an APPROVED row is a marker —
            // the executed call gets its own PostToolUse row with the real ok.
            ok: decision === "DENIED" || decision === "HELD" || decision === "REFUSED"
                ? 0
                : null,
            ts,
        });
        // The unified decisions row (see db.ts) — same event, plain columns
        // instead of a tag baked into input_summary, so `reins audit` and
        // `reins audit --json` don't need to reparse tool_calls.
        insertDecision(db, {
            session_id: sessionId,
            ts,
            tool: toolName,
            input_summary: (0, util_1.summarizeToolInput)(toolName, toolInput),
            input_hash: inputHash,
            rule_id: rule.id,
            rule_reason: rule.reason,
            decision: gateToDecision(decision),
            hold_id: holdId ?? null,
        });
    }
    catch (e) {
        warn("capture (" + decision.toLowerCase() + ") failed: " + String(e));
    }
}
/**
 * Leave a breadcrumb so PostToolUse can tell whether this veto actually held.
 *
 * Written to a plain file rather than the DB deliberately: SQLite is optional
 * (Node >= 22.5) and "your guard was worked around" must not be a fact that
 * silently disappears on an older runtime. Failure here is swallowed — a
 * reporting breadcrumb may never affect a gate decision or break a run.
 */
function noteDenialForBypassCheck(cwd, sessionId, toolName, toolInput, rule) {
    if (!sessionId || toolName !== "Bash")
        return; // bypass tracking is command-shaped
    try {
        const command = toolInput?.command;
        if (typeof command !== "string" || !command)
            return;
        const { recordDenial, fingerprint } = require("../bypass");
        recordDenial(cwd, {
            session_id: sessionId,
            ts: (0, util_1.nowIso)(),
            rule_id: rule.id,
            tool: toolName,
            summary: (0, util_1.summarizeToolInput)(toolName, toolInput),
            fp: fingerprint(command),
        });
    }
    catch (e) {
        warn("bypass ledger write failed: " + String(e));
    }
}
/** Map the tool_calls-era tag to the decisions table's decision column. */
function gateToDecision(gate) {
    switch (gate) {
        case "DENIED":
        // A refusal collected at the boundary is a deny, with the hold id on the
        // row saying which parked proposal it answers.
        case "REFUSED":
            return "deny";
        case "ASKED":
            return "ask";
        case "HELD":
            return "hold";
        case "APPROVED":
            return "allow";
    }
}
function warn(msg) {
    process.stderr.write("[reins] " + msg + "\n");
}
