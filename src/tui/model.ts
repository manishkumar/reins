import * as path from "node:path";
import type { SqlDb } from "../store";
import { hasSessionNameColumn, hasSessionTranscriptColumn, listSessionCalls } from "../db";
import { checkClaim, type Claim } from "../claim";
import { footprint, type Footprint } from "../footprint";
import { faceReader, sessionFace, type SessionFace } from "../sessionFace";
import { listPending, proposalWorkdir, type PendingAction } from "../holds";
import { supersededDeferIds } from "../holdActions";
import { collectAttention, describeInput, type AttentionEvent } from "../attention";
import { peekSteering } from "../steering";

/**
 * One frame's worth of state for `reins watch`, gathered read-only.
 *
 * Holds and steering come from plain files and are always present. Agents and
 * their trajectories come from runs.db and are absent without capture; the
 * cockpit still works as an approval queue then (invariant 4: no decision
 * depends on the DB, and neither does the way a human makes one).
 */

/** Activity newer than this counts as "active". */
export const ACTIVE_WINDOW_MS = 30_000;
/** Sparkline: this many buckets of this width, ending now. */
export const SPARK_BUCKETS = 24;
export const SPARK_BUCKET_MS = 30_000;

export type CallKind = "ok" | "failed" | "denied" | "asked" | "held" | "approved" | "refused";

export interface CallView {
  tool: string;
  summary: string;
  kind: CallKind;
  ruleId: string | null;
  tsMs: number | null;
  /** How many identical calls in a row end here (1 = not a repeat). */
  streak: number;
}

export type Liveness = "active" | "looping" | "idle" | "done";

export interface AgentView extends SessionFace {
  id: string;
  ended: boolean;
  outcome: string | null;
  calls: number;
  startedMs: number | null;
  lastTsMs: number | null;
  /** Consecutive identical calls at the tail, as the loop alarm counts them. */
  streak: number;
  steerQueued: string | null;
  /** Calls per SPARK_BUCKET_MS over the last SPARK_BUCKETS buckets. */
  spark: number[];
  /** Newest last. Deep for the selected agent, a short tail for the rest. */
  trajectory: CallView[];
  holds: number;
  /** What the session's own calls say about its work being done (src/claim.ts). */
  claim: Claim;
  /** What it edited and ran, to read beside what it was asked (src/footprint.ts). */
  footprint: Footprint;
}

export interface HoldView {
  action: PendingAction;
  sessionName: string;
  /** As AgentView.label, for the session that proposed the action. */
  sessionLabel: string;
  asked: string | null;
  /** The full proposed input, as the approver will read it. */
  input: string;
  /** Working directory relative to the project, "" for the root. */
  where: string;
  /** A deferred hold displaced by a newer one in the same session. */
  superseded: boolean;
}

export interface WatchModel {
  repo: string;
  nowMs: number;
  threshold: number;
  captured: boolean;
  holds: HoldView[];
  events: AttentionEvent[];
  olderEvents: number;
  agents: AgentView[];
  broadcast: string | null;
}

export interface BuildOpts {
  nowMs?: number;
  limit?: number;
  /** The agent whose trajectory the detail pane shows. */
  focusId?: string | null;
  deep?: number;
}

const TAGGED = /^(DENIED|ASKED|HELD|APPROVED|REFUSED): (.*?)(?: \[guard:([^\]]+)\])?(?: \[hold:[^\]]+\])?$/;

export function buildWatchModel(db: SqlDb | null, repo: string, threshold: number, o: BuildOpts = {}): WatchModel {
  const nowMs = o.nowMs ?? Date.now();
  const recent = db ? readAgents(db, proposalWorkdir(repo), threshold, nowMs, o) : [];
  // A looping agent is listed first: on a short terminal the list is cut, and
  // the header's "1 looping" must have a row to point at. The rest stay newest
  // first. The cockpit keeps its cursor by id, so a row that moves takes the
  // selection with it.
  const isLooping = (a: AgentView) => liveness(a, nowMs, threshold) === "looping";
  const agents = [...recent.filter(isLooping), ...recent.filter((a) => !isLooping(a))];
  const known = new Map<string, SessionFace>(agents.map((a) => [a.id, a]));
  const lookup = faceReader(db);
  const faceOf = (id: string): SessionFace => known.get(id) ?? lookup(id);

  const pending = listPending(repo);
  const superseded = supersededDeferIds(pending);
  const root = proposalWorkdir(repo);
  const holds: HoldView[] = pending.map((p) => ({
    action: p,
    sessionName: faceOf(p.session_id).name,
    sessionLabel: faceOf(p.session_id).label,
    asked: faceOf(p.session_id).asked,
    input: describeInput(p),
    where: whereLabel(root, p.cwd),
    superseded: superseded.has(p.id),
  }));
  for (const a of agents) a.holds = pending.filter((p) => p.session_id === a.id).length;

  const att = collectAttention(repo, db, new Date(nowMs));

  let broadcast: string | null = null;
  try {
    broadcast = peekSteering(repo);
  } catch {
    /* unreadable steering file: show nothing rather than fail the frame */
  }

  return {
    repo,
    nowMs,
    threshold,
    captured: !!db,
    holds,
    events: att.events,
    olderEvents: att.olderEvents,
    agents,
    broadcast,
  };
}

