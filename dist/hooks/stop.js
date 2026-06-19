"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.runStop = runStop;
const util_1 = require("../util");
const paths_1 = require("../paths");
const transcript_1 = require("../transcript");
/**
 * Stop: capture the run's outcome and best-effort token/cost from the
 * transcript. We record the verdict; we do not define it (no shipped gates).
 */
async function runStop() {
    const payload = await (0, util_1.readStdinJson)();
    const cwd = payload.cwd || undefined;
    const sessionId = payload.session_id || "";
    if (!sessionId)
        return; // manual/test invocation — nothing to finalize
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
        insertOutcome(db, sessionId, outcome, null /* gate_result: reserved */);
    }
    catch (e) {
        process.stderr.write("[reins] stop capture failed: " + String(e) + "\n");
    }
}
