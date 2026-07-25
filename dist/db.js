"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.openDb = openDb;
exports.hasSessionNameColumn = hasSessionNameColumn;
exports.ensureSessionNameColumn = ensureSessionNameColumn;
exports.setSessionName = setSessionName;
exports.listSessionIds = listSessionIds;
exports.matchSessions = matchSessions;
exports.recentActiveSessions = recentActiveSessions;
exports.openDbReadOnly = openDbReadOnly;
exports.upsertSessionStart = upsertSessionStart;
exports.insertToolCall = insertToolCall;
exports.countSameHash = countSameHash;
exports.countTrailingSameHash = countTrailingSameHash;
exports.finalizeSession = finalizeSession;
exports.insertOutcome = insertOutcome;
exports.insertDecision = insertDecision;
exports.resolveDecision = resolveDecision;
exports.listDecisions = listDecisions;
const paths_1 = require("./paths");
const store_1 = require("./store");
const names_1 = require("./names");
const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  repo TEXT,
  started TEXT,
  ended TEXT,
  total_tokens INTEGER,
  total_cost REAL,
  final_outcome TEXT,
  name TEXT
);
CREATE TABLE IF NOT EXISTS tool_calls (
  session_id TEXT,
  seq INTEGER,
  tool TEXT,
  input_summary TEXT,
  input_hash TEXT,
  ok INTEGER,
  ts TEXT
);
CREATE TABLE IF NOT EXISTS outcomes (
  session_id TEXT,
  stop_reason TEXT,
  gate_result TEXT
);
CREATE TABLE IF NOT EXISTS decisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT,
  ts TEXT,
  tool TEXT,
  input_summary TEXT,
  input_hash TEXT,
  rule_id TEXT,
  rule_reason TEXT,
  decision TEXT,
  resolution TEXT,
  resolver TEXT,
  resolved_ts TEXT,
  hold_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_tool_calls_session ON tool_calls(session_id, seq);
