import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { reinsDir, ensureReinsDir } from "./paths";

/**
 * The hold queue: guard rules with action "hold" park a proposed action here
 * instead of vetoing it, so an unattended run survives the boundary and a human
 * approves or denies later (`reins pending` / `approve` / `deny`).
 *
 * State is plain JSON files, deliberately — not rows in runs.db:
 *   .reins/pending/<id>.json   one parked action awaiting a decision
 *   .reins/allowed/<hash>.json one-shot allowance, keyed by the action's exact
 *                              input hash; consumed (rename-then-delete, like
 *                              steering) the first time the identical call is
 *                              attempted again
 *
 * Files, not SQLite, because a parked action must actually stay parked: the
 * gate has to work on every Node reins supports, including ones where capture
 * is unavailable (Node < 22.5 without better-sqlite3, REINS_NO_SQLITE=1). The
 * DB keeps its role as best-effort audit trail only.
 *
 * Approval is by EXACT input hash on purpose: a changed retry is a new
 * proposal, not a pre-approved one.
 */

export interface PendingAction {
  id: string;
  session_id: string;
  tool: string;
  /** The full tool input as proposed — what the approver is signing off on. */
  input: unknown;
  input_hash: string;
  rule_id: string;
  reason: string;
  ts: string;
}

export interface Allowance {
  action_id: string;
  session_id: string;
  tool: string;
  input_hash: string;
  rule_id: string;
  approved_ts: string;
}

function pendingDir(payloadCwd?: string): string {
  return path.join(reinsDir(payloadCwd), "pending");
}

function allowedDir(payloadCwd?: string): string {
  return path.join(reinsDir(payloadCwd), "allowed");
}

/** 0700 like .reins itself: a pending action's input can contain secrets. */
function ensureDir(dir: string, payloadCwd?: string): void {
  ensureReinsDir(payloadCwd);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}

/**
 * Park a proposed action. If this session already has the identical proposal
 * parked (same input hash), return the existing entry instead of duplicating —
 * an agent retrying a held call is asking about the same decision, not filing
 * a new one.
 */
export function parkAction(
  payloadCwd: string | undefined,
  action: Omit<PendingAction, "id">,
): { id: string; existed: boolean } {
  const existing = listPending(payloadCwd).find(
    (p) => p.session_id === action.session_id && p.input_hash === action.input_hash,
  );
  if (existing) return { id: existing.id, existed: true };
  const id = crypto.randomBytes(4).toString("hex");
  ensureDir(pendingDir(payloadCwd), payloadCwd);
  fs.writeFileSync(
    path.join(pendingDir(payloadCwd), id + ".json"),
    JSON.stringify({ id, ...action }, null, 2) + "\n",
  );
  return { id, existed: false };
}

/** All parked actions, oldest first (the queue order a reviewer works in). */
export function listPending(payloadCwd?: string): PendingAction[] {
  let files: string[];
  try {
    files = fs.readdirSync(pendingDir(payloadCwd)).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  const out: PendingAction[] = [];
  for (const f of files) {
    try {
      const parsed = JSON.parse(
        fs.readFileSync(path.join(pendingDir(payloadCwd), f), "utf8"),
      ) as PendingAction;
      if (parsed && parsed.id && parsed.input_hash) out.push(parsed);
    } catch {
      /* skip unreadable/corrupt entries rather than break the queue */
    }
  }
  return out.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
}

/** Parked actions belonging to one session (for lastrun/sessions/stop). */
export function pendingForSession(payloadCwd: string | undefined, sessionId: string): PendingAction[] {
  return listPending(payloadCwd).filter((p) => p.session_id === sessionId);
}

/**
 * Resolve an id or unique prefix to parked actions. Returns every match so the
 * caller can tell "not found" (0) from "ambiguous" (>1) and say so.
 */
export function findPending(payloadCwd: string | undefined, idPrefix: string): PendingAction[] {
  return listPending(payloadCwd).filter((p) => p.id.startsWith(idPrefix));
}

export function removePending(payloadCwd: string | undefined, id: string): void {
  try {
    fs.rmSync(path.join(pendingDir(payloadCwd), id + ".json"));
  } catch {
    /* already gone */
  }
}

/** Write the one-shot allowance for a parked action (the "approve" half). */
export function writeAllowance(payloadCwd: string | undefined, action: PendingAction): void {
  ensureDir(allowedDir(payloadCwd), payloadCwd);
  const allowance: Allowance = {
    action_id: action.id,
    session_id: action.session_id,
    tool: action.tool,
    input_hash: action.input_hash,
    rule_id: action.rule_id,
    approved_ts: new Date().toISOString(),
  };
  fs.writeFileSync(
    path.join(allowedDir(payloadCwd), action.input_hash + ".json"),
    JSON.stringify(allowance, null, 2) + "\n",
  );
}

/**
 * Atomically consume the allowance for this exact input hash, if one exists.
 * Rename-first (same trick as steering) so two agents racing on the identical
 * call can't both spend a one-shot approval.
 */
export function consumeAllowance(
  payloadCwd: string | undefined,
  inputHash: string,
): Allowance | null {
  const p = path.join(allowedDir(payloadCwd), inputHash + ".json");
  const tmp = p + ".consuming." + process.pid;
  try {
    fs.renameSync(p, tmp);
  } catch {
    return null; // no allowance for this hash
  }
  try {
    return JSON.parse(fs.readFileSync(tmp, "utf8")) as Allowance;
  } catch {
    return null;
  } finally {
    try {
      fs.rmSync(tmp);
    } catch {
      /* ignore */
    }
  }
}

/**
 * The deny reason the agent sees when its action is parked. Load-bearing
 * framing, like the steering text: it must (a) carry the human-set rule reason,
 * (b) hand over the id so the run's report mentions it, and (c) redirect the
 * agent to other work instead of leaving it to die against a wall or hammer
 * the same call.
 */
export function formatHoldReason(id: string, ruleReason: string): string {
  return (
    ruleReason +
    ` [reins hold] This action is parked for approval (id ${id}) — it will not run ` +
    `until the developer approves it (\`reins approve ${id}\`). Do not retry it now: ` +
    `continue with work that does not depend on it, and mention the parked action ` +
    `(with its id) when you report back. If nothing else remains, finish and note it.`
  );
}
