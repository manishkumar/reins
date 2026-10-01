"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.SPARK_BUCKET_MS = exports.SPARK_BUCKETS = exports.ACTIVE_WINDOW_MS = void 0;
exports.buildWatchModel = buildWatchModel;
exports.liveness = liveness;
const path = __importStar(require("node:path"));
const db_1 = require("../db");
const claim_1 = require("../claim");
const footprint_1 = require("../footprint");
const sessionFace_1 = require("../sessionFace");
const holds_1 = require("../holds");
const holdActions_1 = require("../holdActions");
const attention_1 = require("../attention");
const steering_1 = require("../steering");
/**
 * One frame's worth of state for `reins watch`, gathered read-only.
 *
 * Holds and steering come from plain files and are always present. Agents and
 * their trajectories come from runs.db and are absent without capture; the
 * cockpit still works as an approval queue then (invariant 4: no decision
 * depends on the DB, and neither does the way a human makes one).
 */
/** Activity newer than this counts as "active". */
exports.ACTIVE_WINDOW_MS = 30_000;
/** Sparkline: this many buckets of this width, ending now. */
exports.SPARK_BUCKETS = 24;
exports.SPARK_BUCKET_MS = 30_000;
const TAGGED = /^(DENIED|ASKED|HELD|APPROVED|REFUSED): (.*?)(?: \[guard:([^\]]+)\])?(?: \[hold:[^\]]+\])?$/;
function buildWatchModel(db, repo, threshold, o = {}) {
    const nowMs = o.nowMs ?? Date.now();
    const recent = db ? readAgents(db, (0, holds_1.proposalWorkdir)(repo), threshold, nowMs, o) : [];
    // A looping agent is listed first: on a short terminal the list is cut, and
    // the header's "1 looping" must have a row to point at. The rest stay newest
    // first. The cockpit keeps its cursor by id, so a row that moves takes the
    // selection with it.
    const isLooping = (a) => liveness(a, nowMs, threshold) === "looping";
    const agents = [...recent.filter(isLooping), ...recent.filter((a) => !isLooping(a))];
    const known = new Map(agents.map((a) => [a.id, a]));
    const lookup = (0, sessionFace_1.faceReader)(db);
    const faceOf = (id) => known.get(id) ?? lookup(id);
    const pending = (0, holds_1.listPending)(repo);
    const superseded = (0, holdActions_1.supersededDeferIds)(pending);
    const root = (0, holds_1.proposalWorkdir)(repo);
    const holds = pending.map((p) => ({
        action: p,
        sessionName: faceOf(p.session_id).name,
        sessionLabel: faceOf(p.session_id).label,
        asked: faceOf(p.session_id).asked,
        input: (0, attention_1.describeInput)(p),
        where: whereLabel(root, p.cwd),
        superseded: superseded.has(p.id),
    }));
    for (const a of agents)
        a.holds = pending.filter((p) => p.session_id === a.id).length;
    const att = (0, attention_1.collectAttention)(repo, db, new Date(nowMs));
    let broadcast = null;
    try {
        broadcast = (0, steering_1.peekSteering)(repo);
    }
    catch {
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
function readAgents(db, root, threshold, nowMs, o) {
    const out = [];
    try {
        const hasName = (0, db_1.hasSessionNameColumn)(db);
        const hasTranscript = (0, db_1.hasSessionTranscriptColumn)(db);
        const rows = db
            .prepare(`SELECT s.id, ${hasName ? "s.name, " : ""}${hasTranscript ? "s.transcript, " : ""}s.ended, s.final_outcome, s.started,
                COUNT(t.seq) AS calls, MAX(t.ts) AS last_ts
           FROM sessions s
           LEFT JOIN tool_calls t ON t.session_id = s.id
          GROUP BY s.id
          ORDER BY COALESCE(MAX(t.ts), s.started) DESC
          LIMIT ?`)
            .all(o.limit ?? 12);
        const sparkFrom = new Date(nowMs - exports.SPARK_BUCKETS * exports.SPARK_BUCKET_MS).toISOString();
        for (const r of rows) {
            const depth = r.id === o.focusId ? (o.deep ?? 80) : Math.max(threshold, 4);
            const callRows = db
                .prepare(`SELECT tool, input_summary, input_hash, ok, ts FROM tool_calls
              WHERE session_id = ? ORDER BY seq DESC LIMIT ?`)
                .all(r.id, depth).reverse();
            const trajectory = [];
            let prevHash = null;
            let run = 0;
            for (const cr of callRows) {
                run = cr.input_hash === prevHash ? run + 1 : 1;
                prevHash = cr.input_hash;
                trajectory.push(toCall(cr, run));
            }
            const spark = new Array(exports.SPARK_BUCKETS).fill(0);
            const tsRows = db
                .prepare(`SELECT ts FROM tool_calls WHERE session_id = ? AND ts >= ?`)
                .all(r.id, sparkFrom);
            for (const t of tsRows) {
                const age = nowMs - Date.parse(t.ts);
                if (!(age >= 0))
                    continue;
                const b = exports.SPARK_BUCKETS - 1 - Math.floor(age / exports.SPARK_BUCKET_MS);
                if (b >= 0 && b < exports.SPARK_BUCKETS)
                    spark[b]++;
            }
            const last = r.last_ts || r.started;
            out.push({
                id: r.id,
                ...(0, sessionFace_1.sessionFace)(r.id, r.name, r.transcript),
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
    }
    catch {
        /* DB momentarily locked by a writer: render what we have */
    }
    return out;
}
/** A session's verdict and footprint change only when it makes a call, so they are computed once per call count. */
const facts = new Map();
function factsOf(db, id, calls, root) {
    const hit = facts.get(id);
    if (hit && hit.calls === calls)
        return hit;
    const rows = (0, db_1.listSessionCalls)(db, id);
    const next = { calls, claim: (0, claim_1.checkClaim)(rows), footprint: (0, footprint_1.footprint)(rows, root) };
    facts.set(id, next);
    return next;
}
function toCall(cr, streak) {
    const m = cr.input_summary.match(TAGGED);
    let kind = cr.ok === 0 ? "failed" : "ok";
    let summary = cr.input_summary;
    let ruleId = null;
    if (m) {
        kind = m[1].toLowerCase();
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
function liveness(a, nowMs, threshold) {
    const age = a.lastTsMs != null ? nowMs - a.lastTsMs : Infinity;
    const looping = a.streak >= threshold;
    if (age < exports.ACTIVE_WINDOW_MS)
        return looping ? "looping" : "active";
    if (a.ended)
        return "done";
    return looping ? "looping" : "idle";
}
function whereLabel(root, cwd) {
    if (!cwd)
        return "";
    const rel = path.relative(root, cwd);
    if (rel === "")
        return "";
    if (rel.startsWith("..") || path.isAbsolute(rel))
        return cwd;
    return rel + path.sep;
}
function safePeek(id) {
    try {
        return (0, steering_1.peekSteering)(undefined, id);
    }
    catch {
        return null;
    }
}
function parse(iso) {
    if (!iso)
        return null;
    const t = Date.parse(iso);
    return Number.isFinite(t) ? t : null;
}
