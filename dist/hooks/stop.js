"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.runStop = runStop;
const util_1 = require("../util");
const paths_1 = require("../paths");
const transcript_1 = require("../transcript");
const steering_1 = require("../steering");
const config_1 = require("../config");
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
        const line = [formatSummary(summarizeSession(cwd, sessionId), heldCount), claimLineAtStop(cwd, sessionId)]
            .filter(Boolean)
            .join("\n");
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
        upsertSessionStart(db, sessionId, (0, paths_1.resolveProjectDir)(cwd), (0, util_1.nowIso)(), transcriptPath);
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
/**
 * The claim check, for the turn that just ended: did it leave edits failing,
 * untested or unverified? One line for the human, or null.
 *
 * Said only when this turn edited code or ran a check, so a turn of pure
 * conversation does not repeat the last turn's verdict. It is read from the
 * capture DB, so it is best-effort and absent without SQLite. It is a
 * report: the Stop is never blocked on it.
 */
function claimLineAtStop(cwd, sessionId) {
    try {
        if ((0, config_1.loadConfig)(cwd).claimCheck === false)
            return null;
        const { openDb, listSessionCalls } = require("../db");
        const { checkClaim, claimNeedsAttention, touchesClaim } = require("../claim");
        const { truncate } = require("../util");
        const db = openDb(cwd);
        if (!db)
            return null;
        const calls = listSessionCalls(db, sessionId);
        // `ended` is the previous Stop: Claude Code fires Stop at every turn boundary.
        const prev = db.prepare(`SELECT ended FROM sessions WHERE id = ?`).get(sessionId);
        const since = prev?.ended ?? "";
        if (!calls.some((c) => c.ts > since && touchesClaim(c)))
            return null;
        const claim = checkClaim(calls);
        if (!claimNeedsAttention(claim))
            return null;
        const cmd = claim.command ? ` (${truncate(claim.command, 60)})` : "";
        return `[reins] Claim check: ${claim.text}${cmd}. reins lastrun lists the calls.`;
    }
    catch {
        return null;
    }
}