function readAgents(db: SqlDb, root: string, threshold: number, nowMs: number, o: BuildOpts): AgentView[] {
  const out: AgentView[] = [];
  try {
    const hasName = hasSessionNameColumn(db);
    const hasTranscript = hasSessionTranscriptColumn(db);
    const rows = db
      .prepare(
        `SELECT s.id, ${hasName ? "s.name, " : ""}${hasTranscript ? "s.transcript, " : ""}s.ended, s.final_outcome, s.started,
                COUNT(t.seq) AS calls, MAX(t.ts) AS last_ts
           FROM sessions s
           LEFT JOIN tool_calls t ON t.session_id = s.id
          GROUP BY s.id
          ORDER BY COALESCE(MAX(t.ts), s.started) DESC
          LIMIT ?`,
      )
      .all(o.limit ?? 12) as Array<{
      id: string;
      name?: string | null;
      transcript?: string | null;
      ended: string | null;
      final_outcome: string | null;
      started: string | null;
      calls: number;
      last_ts: string | null;
    }>;

    const sparkFrom = new Date(nowMs - SPARK_BUCKETS * SPARK_BUCKET_MS).toISOString();
    for (const r of rows) {
      const depth = r.id === o.focusId ? (o.deep ?? 80) : Math.max(threshold, 4);
      const callRows = (
        db
          .prepare(
            `SELECT tool, input_summary, input_hash, ok, ts FROM tool_calls
              WHERE session_id = ? ORDER BY seq DESC LIMIT ?`,
          )
          .all(r.id, depth) as Array<{ tool: string; input_summary: string; input_hash: string; ok: number | null; ts: string }>
      ).reverse();

      const trajectory: CallView[] = [];
      let prevHash: string | null = null;
      let run = 0;
      for (const cr of callRows) {
        run = cr.input_hash === prevHash ? run + 1 : 1;
        prevHash = cr.input_hash;
        trajectory.push(toCall(cr, run));
      }

      const spark = new Array<number>(SPARK_BUCKETS).fill(0);
      const tsRows = db
        .prepare(`SELECT ts FROM tool_calls WHERE session_id = ? AND ts >= ?`)
        .all(r.id, sparkFrom) as Array<{ ts: string }>;
      for (const t of tsRows) {
        const age = nowMs - Date.parse(t.ts);
        if (!(age >= 0)) continue;
        const b = SPARK_BUCKETS - 1 - Math.floor(age / SPARK_BUCKET_MS);
        if (b >= 0 && b < SPARK_BUCKETS) spark[b]++;
      }

      const last = r.last_ts || r.started;
      out.push({
        id: r.id,
        ...sessionFace(r.id, r.name, r.transcript),
        ended: !!r.ended,
        outcome: r.final_outcome,
        calls: r.calls,
        startedMs: parse(r.started),
        lastTsMs: parse(last),
        streak: trajectory.length ? trajectory[trajectory.length - 1].streak : 0,
        steerQueued: safePeek(r.id),
        spark,
        trajectory,
        holds: 0,
        ...factsOf(db, r.id, r.calls, root),
      });
    }
  } catch {
    /* DB momentarily locked by a writer: render what we have */
  }
  return out;
}

/** A session's verdict and footprint change only when it makes a call, so they are computed once per call count. */
const facts = new Map<string, { calls: number; claim: Claim; footprint: Footprint }>();

function factsOf(db: SqlDb, id: string, calls: number, root: string): { claim: Claim; footprint: Footprint } {
  const hit = facts.get(id);
  if (hit && hit.calls === calls) return hit;
  const rows = listSessionCalls(db, id);
  const next = { calls, claim: checkClaim(rows), footprint: footprint(rows, root) };
  facts.set(id, next);
  return next;
}

function toCall(
  cr: { tool: string; input_summary: string; ok: number | null; ts: string },
  streak: number,
): CallView {
  const m = cr.input_summary.match(TAGGED);
  let kind: CallKind = cr.ok === 0 ? "failed" : "ok";
  let summary = cr.input_summary;
  let ruleId: string | null = null;
  if (m) {
    kind = m[1].toLowerCase() as CallKind;
    summary = m[2];
    ruleId = m[3] ?? null;
  }
  return { tool: cr.tool, summary, kind, ruleId, tsMs: parse(cr.ts), streak };
}

/**
 * Where an agent stands. Liveness comes from recent tool activity, not the
 * `ended` flag: Claude Code fires Stop at every turn boundary, so a live
 * interactive session reads as ended between turns.
 */
export function liveness(a: AgentView, nowMs: number, threshold: number): Liveness {
  const age = a.lastTsMs != null ? nowMs - a.lastTsMs : Infinity;
  const looping = a.streak >= threshold;
  if (age < ACTIVE_WINDOW_MS) return looping ? "looping" : "active";
  if (a.ended) return "done";
  return looping ? "looping" : "idle";
}

function whereLabel(root: string, cwd: string | undefined): string {
  if (!cwd) return "";
  const rel = path.relative(root, cwd);
  if (rel === "") return "";
  if (rel.startsWith("..") || path.isAbsolute(rel)) return cwd;
  return rel + path.sep;
}

function safePeek(id: string): string | null {
  try {
    return peekSteering(undefined, id);
  } catch {
    return null;
  }
}

function parse(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}
