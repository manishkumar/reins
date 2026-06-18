import { ensureReinsDir, dbPath } from "./paths";
import { getDriver, SqlDb } from "./store";

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

let _db: SqlDb | null = null;

/**
 * Open (creating if needed) the project's runs.db with schema applied.
 * Returns null if no SQLite backend is available on this Node — callers must
 * treat capture as best-effort and skip silently (the live reflexes don't need
 * the DB).
 */
export function openDb(payloadCwd?: string): SqlDb | null {
  if (_db) return _db;
  const driver = getDriver();
  if (!driver) return null;
  ensureReinsDir(payloadCwd);
  const db = driver.open(dbPath(payloadCwd));
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA busy_timeout = 4000;");
  db.exec(SCHEMA);
  _db = db;
  return db;
}

/** Open read-only for query commands; null if no backend or no db file yet. */
export function openDbReadOnly(payloadCwd?: string): SqlDb | null {
  const driver = getDriver();
  if (!driver) return null;
  const fs = require("node:fs") as typeof import("node:fs");
  const p = dbPath(payloadCwd);
  if (!fs.existsSync(p)) return null;
  return driver.open(p, { readOnly: true });
}

/** Insert the session row if it does not exist yet (first tool call / stop). */
export function upsertSessionStart(
  db: SqlDb,
  sessionId: string,
  repo: string,
  startedIso: string,
): void {
  db.prepare(
    `INSERT INTO sessions (id, repo, started) VALUES (?, ?, ?)
     ON CONFLICT(id) DO NOTHING`,
  ).run(sessionId, repo, startedIso);
}

export function nextSeq(db: SqlDb, sessionId: string): number {
  const row = db
    .prepare(`SELECT COALESCE(MAX(seq), 0) AS m FROM tool_calls WHERE session_id = ?`)
    .get(sessionId) as { m: number } | undefined;
  return (row?.m ?? 0) + 1;
}

export interface ToolCallRow {
  session_id: string;
  seq: number;
  tool: string;
  input_summary: string;
  input_hash: string;
  ok: number | null;
  ts: string;
}

export function insertToolCall(db: SqlDb, row: ToolCallRow): void {
  db.prepare(
    `INSERT INTO tool_calls (session_id, seq, tool, input_summary, input_hash, ok, ts)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.session_id,
    row.seq,
    row.tool,
    row.input_summary,
    row.input_hash,
    row.ok,
    row.ts,
  );
}

/** How many times this exact (tool,input_hash) has run in the session so far. */
export function countSameHash(db: SqlDb, sessionId: string, inputHash: string): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS c FROM tool_calls WHERE session_id = ? AND input_hash = ?`,
    )
    .get(sessionId, inputHash) as { c: number } | undefined;
  return row?.c ?? 0;
}

export function finalizeSession(
  db: SqlDb,
  sessionId: string,
  endedIso: string,
  outcome: string,
  totalTokens: number | null,
  totalCost: number | null,
): void {
  db.prepare(
    `UPDATE sessions
       SET ended = ?, final_outcome = ?,
           total_tokens = COALESCE(?, total_tokens),
           total_cost = COALESCE(?, total_cost)
     WHERE id = ?`,
  ).run(endedIso, outcome, totalTokens, totalCost, sessionId);
}

export function insertOutcome(
  db: SqlDb,
  sessionId: string,
  stopReason: string,
  gateResult: string | null,
): void {
  db.prepare(
    `INSERT INTO outcomes (session_id, stop_reason, gate_result) VALUES (?, ?, ?)`,
  ).run(sessionId, stopReason, gateResult);
}
