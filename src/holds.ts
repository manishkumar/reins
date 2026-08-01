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
 *   .reins/decided/<key>.json  a human's answer (approved or denied), consumed
 *                              (rename-then-delete, like steering) the first
 *                              time the agent comes back for that action
 *
 * Files, not SQLite, because a parked action must actually stay parked: the
 * gate has to work on every Node reins supports, including ones where capture
 * is unavailable (Node < 22.5 without better-sqlite3, REINS_NO_SQLITE=1). The
 * DB keeps its role as best-effort audit trail only.
 *
 * A decision is one-shot and keyed to a specific proposal — either the exact
 * deferred call (tool_use_id) or this session's exact input hash. A CHANGED
 * retry is a new proposal, not a pre-approved one. That is the security
 * property; widening it to prefix matches, per-rule blanket allows, or TTLs
 * would be a regression dressed as convenience.
 */

/** How the parked action was held at the boundary.
 *  "defer" — Claude Code kept the tool call itself, unresolved, in its
 *            transcript. Resuming the session replays that exact call through
 *            the hook, so approving runs the ORIGINAL proposal.
 *  "deny"  — the attempt was vetoed and the proposal copied into the queue.
 *            Approving lets an identical retry through; the agent has to make
 *            that retry. The fallback wherever defer is not honored. */
export type HoldTransport = "defer" | "deny";

export interface PendingAction {
  id: string;
  session_id: string;
  tool: string;
  /** The full tool input as proposed — what the approver is signing off on. */
  input: unknown;
  input_hash: string;
  /** Claude Code's id for the parked call. Present for "defer" holds — it is
   *  what makes approval exact instead of a form match. */
  tool_use_id?: string;
  transport: HoldTransport;
  rule_id: string;
  reason: string;
  ts: string;
}

/**
 * A human's answer to a parked action, waiting for the agent to come back for
 * it. Both approvals and refusals are recorded: without a refusal record, a
 * denied action's replay would simply re-match the rule and park all over
 * again, and the human would be asked the same question forever.
 */
export interface HoldDecision {
  action_id: string;
  session_id: string;
  tool: string;
  input_hash: string;
  tool_use_id?: string;
  transport: HoldTransport;
  rule_id: string;
  resolution: "approved" | "denied";
  /** For refusals: what to do instead, echoed to the agent at the boundary. */
  steer?: string;
  decided_ts: string;
}

function pendingDir(payloadCwd?: string): string {
  return path.join(reinsDir(payloadCwd), "pending");
}

/** Decisions awaiting collection by the agent's next attempt (approved AND
 *  refused). Named "decided", not "allowed", because a refusal is a decision
 *  the boundary must also honor exactly once. */
function decidedDir(payloadCwd?: string): string {
  return path.join(reinsDir(payloadCwd), "decided");
}

/** Pre-0.4 one-shot approvals: .reins/allowed/<input_hash>.json. Still read, so
 *  upgrading reins mid-run never strands an approval the human already gave. */