CREATE INDEX IF NOT EXISTS idx_tool_calls_hash ON tool_calls(session_id, input_hash);
CREATE INDEX IF NOT EXISTS idx_decisions_session ON decisions(session_id, ts);
CREATE INDEX IF NOT EXISTS idx_decisions_hold ON decisions(hold_id);
`;
let _db = null;
/**
 * Open (creating if needed) the project's runs.db with schema applied.
 * Returns null if no SQLite backend is available on this Node — callers must
 * treat capture as best-effort and skip silently (the live reflexes don't need
 * the DB).
 */
function openDb(payloadCwd) {
    if (_db)
        return _db;
    const driver = (0, store_1.getDriver)();
    if (!driver)
        return null;
    (0, paths_1.ensureReinsDir)(payloadCwd);
    const path = (0, paths_1.dbPath)(payloadCwd);
    // The whole open is retried, not just the inserts. Under concurrent writers
    // the lock contention is at OPEN time: setting journal_mode=WAL needs a brief
    // exclusive lock and otherwise throws "database is locked" immediately —
    // before busy_timeout helps — so a process losing that race used to drop its
    // entire batch. Order matters: set busy_timeout FIRST so later statements
    // wait, and tolerate a busy WAL-set (another process is already on it).
    const db = withRetry(() => {
        const d = driver.open(path);
        d.exec("PRAGMA busy_timeout = 4000;");
        try {
            d.exec("PRAGMA journal_mode = WAL;");
        }
        catch (e) {
            if (!/locked|busy/i.test(String(e?.message ?? e)))
                throw e;
            // Another writer is establishing WAL; the mode persists on the file, so
            // proceed — busy_timeout covers the subsequent schema/insert statements.
        }
        d.exec(SCHEMA);
        return d;
    });
    // Migration is best-effort like everything else in capture: a runs.db that
    // can't grow the name column just keeps showing auto mnemonics.
    try {
        ensureSessionNameColumn(db);
    }
    catch {
        /* naming unavailable on this db — display falls back to mnemonics */
    }
    _db = db;
    return db;
}
/** True if this runs.db has the sessions.name column (added in 0.3.x). */
function hasSessionNameColumn(db) {
    try {
        const row = db
            .prepare(`SELECT COUNT(*) AS c FROM pragma_table_info('sessions') WHERE name = 'name'`)
            .get();
        return (row?.c ?? 0) > 0;
    }
    catch {
        return false;
    }
}
/** Add sessions.name to a pre-0.3.x runs.db. Idempotent. */
function ensureSessionNameColumn(db) {
    if (hasSessionNameColumn(db))
        return;
    withRetry(() => db.exec(`ALTER TABLE sessions ADD COLUMN name TEXT`));
}
/** Set (or with null, clear) a session's custom display name. */
function setSessionName(db, sessionId, name) {
    withRetry(() => db.prepare(`UPDATE sessions SET name = ? WHERE id = ?`).run(name, sessionId));
}
/** Recent session ids (+ custom names where the column exists), newest first. */
function listSessionIds(db, limit = 200) {
    const hasName = hasSessionNameColumn(db);
    const rows = db
        .prepare(`SELECT id${hasName ? ", name" : ""} FROM sessions ORDER BY started DESC LIMIT ?`)
        .all(limit);
    return rows.map((r) => ({ id: r.id, name: hasName ? r.name ?? null : null }));
}
/**
 * Resolve a human-typed token to session ids. Tiers, first non-empty wins:
 * exact id → id prefix → custom name → auto mnemonic. Ordering matters: an id
 * prefix can never be shadowed by someone naming a session "3b9f". More than
 * one result means the token is ambiguous — callers report, never guess.
 */
function matchSessions(db, token) {
    const rows = listSessionIds(db);
    const t = token.toLowerCase();
    const exact = rows.filter((r) => r.id === token);
    if (exact.length)
        return exact.map((r) => r.id);
    const prefix = rows.filter((r) => r.id.startsWith(token));
    if (prefix.length)
        return prefix.map((r) => r.id);
    const named = rows.filter((r) => (r.name ?? "").trim().toLowerCase() === t);
    if (named.length)
        return named.map((r) => r.id);
    return rows.filter((r) => (0, names_1.mnemonic)(r.id) === t).map((r) => r.id);
}
/**
 * Sessions with activity inside `windowMs` — the candidates a human might mean
 * when they steer without naming a target. "Activity" is the last tool call
 * (or session start, for a session that hasn't called a tool yet); the `ended`
 * flag is ignored because Claude Code sets it at every turn boundary.
 */
function recentActiveSessions(db, nowMs, windowMs, limit = 9) {
    const hasName = hasSessionNameColumn(db);
    const rows = db
        .prepare(`SELECT s.id${hasName ? ", s.name" : ""}, COUNT(t.seq) AS calls,
              COALESCE(MAX(t.ts), s.started) AS last_ts
         FROM sessions s
         LEFT JOIN tool_calls t ON t.session_id = s.id
        GROUP BY s.id
        ORDER BY COALESCE(MAX(t.ts), s.started) DESC
        LIMIT ?`)
        .all(limit);
    const out = [];
    for (const r of rows) {
        const ts = r.last_ts ? Date.parse(r.last_ts) : NaN;
        const lastTsMs = Number.isFinite(ts) ? ts : null;
        if (lastTsMs == null || nowMs - lastTsMs > windowMs)
            continue;
        let lastTool = null;
        let lastSummary = null;
        try {
            const call = db
                .prepare(`SELECT tool, input_summary FROM tool_calls WHERE session_id = ? ORDER BY seq DESC LIMIT 1`)
                .get(r.id);
            if (call) {
                lastTool = call.tool;
                lastSummary = call.input_summary;
            }
        }
        catch {
            /* row still useful without the last-call preview */
        }
        out.push({
            id: r.id,
            name: hasName ? r.name ?? null : null,
            calls: r.calls,
            lastTsMs,
            lastTool,
            lastSummary,
        });
    }
    return out;
}
/** Open read-only for query commands; null if no backend or no db file yet. */
function openDbReadOnly(payloadCwd) {
    const driver = (0, store_1.getDriver)();
    if (!driver)
        return null;
    const fs = require("node:fs");
    const p = (0, paths_1.dbPath)(payloadCwd);
    if (!fs.existsSync(p))
        return null;
    return driver.open(p, { readOnly: true });
}
/**
 * Retry a synchronous DB write on SQLITE_BUSY/locked. busy_timeout handles most
 * contention, but under several agents hammering one runs.db it can still be
 * exhausted — dogfooding saw ~40% of rows dropped without this. Capture is
 * best-effort, so after the retries we give up silently (never block the agent).
 */
function withRetry(fn) {
    let lastErr;
    for (let attempt = 0; attempt < 6; attempt++) {
        try {
            return fn();
        }
        catch (e) {
            const msg = String(e?.message ?? e);
            if (!/locked|busy/i.test(msg))
                throw e;
            lastErr = e;
            syncSleep(25 * (attempt + 1) + Math.floor(Math.random() * 25));
        }
    }
    throw lastErr;
}
/** Block the current (short-lived hook) process briefly, without async. */
function syncSleep(ms) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
/** Insert the session row if it does not exist yet (first tool call / stop). */
function upsertSessionStart(db, sessionId, repo, startedIso) {
    withRetry(() => db
        .prepare(`INSERT INTO sessions (id, repo, started) VALUES (?, ?, ?)
         ON CONFLICT(id) DO NOTHING`)
        .run(sessionId, repo, startedIso));
}
/**
 * Insert a tool-call row, computing seq atomically inside the statement. Doing
 * MAX(seq)+1 as a subquery of the INSERT (rather than a separate read) keeps
 * seq collision-free under concurrent writers, since the write holds a lock for
 * the whole statement.
 */
function insertToolCall(db, row) {
    withRetry(() => db
        .prepare(`INSERT INTO tool_calls (session_id, seq, tool, input_summary, input_hash, ok, ts)
         VALUES (
           ?,
           (SELECT COALESCE(MAX(seq), 0) + 1 FROM tool_calls WHERE session_id = ?),
           ?, ?, ?, ?, ?
         )`)
        .run(row.session_id, row.session_id, row.tool, row.input_summary, row.input_hash, row.ok, row.ts));
}
/** How many times this exact (tool,input_hash) has run in the session so far. */
function countSameHash(db, sessionId, inputHash) {
    const row = db
        .prepare(`SELECT COUNT(*) AS c FROM tool_calls WHERE session_id = ? AND input_hash = ?`)
        .get(sessionId, inputHash);
    return row?.c ?? 0;
}
/**
 * Length of the CONSECUTIVE trailing streak of this input_hash in the session.
 * This — not the all-session count — is what the loop alarm keys on: the 3rd
 * `npm test` of a long, healthy edit→test cycle is iteration, not a loop; three
 * identical calls with nothing in between is a loop. Counting session-wide
 * repeats made the alarm fire on the healthiest pattern an agent has, and then
 * on every later occurrence, teaching the model to discount the channel.
 */
function countTrailingSameHash(db, sessionId, inputHash) {
    // A streak longer than 50 identical calls is already far past any sane
    // threshold; capping the scan keeps the hot post-tool path cheap.
    const rows = db
        .prepare(`SELECT input_hash FROM tool_calls WHERE session_id = ? ORDER BY seq DESC LIMIT 50`)
        .all(sessionId);
    let streak = 0;
    for (const r of rows) {
        if (r.input_hash !== inputHash)
            break;
        streak++;
    }
    return streak;
}
function finalizeSession(db, sessionId, endedIso, outcome, totalTokens, totalCost) {
    withRetry(() => db
        .prepare(`UPDATE sessions
           SET ended = ?, final_outcome = ?,
               total_tokens = COALESCE(?, total_tokens),
               total_cost = COALESCE(?, total_cost)
         WHERE id = ?`)
        .run(endedIso, outcome, totalTokens, totalCost, sessionId));
}
function insertOutcome(db, sessionId, stopReason, gateResult) {
    withRetry(() => db
        .prepare(`INSERT INTO outcomes (session_id, stop_reason, gate_result) VALUES (?, ?, ?)`)
        .run(sessionId, stopReason, gateResult));
}
function insertDecision(db, row) {
    withRetry(() => db
        .prepare(`INSERT INTO decisions
           (session_id, ts, tool, input_summary, input_hash, rule_id, rule_reason, decision, resolution, resolver, resolved_ts, hold_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?)`)
        .run(row.session_id, row.ts, row.tool, row.input_summary, row.input_hash, row.rule_id, row.rule_reason, row.decision, row.hold_id ?? null));
}
/**
 * Close the loop on a parked decision: `reins approve`/`reins deny` call this
 * so the audit trail shows not just that a call was held, but what became of
 * it. Matched by hold_id, and only the still-unresolved row — a hold_id is
 * only ever recorded once (retries of the same park don't add rows, see
 * preTool's `existed` check), so this updates exactly the row it parked.
 */
function resolveDecision(db, input) {
    withRetry(() => db
        .prepare(`UPDATE decisions SET resolution = ?, resolver = ?, resolved_ts = ?
         WHERE hold_id = ? AND resolution IS NULL`)
        .run(input.resolution, input.resolver, input.resolved_ts, input.hold_id));
}
/** Chronological gate decisions, optionally scoped to one session. */
function listDecisions(db, opts = {}) {
    const limit = opts.limit ?? 500;
    if (opts.sessionId) {
        return db
            .prepare(`SELECT * FROM decisions WHERE session_id = ? ORDER BY ts ASC, id ASC LIMIT ?`)
            .all(opts.sessionId, limit);
    }
    return db
        .prepare(`SELECT * FROM decisions ORDER BY ts ASC, id ASC LIMIT ?`)
        .all(limit);
}
