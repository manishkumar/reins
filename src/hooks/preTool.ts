import { readStdinJson, summarizeToolInput, hashToolInput, nowIso } from "../util";
import { resolveProjectDir } from "../paths";
import { loadGuards, checkGuards, GuardRule } from "../guards";
import { consumeSteering, formatSteeringContext } from "../steering";
import { parkAction, consumeAllowance, formatHoldReason } from "../holds";
import { emitAllow, emitAsk, emitDeny, emitPreToolContext } from "../hookio";

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
      if (match.rule.action === "hold") {
        // Manual/test invocation (no session): deny, but don't park — the same
        // "don't record phantom sessions" principle as capture. The message
        // says why, so a by-hand `reins hook pre-tool` check explains itself.
        if (!sessionId) {
          emitDeny(match.rule.reason + " [reins hold] (no session — denied, not parked)");
          return;
        }
        // The async gate. First: is this exact call already approved? A
        // one-shot allowance (written by `reins approve`) keyed on the input
        // hash lets the identical retry through — once — and we emit an
        // explicit allow so the human isn't asked twice for the same decision.
        const inputHash = hashToolInput(toolName, toolInput);
        const allowance = consumeAllowance(cwd, inputHash);
        if (allowance) {
          emitAllow(
            `Approved via reins (hold ${allowance.action_id}, rule ${allowance.rule_id}).`,
          );
          recordDecision(cwd, sessionId, toolName, toolInput, match.rule, "APPROVED", allowance.action_id);
          return;
        }
        // Not approved (yet): park the proposal and deny THIS attempt, with a
        // reason that redirects the agent to other work instead of a dead end.
        // The park is by file, not DB, so it holds even where capture can't run.
        // Gate decisions bias CLOSED, alone in reins: if parking itself fails
        // (unwritable .reins?), the call is still denied — a hold rule's action
        // must never run un-approved just because the queue misbehaved.
        try {
          const { id, existed } = parkAction(cwd, {
            session_id: sessionId,
            tool: toolName,
            input: toolInput,
            input_hash: inputHash,
            rule_id: match.rule.id,
            reason: match.rule.reason,
            ts: nowIso(),
          });
          emitDeny(formatHoldReason(id, match.rule.reason));
          // A retry of an already-parked action is the same decision, not a
          // new audit event — record the HELD row only the first time.
          if (!existed) {
            recordDecision(cwd, sessionId, toolName, toolInput, match.rule, "HELD", id);
          }
        } catch (e) {
          warn("hold parking failed (denying anyway): " + String(e));
          emitDeny(
            match.rule.reason +
              " [reins hold] Parking for approval failed, so this call is denied outright.",
          );
        }
      } else if (match.rule.action === "ask") {
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
 * Record a gate decision with its provenance (which rule fired, and for holds,
 * which queue entry). The rule id in the summary is the seed of the audit
 * trail: `lastrun` shows not just that a call was stopped, but by which rule.
 *
 * ASKED / HELD / APPROVED rows get a decision-derived hash on purpose: when the
 * real call eventually executes, PostToolUse records it with the true input
 * hash — a gate row sharing that hash would inflate the loop alarm's repeat
 * count. Only DENIED keeps the true hash: an agent repeatedly slamming into
 * the same hard veto *is* a loop worth alarming on.
 */
function recordDecision(
  cwd: string | undefined,
  sessionId: string,
  toolName: string,
  toolInput: unknown,
  rule: GuardRule,
  decision: "DENIED" | "ASKED" | "HELD" | "APPROVED",
  holdId?: string,
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
        `${decision}: ` +
        summarizeToolInput(toolName, toolInput) +
        ` [guard:${rule.id}]` +
        (holdId ? ` [hold:${holdId}]` : ""),
      input_hash:
        decision === "DENIED"
          ? hashToolInput(toolName, toolInput)
          : hashToolInput(decision + ":" + toolName, toolInput),
      // DENIED and HELD are definitive non-executions of this attempt. An
      // ask's resolution is unknown here, and an APPROVED row is a marker —
      // the executed call gets its own PostToolUse row with the real ok.
      ok: decision === "DENIED" || decision === "HELD" ? 0 : null,
      ts: nowIso(),
    });
  } catch (e) {
    warn("capture (" + decision.toLowerCase() + ") failed: " + String(e));
  }
}

function warn(msg: string): void {
  process.stderr.write("[reins] " + msg + "\n");
}
