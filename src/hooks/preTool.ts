import { readStdinJson, summarizeToolInput, hashToolInput, nowIso } from "../util";
import { resolveProjectDir } from "../paths";
import { loadGuards, checkGuards } from "../guards";
import { consumeSteering, formatSteeringContext } from "../steering";
import { emitDeny, emitPreToolContext } from "../hookio";

/**
 * PreToolUse: the moment of decision. Order is deliberate.
 *   1. Guard (hard veto) — short-circuits; nothing else runs.
 *   2. Steering (soft nudge) — injected once, then cleared.
 *   3. Passthrough.
 * Capture is best-effort and never allowed to affect the decision.
 */
export async function runPreTool(): Promise<void> {
  const payload = await readStdinJson();
  const cwd = (payload.cwd as string) || undefined;
  const sessionId = (payload.session_id as string) || "unknown";
  const toolName = (payload.tool_name as string) || "";
  const toolInput = payload.tool_input ?? {};

  // 1. GUARD — hard veto. If anything here is uncertain we fail open (allow),
  //    but the matching itself is deterministic and self-contained.
  try {
    const guards = loadGuards(cwd);
    const match = checkGuards(guards, toolName, toolInput);
    if (match) {
      emitDeny(match.rule.reason);
      recordDenied(cwd, sessionId, toolName, toolInput);
      return; // do NOT consume steering on a denied call; leave it for next time
    }
  } catch (e) {
    warn("guard check failed (failing open): " + String(e));
  }

  // 2. STEERING — soft, one-shot, overridable by the model's judgment.
  try {
    const message = consumeSteering(cwd);
    if (message) {
      emitPreToolContext(formatSteeringContext(message));
      return;
    }
  } catch (e) {
    warn("steering injection failed: " + String(e));
  }

  // 3. PASSTHROUGH — allow, inject nothing.
}

function recordDenied(
  cwd: string | undefined,
  sessionId: string,
  toolName: string,
  toolInput: unknown,
): void {
  try {
    const {
      openDb,
      upsertSessionStart,
      nextSeq,
      insertToolCall,
    } = require("../db") as typeof import("../db");
    const db = openDb(cwd);
    upsertSessionStart(db, sessionId, resolveProjectDir(cwd), nowIso());
    insertToolCall(db, {
      session_id: sessionId,
      seq: nextSeq(db, sessionId),
      tool: toolName,
      input_summary: "DENIED: " + summarizeToolInput(toolName, toolInput),
      input_hash: hashToolInput(toolName, toolInput),
      ok: 0,
      ts: nowIso(),
    });
  } catch (e) {
    warn("capture (denied) failed: " + String(e));
  }
}

function warn(msg: string): void {
  process.stderr.write("[reins] " + msg + "\n");
}
