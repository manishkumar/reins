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
