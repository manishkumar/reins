import { findPending, listPending, removePending, writeDecision, PendingAction } from "./holds";
import { appendSteering } from "./steering";
import { summarizeToolInput, truncate, nowIso } from "./util";

/**
 * Approving and refusing a parked action, as data in and data out.
 *
 * `reins approve` / `reins deny` and the `reins watch` cockpit both resolve
 * holds, and they must do it identically: one code path means the TUI cannot
 * grow a looser notion of what an approval clears (invariant 7). Nothing here
 * prints; callers decide how to say what happened.
 */

export interface HoldOutcome {
  id: string;
  tool: string;
  summary: string;
  sessionId: string;
  transport: PendingAction["transport"];
  /** For a deferred hold: the command that resumes the session so the call runs. */
  resume?: string;
  /** Whether a reply was queued as steering for the session. */
  steered: boolean;
}

/** Who resolved a hold, recorded in the decisions row for `reins audit`. */
export type Resolver = "human-cli" | "human-tui";

/**
 * File a one-shot approval for exactly this parked action. The boundary
 * collects it the next time the agent comes back for the same call.
 */
export function approveHold(p: PendingAction, resolver: Resolver): HoldOutcome {
  writeDecision(undefined, p, "approved");
  removePending(undefined, p.id);
  resolveHoldRow(p.id, "approved", resolver);

  const summary = summarizeToolInput(p.tool, p.input);
  // The reply channel: a targeted steer tells the (possibly still running)
  // session its parked action is cleared. If the run already ended, the
  // decision still stands — it waits at the boundary. Steering delivery is
  // best-effort here; the filed decision is the gate.
  let steered = false;
  try {
    appendSteering(
      `Your parked action ${p.id} (${p.tool}: ${truncate(summary, 120)}) is approved — ` +
        `retry that exact call now, from the same working directory, then continue.`,
      undefined,
      p.session_id,
    );
    steered = true;
  } catch {
    /* session steering is a courtesy; the decision is what matters */
  }
  return {
    id: p.id,
    tool: p.tool,
    summary,
    sessionId: p.session_id,
    transport: p.transport,
    resume: p.transport === "defer" ? `claude --resume ${p.session_id} -p "continue"` : undefined,
    steered,
  };
}

/**
 * File a refusal, optionally with what to do instead. The refusal is recorded,
 * not just dropped: a deferred call is replayed at the boundary, and without a
 * recorded answer it would re-park and ask the same question forever.
 */
export function denyHold(p: PendingAction, steer: string | undefined, resolver: Resolver): HoldOutcome {
  const instead = steer?.trim() || undefined;
  writeDecision(undefined, p, "denied", instead);
  removePending(undefined, p.id);
  recordRejection(p);
  resolveHoldRow(p.id, "denied", resolver);

  const summary = summarizeToolInput(p.tool, p.input);
  let steered = false;
  if (instead) {
    try {
      appendSteering(
        `Your parked action ${p.id} (${p.tool}: ${truncate(summary, 120)}) was refused. ` +
          `Instead: ${instead}`,
        undefined,
        p.session_id,
      );
      steered = true;
    } catch {
      /* best-effort */
    }
  }
  return { id: p.id, tool: p.tool, summary, sessionId: p.session_id, transport: p.transport, steered };
}

/**
 * Re-read a parked action at the moment of decision and confirm it is the one
 * the human reviewed. A screen can be stale: the action may have been resolved
 * from another terminal, or (in principle) rewritten. Approving whatever now
 * sits under that id would sign off on something nobody looked at.
 */
export function reloadForDecision(
  id: string,
  reviewed: Pick<PendingAction, "input_hash" | "tool_use_id" | "cwd">,
): { ok: true; action: PendingAction } | { ok: false; reason: "gone" | "changed" } {
  const current = findPending(undefined, id).find((p) => p.id === id);
  if (!current) return { ok: false, reason: "gone" };
  if (
    current.input_hash !== reviewed.input_hash ||
    (current.tool_use_id ?? "") !== (reviewed.tool_use_id ?? "") ||
    (current.cwd ?? "") !== (reviewed.cwd ?? "")
  ) {
    return { ok: false, reason: "changed" };
  }
  return { ok: true, action: current };
}

/**
 * Ids of deferred holds that a later deferred hold in the same session has
 * displaced. Claude Code replays only the newest on resume, so approving an
 * older one takes effect only if the agent proposes it again.
 */
export function supersededDeferIds(pending: PendingAction[] = listPending()): Set<string> {
  const newest = new Map<string, PendingAction>();
  for (const p of pending) {
    if (p.transport !== "defer") continue;
    const cur = newest.get(p.session_id);
    if (!cur || cur.ts < p.ts) newest.set(p.session_id, p);
  }
  const out = new Set<string>();
  for (const p of pending) {
    if (p.transport !== "defer") continue;
    if (newest.get(p.session_id)?.id !== p.id) out.add(p.id);
  }
  return out;
}

/**
 * Best-effort audit row for a human refusal. The queue file is gone after this,
 * so without the row the trajectory would show a HELD that silently vanished.
 */
function recordRejection(p: PendingAction): void {
  try {
    const { openDb, upsertSessionStart, insertToolCall } = require("./db") as typeof import("./db");
    const db = openDb();
    if (!db) return;
    const { hashToolInput } = require("./util") as typeof import("./util");
    const { resolveProjectDir } = require("./paths") as typeof import("./paths");
    upsertSessionStart(db, p.session_id, resolveProjectDir(), nowIso());
    insertToolCall(db, {
      session_id: p.session_id,
      tool: p.tool,
      input_summary:
        `REFUSED: ` + summarizeToolInput(p.tool, p.input) + ` [guard:${p.rule_id}] [hold:${p.id}]`,
      input_hash: hashToolInput("REFUSED:" + p.tool, p.input),
      ok: 0,
      ts: nowIso(),
    });
  } catch {
    /* audit is best-effort; the refusal itself already happened (file removed) */
  }
}

/**
 * Close the loop on the decisions row this hold parked, so `reins audit`
 * shows how a held action was resolved, not just that it was held. Best-effort
 * like recordRejection: the approve/deny itself already happened via the
 * pending-queue file, so a capture failure here changes nothing about that.
 */
function resolveHoldRow(id: string, resolution: "approved" | "denied", resolver: Resolver): void {
  try {
    const { openDb, resolveDecision } = require("./db") as typeof import("./db");
    const db = openDb();
    if (!db) return;
    resolveDecision(db, { hold_id: id, resolution, resolver, resolved_ts: nowIso() });
  } catch {
    /* audit is best-effort; the approve/deny already happened */
  }
}
