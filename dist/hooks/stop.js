"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.runStop = runStop;
const util_1 = require("../util");
const paths_1 = require("../paths");
const transcript_1 = require("../transcript");
const steering_1 = require("../steering");
/**
 * Stop: two jobs, in order.
 *
 * 1. DELIVERY GUARANTEE for steering. A nudge queued after the agent's last
 *    tool call has no tool boundary left to land on — without this check it
 *    would rot in .reins/ forever, silently. If steering is pending, we block
 *    the stop and hand the nudge over as the reason, so "lands at the next
 *    tool boundary" becomes "guaranteed to land before the run ends".
 *    Consuming the file makes this self-terminating: the re-stop finds nothing
 *    pending (unless the developer steered again, in which case blocking again
 *    is exactly right), so no infinite continue-loop is possible.
 *
 * 2. Capture the run's outcome and best-effort token/cost from the transcript.
 *    We record the verdict; we do not define it (no shipped gates).
 */
async function runStop() {
    const payload = await (0, util_1.readStdinJson)();
    const cwd = payload.cwd || undefined;
    const sessionId = payload.session_id || "";
    // 1. Deliver pending steering (targeted-for-this-session first, then the
    //    broadcast — same preference order as the pre-tool boundary). Runs even
    //    for sessionless manual invocations, mirroring pre-tool semantics.
    try {
        const message = (0, steering_1.consumeSteering)(cwd, sessionId || undefined);
        if (message) {
            process.stdout.write(JSON.stringify({
                decision: "block",
                reason: (0, steering_1.formatSteeringStopReason)(message),
            }));
            return; // the session continues — do not finalize it as ended
        }
    }
    catch (e) {
        process.stderr.write("[reins] stop steering delivery failed: " + String(e) + "\n");
    }
    if (!sessionId)
        return; // manual/test invocation — nothing to finalize
    // 2. THE SESSION SUMMARY. Per-event warnings serve whoever is watching the
    //    run; this serves whoever walked away — which, for the runs reins exists
    //    for, is the more important reader. Emitted before capture so a DB
    //    failure can't swallow it.
    let heldCount = 0;
    try {
        const { pendingForSession } = require("../holds");
        heldCount = pendingForSession(cwd, sessionId).length;
    }
    catch {
        /* best-effort */
    }
    try {
        const { summarizeSession, formatSummary, clearSession } = require("../bypass");
        const line = formatSummary(summarizeSession(cwd, sessionId), heldCount);
        if (line) {
            // stderr always; `systemMessage` is the field Claude Code surfaces to the
            // user, and an object carrying only that is still a passthrough — no
            // decision, so the stop is not blocked. If a Claude Code version ignores
            // the field, the stderr line above is unaffected.
            process.stderr.write(line + "\n");
            process.stdout.write(JSON.stringify({ systemMessage: line }));
        }
        clearSession(cwd, sessionId);
    }
    catch (e) {
        process.stderr.write("[reins] stop summary failed: " + String(e) + "\n");
    }
    const transcriptPath = payload.transcript_path;
    const outcome = payload.reason ||
        payload.stop_reason ||
        "completed";
    try {
        const { openDb, upsertSessionStart, finalizeSession, insertOutcome, } = require("../db");
        const db = openDb(cwd);
        if (!db)
            return; // no SQLite backend — nothing to finalize
        upsertSessionStart(db, sessionId, (0, paths_1.resolveProjectDir)(cwd), (0, util_1.nowIso)());
        const totals = (0, transcript_1.readTranscriptTotals)(transcriptPath);
        finalizeSession(db, sessionId, (0, util_1.nowIso)(), outcome, totals.totalTokens, totals.totalCost);
        // gate_result: if the run ends with actions still parked in the hold
        // queue, say so in the archive — "ended with 2 actions awaiting approval"
        // is the headline fact about an unattended run.
        let gateResult = null;
        try {
            const { pendingForSession } = require("../holds");
            const held = pendingForSession(cwd, sessionId).length;
            if (held > 0)
                gateResult = `holds-pending:${held}`;
        }
        catch {
            /* best-effort */
        }
        insertOutcome(db, sessionId, outcome, gateResult);
    }
    catch (e) {
        process.stderr.write("[reins] stop capture failed: " + String(e) + "\n");
    }
}
