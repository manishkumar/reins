import { readStdinJson, summarizeToolInput, hashToolInput, nowIso } from "../util";
import { resolveProjectDir } from "../paths";
import { loadGuards, checkGuards, GuardRule } from "../guards";
import { consumeSteering, formatSteeringContext } from "../steering";
import { emitAsk, emitDeny, emitPreToolContext } from "../hookio";

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
  // Real Claude Code events always carry a session_id. Its absence means a
  // manual/test invocation — guard + steer still run, but we don't record a
  // phantom "unknown" session into the trajectory log.
  const sessionId = (payload.session_id as string) || "";
  const toolName = (payload.tool_name as string) || "";
  const toolInput = payload.tool_input ?? {};

  // 1. GUARD — the decision point. "deny" is the hard veto; "ask" escalates to
  //    the human via the native permission prompt. If anything here is uncertain
  //    we fail open (allow), but the matching itself is deterministic.
  try {
    const guards = loadGuards(cwd);
    const match = checkGuards(guards, toolName, toolInput);
    if (match) {
      if (match.rule.action === "ask") {
        emitAsk(match.rule.reason);
        recordDecision(cwd, sessionId, toolName, toolInput, match.rule, "ASKED");
      } else {
        emitDeny(match.rule.reason);
        recordDecision(cwd, sessionId, toolName, toolInput, match.rule, "DENIED");
      }
      return; // do NOT consume steering on a gated call; leave it for next time
    }
  } catch (e) {
    warn("guard check failed (failing open): " + String(e));
  }

  // 2. STEERING — soft, one-shot, overridable by the model's judgment.
  try {
    const message = consumeSteering(cwd, sessionId || undefined);
    if (message) {
      emitPreToolContext(formatSteeringContext(message));
      return;
    }
  } catch (e) {
    warn("steering injection failed: " + String(e));
  }

  // 3. PASSTHROUGH — allow, inject nothing.
}

/**
 * Record a gate decision with its provenance (which rule fired). The rule id in
 * the summary is the seed of the audit trail: `lastrun` shows not just that a
 * call was stopped, but by which rule.
 *
 * ASKED rows get a decision-derived hash on purpose: if the human approves, the
 * real call executes and PostToolUse records it with the true input hash — an
 * ASKED row sharing that hash would inflate the loop alarm's repeat count.
 */
function recordDecision(
  cwd: string | undefined,
  sessionId: string,
  toolName: string,
  toolInput: unknown,
  rule: GuardRule,
  decision: "DENIED" | "ASKED",
): void {
  if (!sessionId) return; // manual/test invocation — don't pollute the log
  try {
    const {
      openDb,
      upsertSessionStart,
      insertToolCall,
    } = require("../db") as typeof import("../db");
    const db = openDb(cwd);
    if (!db) return; // no SQLite backend — capture disabled, decision already made
    upsertSessionStart(db, sessionId, resolveProjectDir(cwd), nowIso());
    insertToolCall(db, {
      session_id: sessionId,
      tool: toolName,
      input_summary:
        `${decision}: ` + summarizeToolInput(toolName, toolInput) + ` [guard:${rule.id}]`,
      input_hash:
        decision === "ASKED"
          ? hashToolInput("ASKED:" + toolName, toolInput)
          : hashToolInput(toolName, toolInput),
      // A deny is a definitive non-execution; an ask's resolution is unknown
      // here (if approved, the executed call gets its own PostToolUse row).
      ok: decision === "DENIED" ? 0 : null,
      ts: nowIso(),
    });
  } catch (e) {
    warn("capture (" + decision.toLowerCase() + ") failed: " + String(e));
  }
}

function warn(msg: string): void {
  process.stderr.write("[reins] " + msg + "\n");
}
