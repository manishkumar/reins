import { readStdinJson, nowIso } from "../util";
import { resolveProjectDir } from "../paths";
import { readTranscriptTotals } from "../transcript";
import { consumeSteering, formatSteeringStopReason } from "../steering";

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
export async function runStop(): Promise<void> {
  const payload = await readStdinJson();
  const cwd = (payload.cwd as string) || undefined;
  const sessionId = (payload.session_id as string) || "";

  // 1. Deliver pending steering (targeted-for-this-session first, then the
  //    broadcast — same preference order as the pre-tool boundary). Runs even
  //    for sessionless manual invocations, mirroring pre-tool semantics.
  try {
    const message = consumeSteering(cwd, sessionId || undefined);
    if (message) {
      process.stdout.write(
        JSON.stringify({
          decision: "block",
          reason: formatSteeringStopReason(message),
        }),
      );
      return; // the session continues — do not finalize it as ended
    }
  } catch (e) {
    process.stderr.write("[reins] stop steering delivery failed: " + String(e) + "\n");
  }

  if (!sessionId) return; // manual/test invocation — nothing to finalize
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
    if (!db) return; // no SQLite backend — nothing to finalize
    upsertSessionStart(db, sessionId, resolveProjectDir(cwd), nowIso());

    const totals = readTranscriptTotals(transcriptPath);
    finalizeSession(db, sessionId, nowIso(), outcome, totals.totalTokens, totals.totalCost);
    // gate_result: if the run ends with actions still parked in the hold
    // queue, say so in the archive — "ended with 2 actions awaiting approval"
    // is the headline fact about an unattended run.
    let gateResult: string | null = null;
    try {
      const { pendingForSession } = require("../holds") as typeof import("../holds");
      const held = pendingForSession(cwd, sessionId).length;
      if (held > 0) gateResult = `holds-pending:${held}`;
    } catch {
      /* best-effort */
    }
    insertOutcome(db, sessionId, outcome, gateResult);
  } catch (e) {
    process.stderr.write("[reins] stop capture failed: " + String(e) + "\n");
  }
}
