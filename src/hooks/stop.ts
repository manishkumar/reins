import { readStdinJson, nowIso } from "../util";
import { resolveProjectDir } from "../paths";
import { readTranscriptTotals } from "../transcript";

/**
 * Stop: capture the run's outcome and best-effort token/cost from the
 * transcript. We record the verdict; we do not define it (no shipped gates).
 */
export async function runStop(): Promise<void> {
  const payload = await readStdinJson();
  const cwd = (payload.cwd as string) || undefined;
  const sessionId = (payload.session_id as string) || "unknown";
  const transcriptPath = payload.transcript_path as string | undefined;
  const outcome =
    (payload.reason as string) ||
    (payload.stop_reason as string) ||
    "completed";

  try {
    const {
      openDb,
      upsertSessionStart,
      finalizeSession,
      insertOutcome,
    } = require("../db") as typeof import("../db");
    const db = openDb(cwd);
    upsertSessionStart(db, sessionId, resolveProjectDir(cwd), nowIso());

    const totals = readTranscriptTotals(transcriptPath);
    finalizeSession(db, sessionId, nowIso(), outcome, totals.totalTokens, totals.totalCost);
    insertOutcome(db, sessionId, outcome, null /* gate_result: reserved */);
  } catch (e) {
    process.stderr.write("[reins] stop capture failed: " + String(e) + "\n");
  }
}
