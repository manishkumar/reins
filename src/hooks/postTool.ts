import { readStdinJson, summarizeToolInput, hashToolInput, nowIso, truncate } from "../util";
import { resolveProjectDir } from "../paths";
import { loadConfig } from "../config";
import { emitPostToolContext } from "../hookio";

/**
 * PostToolUse: record the executed call, then raise the loop alarm if this exact
 * (tool + input) has now repeated >= the configured threshold.
 */
export async function runPostTool(): Promise<void> {
  const payload = await readStdinJson();
  const cwd = (payload.cwd as string) || undefined;
  const sessionId = (payload.session_id as string) || "";
  const toolName = (payload.tool_name as string) || "";
  const toolInput = payload.tool_input ?? {};
  const toolResponse = payload.tool_response;

  const inputHash = hashToolInput(toolName, toolInput);
  const summary = summarizeToolInput(toolName, toolInput);
  const ok = inferOk(toolResponse);

  let repeatCount = 0;
  try {
    const {
      openDb,
      upsertSessionStart,
      insertToolCall,
      countTrailingSameHash,
    } = require("../db") as typeof import("../db");
    const db = sessionId ? openDb(cwd) : null; // no real session => don't record
    if (db) {
    upsertSessionStart(db, sessionId, resolveProjectDir(cwd), nowIso());
    insertToolCall(db, {
      session_id: sessionId,
      tool: toolName,
      input_summary: summary,
      input_hash: inputHash,
      ok,
      ts: nowIso(),
    });
    // Consecutive streak, not all-session count — re-running `npm test` after
    // edits is iteration, not a loop.
    repeatCount = countTrailingSameHash(db, sessionId, inputHash);
    }
  } catch (e) {
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
      const { pendingForSession } = require("../holds") as typeof import("../holds");
      const breached = pendingForSession(cwd, sessionId).find(
        (p) => p.input_hash === inputHash || (p.tool_use_id && p.tool_use_id === payload.tool_use_id),
      );
      if (breached) recordBreach(cwd, sessionId, toolName, summary, inputHash, breached.id);
    } catch (e) {
      process.stderr.write("[reins] hold-breach check failed: " + String(e) + "\n");
    }
  }

  // LOOP ALARM — observe + warn. Surfaced to the agent at this tool boundary.
  const threshold = loadConfig(cwd).loopThreshold;
  if (repeatCount >= threshold) {
    const warning =
      `[reins loop alarm] You have now run ${toolName} with identical input ` +
      `${repeatCount} times in a row ("${truncate(summary, 80)}"). ` +
      `This usually means the current approach is stuck. Stop repeating it and ` +
      `try something different — change the input, inspect why it isn't working, ` +
      `or ask the developer.`;
    emitPostToolContext(warning);
    process.stderr.write(warning + "\n");
  }
}

/**
 * Record that an action still awaiting approval executed anyway. Best-effort
 * like all capture, but it also warns on stderr so it is visible even where
 * SQLite isn't available — this is the one capture event a human most needs to
 * see, and losing it silently would defeat its purpose.
 */
function recordBreach(
  cwd: string | undefined,
  sessionId: string,
  toolName: string,
  summary: string,
  inputHash: string,
  holdId: string,
): void {
  const msg =
    `[reins] HOLD BREACH: ${toolName} (${truncate(summary, 80)}) executed while still ` +
    `parked for approval as ${holdId}. The defer/deny gate did not hold for this call — ` +
    `see \`reins audit\`. Set holdTransport to "deny" in .reins/config.json to use the ` +
    `transport that works everywhere.`;
  process.stderr.write(msg + "\n");
  try {
    const { openDb, insertDecision } = require("../db") as typeof import("../db");
    const db = openDb(cwd);
    if (!db) return;
    insertDecision(db, {
      session_id: sessionId,
      ts: nowIso(),
      tool: toolName,
      input_summary: "BREACH: " + summary,
      input_hash: inputHash,
      rule_id: "",
      rule_reason: "Action executed while still awaiting approval.",
      decision: "breach",
      hold_id: holdId,
    });
  } catch {
    /* the stderr warning above already carried it */
  }
}

/** Best-effort success detection from the tool response. */
function inferOk(toolResponse: unknown): number | null {
  if (toolResponse == null || typeof toolResponse !== "object") return null;
  const r = toolResponse as Record<string, unknown>;
  if (r.success === false) return 0;
  if (r.success === true) return 1;
  if (r.is_error === true || r.error) return 0;
  if (typeof r.stderr === "string" && r.stderr && r.stdout === "") {
    // heuristic: pure-stderr bash result; leave as unknown rather than guess
    return null;
  }
  return 1;
}
