"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.runPostTool = runPostTool;
const util_1 = require("../util");
const paths_1 = require("../paths");
const config_1 = require("../config");
const hookio_1 = require("../hookio");
/**
 * PostToolUse: record the executed call, then raise the loop alarm if this exact
 * (tool + input) has now repeated >= the configured threshold.
 */
async function runPostTool() {
    const payload = await (0, util_1.readStdinJson)();
    const cwd = payload.cwd || undefined;
    const sessionId = payload.session_id || "";
    const toolName = payload.tool_name || "";
    const toolInput = payload.tool_input ?? {};
    const toolResponse = payload.tool_response;
    const inputHash = (0, util_1.hashToolInput)(toolName, toolInput);
    const summary = (0, util_1.summarizeToolInput)(toolName, toolInput);
    const ok = inferOk(toolResponse);
    let repeatCount = 0;
    try {
        const { openDb, upsertSessionStart, insertToolCall, countTrailingSameHash, } = require("../db");
        const db = sessionId ? openDb(cwd) : null; // no real session => don't record
        if (db) {
            upsertSessionStart(db, sessionId, (0, paths_1.resolveProjectDir)(cwd), (0, util_1.nowIso)());
            insertToolCall(db, {
                session_id: sessionId,
                tool: toolName,
                input_summary: summary,
                input_hash: inputHash,
                ok,
                ts: (0, util_1.nowIso)(),
            });
            // Consecutive streak, not all-session count — re-running `npm test` after
            // edits is iteration, not a loop.
            repeatCount = countTrailingSameHash(db, sessionId, inputHash);
        }
    }
    catch (e) {
        process.stderr.write("[reins] capture (post) failed: " + String(e) + "\n");
    }
    // HOLD BREACH — did a call that is sitting in the approval queue just run
    // anyway? It should be impossible: the gate denies or defers it. But defer is
    // silently ignored by Claude Code in cases the hook cannot see (a batch of
    // parallel tool calls), and a silently-unenforced hold is the worst failure
    // reins could have. So the queue is checked from the far side of execution:
    // a still-parked action that executed is recorded loudly rather than never
    // being noticed. Detection only — the action already ran.
    if (sessionId) {
        try {
            const { pendingForSession } = require("../holds");
            const breached = pendingForSession(cwd, sessionId).find((p) => p.input_hash === inputHash || (p.tool_use_id && p.tool_use_id === payload.tool_use_id));
            if (breached)
                recordBreach(cwd, sessionId, toolName, summary, inputHash, breached.id);
        }
        catch (e) {
            process.stderr.write("[reins] hold-breach check failed: " + String(e) + "\n");
        }
    }
    // LOOP ALARM — observe + warn. Surfaced to the agent at this tool boundary.
    const threshold = (0, config_1.loadConfig)(cwd).loopThreshold;
    if (repeatCount >= threshold) {
        const warning = `[reins loop alarm] You have now run ${toolName} with identical input ` +
            `${repeatCount} times in a row ("${(0, util_1.truncate)(summary, 80)}"). ` +
            `This usually means the current approach is stuck. Stop repeating it and ` +
            `try something different — change the input, inspect why it isn't working, ` +
            `or ask the developer.`;
        (0, hookio_1.emitPostToolContext)(warning);
        process.stderr.write(warning + "\n");
    }
}
/**
 * Record that an action still awaiting approval executed anyway. Best-effort
 * like all capture, but it also warns on stderr so it is visible even where
 * SQLite isn't available — this is the one capture event a human most needs to
 * see, and losing it silently would defeat its purpose.
 */
function recordBreach(cwd, sessionId, toolName, summary, inputHash, holdId) {
    const msg = `[reins] HOLD BREACH: ${toolName} (${(0, util_1.truncate)(summary, 80)}) executed while still ` +
        `parked for approval as ${holdId}. The defer/deny gate did not hold for this call — ` +
        `see \`reins audit\`. Set holdTransport to "deny" in .reins/config.json to use the ` +
        `transport that works everywhere.`;
    process.stderr.write(msg + "\n");
    try {
        const { openDb, insertDecision } = require("../db");
        const db = openDb(cwd);
        if (!db)
            return;
        insertDecision(db, {
            session_id: sessionId,
            ts: (0, util_1.nowIso)(),
            tool: toolName,
            input_summary: "BREACH: " + summary,
            input_hash: inputHash,
            rule_id: "",
            rule_reason: "Action executed while still awaiting approval.",
            decision: "breach",
            hold_id: holdId,
        });
    }
    catch {
        /* the stderr warning above already carried it */
    }
}
/** Best-effort success detection from the tool response. */
function inferOk(toolResponse) {
    if (toolResponse == null || typeof toolResponse !== "object")
        return null;
    const r = toolResponse;
    if (r.success === false)
        return 0;
    if (r.success === true)
        return 1;
    if (r.is_error === true || r.error)
        return 0;
    if (typeof r.stderr === "string" && r.stderr && r.stdout === "") {
        // heuristic: pure-stderr bash result; leave as unknown rather than guess
        return null;
    }
    return 1;
}
