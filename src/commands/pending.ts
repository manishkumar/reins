import * as path from "node:path";
import { resolveProjectDir } from "../paths";
import { listPending, findPending, PendingAction, proposalWorkdir } from "../holds";
import { approveHold, denyHold, supersededDeferIds } from "../holdActions";
import { summarizeToolInput, truncate } from "../util";
import { openDbReadOnly } from "../db";
import { aboutOf, faceReader, headOf, shortId } from "../sessionFace";
import { c } from "./format";

/** `reins pending` — the review queue: every action a hold rule parked. */
export function cmdPending(): number {
  const pending = listPending();
  if (pending.length === 0) {
    console.log(c.dim("No actions awaiting approval."));
    return 0;
  }
  // Claude Code replays only the most recently deferred call when a session
  // resumes; an earlier one it superseded is abandoned there. Approving such an
  // entry still files the decision, but nothing will come back for it in that
  // session — so say so plainly instead of letting the human believe otherwise.
  const superseded = supersededDeferIds(pending);

  // Which session asked, in words. Best-effort: the queue itself is plain
  // files and lists without the DB, with mnemonics.
  let db: ReturnType<typeof openDbReadOnly> = null;
  try {
    db = openDbReadOnly();
  } catch {
    /* capture unavailable */
  }
  const faceOf = faceReader(db);

  console.log(c.bold("Pending actions") + c.dim(" — parked by hold rules, awaiting your decision"));
  console.log("");
  for (const p of pending) {
    const mark =
      p.transport !== "defer"
        ? ""
        : superseded.has(p.id)
          ? c.dim(" ⏸ superseded")
          : c.dim(" ⏸ in session");
    console.log(
      `  ${c.cyan(p.id)}  ${c.dim(age(p.ts).padEnd(8))} ${c.dim(shortId(p.session_id).padEnd(9))}` +
        ` ${p.tool.padEnd(8)} ${truncate(summarizeToolInput(p.tool, p.input), 70)}` +
        ` ${c.dim(`[${p.rule_id}]`)}${mark}`,
    );
    // The directory is part of what gets approved, so the approver sees it
    // whenever it isn't simply the project root.
    const where = workdirLabel(p.cwd);
    if (where) console.log(`            ${c.dim("in " + where)}`);
    const face = faceOf(p.session_id);
    const about = aboutOf(face, p.session_id);
    console.log(`            ${c.dim("from " + headOf(face, p.session_id) + (about ? " · " + about : ""))}`);
  }
  console.log("");
  console.log(
    c.dim("Approve one: ") +
      "reins approve <id>" +
      c.dim("   Refuse one: ") +
      'reins deny <id> [--steer "do this instead"]',
  );
  if (superseded.size > 0) {
    console.log(
      c.dim(
        `  ⏸ superseded: the session parked a newer call after this one; only the newest is\n` +
          `    replayed on resume. Approving it takes effect only if the agent proposes it again.`,
      ),
    );
  }
  return 0;
}

/** Where a proposal was made, relative to the project when it is inside it.
 *  Empty for the project root itself, and for entries that predate the field. */
function workdirLabel(cwd: string | undefined): string {
  if (!cwd) return "";
  const rel = path.relative(proposalWorkdir(resolveProjectDir()), cwd);
  if (rel === "") return "";
  if (rel.startsWith("..") || path.isAbsolute(rel)) return cwd;
  return rel + path.sep;
}

/**
 * `reins approve <id>` — sign off on a parked action. Files a one-shot decision
 * the boundary collects the next time the agent comes back for that action.
 *
 * What "comes back" means depends on how the action was held. A deferred hold
 * is replayed by Claude Code itself when the session resumes, so approval binds
 * to that exact call. A denied hold has to be re-proposed by the agent, so
 * approval binds to the identical input — a changed retry is a new proposal,
 * which is the design and not a gap.
 */
export function cmdApprove(args: string[]): number {
  const found = resolveId(args[0], "approve");
  if (!found) return 1;

  const done = approveHold(found, "human-cli");
  console.log(c.green(`✓ Approved ${c.bold(done.id)}`) + c.dim(` (${done.tool}: ${truncate(done.summary, 80)})`));
  if (done.resume) {
    // The call is parked inside Claude Code's own transcript; nothing runs
    // until that session is resumed. Say so, and hand over the exact command —
    // an approval the human thinks landed but that nobody resumes is the
    // quietest possible failure.
    console.log(c.dim("  The original call is parked in the session. Resume it to run:") + "\n    " + c.cyan(done.resume));
  } else {
    console.log(
      c.dim("  One-shot: the next attempt of this ") +
        c.dim(c.bold("exact")) +
        c.dim(" call passes, then the rule holds again. The session was steered to retry."),
    );
  }
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

  const done = denyHold(found, steerMsg || undefined, "human-cli");
  console.log(c.red(`✗ Refused ${c.bold(done.id)}`) + c.dim(` (${done.tool}: ${truncate(done.summary, 80)})`));
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
