"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.openDb = openDb;
exports.openDbReadOnly = openDbReadOnly;
exports.upsertSessionStart = upsertSessionStart;
exports.insertToolCall = insertToolCall;
exports.countSameHash = countSameHash;
exports.countTrailingSameHash = countTrailingSameHash;
exports.finalizeSession = finalizeSession;
exports.insertOutcome = insertOutcome;
const paths_1 = require("./paths");
const store_1 = require("./store");
const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  repo TEXT,
  started TEXT,
  ended TEXT,
  total_tokens INTEGER,
  total_cost REAL,
  final_outcome TEXT
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
CREATE INDEX IF NOT EXISTS idx_tool_calls_session ON tool_calls(session_id, seq);
CREATE INDEX IF NOT EXISTS idx_tool_calls_hash ON tool_calls(session_id, input_hash);
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
    _db = db;
    return db;
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
