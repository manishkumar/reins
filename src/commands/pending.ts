import {
  listPending,
  findPending,
  removePending,
  writeAllowance,
  PendingAction,
} from "../holds";
import { appendSteering } from "../steering";
import { summarizeToolInput, truncate, nowIso } from "../util";
import { c } from "./format";

/** `reins pending` — the review queue: every action a hold rule parked. */
export function cmdPending(): number {
  const pending = listPending();
  if (pending.length === 0) {
    console.log(c.dim("No actions awaiting approval."));
    return 0;
  }
  console.log(c.bold("Pending actions") + c.dim(" — parked by hold rules, awaiting your decision"));
  console.log("");
  for (const p of pending) {
    console.log(
      `  ${c.cyan(p.id)}  ${c.dim(age(p.ts).padEnd(8))} ${c.dim(shortId(p.session_id).padEnd(9))}` +
        ` ${p.tool.padEnd(8)} ${truncate(summarizeToolInput(p.tool, p.input), 70)}` +
        ` ${c.dim(`[${p.rule_id}]`)}`,
    );
  }
  console.log("");
  console.log(
    c.dim("Approve one: ") +
      "reins approve <id>" +
      c.dim("   Refuse one: ") +
      'reins deny <id> [--steer "do this instead"]',
  );
  return 0;
}

/**
 * `reins approve <id>` — sign off on a parked action. Writes the one-shot
 * allowance keyed on the action's exact input hash, then steers the session:
 * next time the agent attempts the identical call, the guard lets it through
 * (once). A changed retry is a new proposal — that's the design, not a gap.
 */
export function cmdApprove(args: string[]): number {
  const found = resolveId(args[0], "approve");
  if (!found) return 1;

  writeAllowance(undefined, found);
  removePending(undefined, found.id);

  const summary = summarizeToolInput(found.tool, found.input);
  // The reply channel: a targeted steer tells the (possibly still running)
  // session its parked action is cleared. If the run already ended, the
  // allowance still stands — the next run to attempt the identical call
  // passes. Steering delivery is best-effort here; the allowance is the gate.
  try {
    appendSteering(
      `Your parked action ${found.id} (${found.tool}: ${truncate(summary, 120)}) is approved — ` +
        `retry that exact call now, then continue.`,
      undefined,
      found.session_id,
    );
  } catch {
    /* session steering is a courtesy; the allowance is what matters */
  }

  console.log(c.green(`✓ Approved ${c.bold(found.id)}`) + c.dim(` (${found.tool}: ${truncate(summary, 80)})`));
  console.log(
    c.dim("  One-shot: the next attempt of this ") +
      c.dim(c.bold("exact")) +
      c.dim(" call passes, then the rule holds again. The session was steered to retry."),
  );
  return 0;
}

/**
 * `reins deny <id> [--steer "..."]` — refuse a parked action. Removes it from
 * the queue; optionally queues an alternative instruction as steering (this is
 * where steer becomes the gate's reply channel).
 */
export function cmdDeny(args: string[]): number {
  const steerIdx = args.findIndex((a) => a === "--steer");
  let steerMsg = "";
  if (steerIdx >= 0) {
    steerMsg = args.slice(steerIdx + 1).join(" ").trim();
    args = args.slice(0, steerIdx);
  }
  const found = resolveId(args[0], "deny");
  if (!found) return 1;

  removePending(undefined, found.id);
  recordRejection(found);

  const summary = summarizeToolInput(found.tool, found.input);
  if (steerMsg) {
    try {
      appendSteering(
        `Your parked action ${found.id} (${found.tool}: ${truncate(summary, 120)}) was refused. ` +
          `Instead: ${steerMsg}`,
        undefined,
        found.session_id,
      );
    } catch {
      /* best-effort */
    }
  }

  console.log(c.red(`✗ Refused ${c.bold(found.id)}`) + c.dim(` (${found.tool}: ${truncate(summary, 80)})`));
  if (steerMsg) console.log(c.dim(`  Steered the session instead: "${truncate(steerMsg, 90)}"`));
  else console.log(c.dim('  (No steering queued. Add --steer "..." to tell the agent what to do instead.)'));
  return 0;
}

/** Resolve an id/prefix to exactly one pending action, explaining any miss. */
function resolveId(idArg: string | undefined, verb: string): PendingAction | null {
  if (!idArg) {
    console.error(c.red(`Usage: reins ${verb} <id>   (ids via: reins pending)`));
    return null;
  }
  const matches = findPending(undefined, idArg);
  if (matches.length === 0) {
    console.error(c.red(`No pending action matches "${idArg}".`) + c.dim("  (reins pending lists the queue)"));
    return null;
  }
  if (matches.length > 1) {
    console.error(c.red(`"${idArg}" is ambiguous — matches:`));
    for (const m of matches) {
      console.error(`  ${c.cyan(m.id)}  ${m.tool}  ${truncate(summarizeToolInput(m.tool, m.input), 60)}`);
    }
    return null;
  }
  return matches[0];
}

/**
 * Best-effort audit row for a human refusal. The queue file is gone after this,
 * so without the row the trajectory would show a HELD that silently vanished.
 */
function recordRejection(p: PendingAction): void {
  try {
    const {
      openDb,
      upsertSessionStart,
      insertToolCall,
    } = require("../db") as typeof import("../db");
    const db = openDb();
    if (!db) return;
    const { hashToolInput } = require("../util") as typeof import("../util");
    const { resolveProjectDir } = require("../paths") as typeof import("../paths");
    upsertSessionStart(db, p.session_id, resolveProjectDir(), nowIso());
    insertToolCall(db, {
      session_id: p.session_id,
      tool: p.tool,
      input_summary:
        `REFUSED: ` +
        summarizeToolInput(p.tool, p.input) +
        ` [guard:${p.rule_id}] [hold:${p.id}]`,
      input_hash: hashToolInput("REFUSED:" + p.tool, p.input),
      ok: 0,
      ts: nowIso(),
    });
  } catch {
    /* audit is best-effort; the refusal itself already happened (file removed) */
  }
}

function shortId(id: string): string {
  return id.length > 8 ? id.slice(0, 8) : id;
}

function age(tsIso: string): string {
  const ms = Date.now() - new Date(tsIso).getTime();
  if (!isFinite(ms) || ms < 0) return "?";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}
