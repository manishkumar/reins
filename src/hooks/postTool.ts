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
  const sessionId = (payload.session_id as string) || "unknown";
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
      countSameHash,
    } = require("../db") as typeof import("../db");
    const db = openDb(cwd);
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
    repeatCount = countSameHash(db, sessionId, inputHash);
    }
  } catch (e) {
    process.stderr.write("[reins] capture (post) failed: " + String(e) + "\n");
  }

  // LOOP ALARM — observe + warn. Surfaced to the agent at this tool boundary.
  const threshold = loadConfig(cwd).loopThreshold;
  if (repeatCount >= threshold) {
    const warning =
      `[reins loop alarm] You have now run ${toolName} with identical input ` +
      `${repeatCount} times in this session ("${truncate(summary, 80)}"). ` +
      `This usually means the current approach is stuck. Stop repeating it and ` +
      `try something different — change the input, inspect why it isn't working, ` +
      `or ask the developer.`;
    emitPostToolContext(warning);
    process.stderr.write(warning + "\n");
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