function legacyAllowedDir(payloadCwd?: string): string {
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
    (p) =>
      p.session_id === action.session_id &&
      // A replayed deferred call is literally the same call, id and all. Any
      // other retry is recognized by its form.
      (action.tool_use_id && p.tool_use_id
        ? p.tool_use_id === action.tool_use_id
        : p.input_hash === action.input_hash),
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

/**
 * The key a decision is filed under — and the whole reason defer is better than
 * deny. A deferred call comes back with the SAME tool_use_id, so its approval
 * is keyed to that one call and nothing else can spend it. A denied-and-retried
 * call gets a fresh tool_use_id, so it can only be recognized by its form: the
 * exact input hash, scoped to the session that proposed it (an unscoped hash
 * key let a second session consume the first's approval).
 */
function decisionKey(d: {
  transport: HoldTransport;
  tool_use_id?: string;
  session_id: string;
  input_hash: string;
}): string {
  if (d.transport === "defer" && d.tool_use_id) return "u-" + d.tool_use_id;
  return "h-" + shortHash(d.session_id) + "-" + d.input_hash;
}

function shortHash(s: string): string {
  return crypto.createHash("sha256").update(s).digest("hex").slice(0, 8);
}

/** Record a human's answer for the agent to collect at the boundary. */
export function writeDecision(
  payloadCwd: string | undefined,
  action: PendingAction,
  resolution: "approved" | "denied",
  steer?: string,
): void {
  ensureDir(decidedDir(payloadCwd), payloadCwd);
  const decision: HoldDecision = {
    action_id: action.id,
    session_id: action.session_id,
    tool: action.tool,
    input_hash: action.input_hash,
    tool_use_id: action.tool_use_id,
    transport: action.transport,
    rule_id: action.rule_id,
    resolution,
    ...(steer ? { steer } : {}),
    decided_ts: new Date().toISOString(),
  };
  fs.writeFileSync(
    path.join(decidedDir(payloadCwd), decisionKey(action) + ".json"),
    JSON.stringify(decision, null, 2) + "\n",
  );
}

/**
 * Atomically consume the decision for this attempt, if a human left one.
 * Rename-first (the same trick as steering) so two agents racing on the
 * identical call can't both spend a one-shot answer.
 *
 * Tried in order: this exact deferred call (tool_use_id), then this session's
 * identical proposal (hash), then a pre-0.4 unscoped allowance. First match
 * wins and is consumed.
 */
export function consumeDecision(
  payloadCwd: string | undefined,
  attempt: { tool_use_id?: string; session_id: string; input_hash: string },
): HoldDecision | null {
  const candidates: string[] = [];
  if (attempt.tool_use_id) {
    candidates.push(path.join(decidedDir(payloadCwd), "u-" + attempt.tool_use_id + ".json"));
  }
  candidates.push(
    path.join(
      decidedDir(payloadCwd),
      "h-" + shortHash(attempt.session_id) + "-" + attempt.input_hash + ".json",
    ),
  );
  for (const p of candidates) {
    const taken = takeJson<HoldDecision>(p);
    if (taken) return taken;
  }
  // Legacy: a one-shot approval written by reins < 0.4, keyed by bare hash.
  const legacy = takeJson<{ action_id: string; session_id: string; tool: string; rule_id: string }>(
    path.join(legacyAllowedDir(payloadCwd), attempt.input_hash + ".json"),
  );
  if (legacy) {
    return {
      action_id: legacy.action_id,
      session_id: legacy.session_id,
      tool: legacy.tool,
      input_hash: attempt.input_hash,
      transport: "deny",
      rule_id: legacy.rule_id,
      resolution: "approved",
      decided_ts: new Date().toISOString(),
    };
  }
  return null;
}

/** Consume one JSON file atomically: rename out of the way, then read. */
function takeJson<T>(p: string): T | null {
  const tmp = p + ".consuming." + process.pid;
  try {
    fs.renameSync(p, tmp);
  } catch {
    return null; // nothing filed here
  }
  try {
    return JSON.parse(fs.readFileSync(tmp, "utf8")) as T;
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

/**
 * The same park, addressed to the HUMAN instead of the agent.
 *
 * Not a visibility fix — `permissionDecisionReason` already reaches the user,
 * rendered as the tool's error. A legibility one. That text is sixty words
 * written to redirect a model, with the id and the approve command buried
 * mid-sentence; scanning it is work, and the person watching a run is doing
 * something else. This is the same fact as one scannable line, in the one field
 * (`systemMessage`) Claude Code shows the user and not the model.
 *
 * The tool name is deliberately absent: Claude Code prefixes the line with its
 * own attribution (`PreToolUse:Bash says:`), so repeating it here just pushes
 * the command — the part you actually read — further right.
 *
 * Deliberately short: it is a notification, not a report. `reins pending` is
 * still where the full proposal lives, and the Stop summary still catches the
 * person who walked away.
 */
export function formatHoldNotice(id: string, tool: string, input: unknown): string {
  const { summarizeToolInput, truncate } = require("./util") as typeof import("./util");
  let what = tool;
  try {
    what = truncate(summarizeToolInput(tool, input), 60);
  } catch {
    /* a summary is a nicety; the id and the command to run are the point */
  }
  return `[reins] ⏸ HELD  ${what}\n  approve: reins approve ${id}   ·   see all: reins pending`;
}

/**
 * The reason attached to a deferred hold. Unlike the deny reason above, this is
 * not a redirection: on defer the turn ends with the call still pending, so
 * there is no agent left mid-run to send elsewhere. It is written for the human
 * reading `reins pending` and the transcript afterwards.
 */
export function formatDeferReason(id: string, ruleReason: string): string {
  return (
    ruleReason +
    ` [reins hold] Parked for approval (id ${id}). The tool call is preserved as-is; ` +
    `\`reins approve ${id}\` then resuming the session runs this exact call.`
  );
}

/**
 * What the agent is told when it comes back for an action a human refused. It
 * carries the refusal (so the model stops proposing it) plus any alternative
 * the human supplied — this is the gate's reply channel, delivered at the
 * boundary rather than left to a steer that may never be consumed.
 */
export function formatRefusalReason(id: string, ruleReason: string, steer?: string): string {
  return (
    ruleReason +
    ` [reins hold] The developer refused this action (id ${id}); do not propose it again.` +
    (steer ? ` Instead: ${steer}` : "")
  );
}
