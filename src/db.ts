// node:sqlite is experimental and emits a process warning on first use. Hooks
// must keep stderr clean (it surfaces to the user/agent), so suppress that one
// specific warning before the module is loaded.
const _origEmitWarning = process.emitWarning.bind(process);
(process as unknown as { emitWarning: typeof process.emitWarning }).emitWarning =
  ((warning: string | Error, ...rest: unknown[]) => {
    const type =
      typeof rest[0] === "string"
        ? rest[0]
        : (rest[0] as { type?: string } | undefined)?.type;
    if (type === "ExperimentalWarning" && String(warning).includes("SQLite")) return;
    return (_origEmitWarning as (...a: unknown[]) => void)(warning, ...rest);
  }) as typeof process.emitWarning;

import { DatabaseSync } from "node:sqlite";
import { ensureReinsDir, dbPath } from "./paths";

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

let _db: DatabaseSync | null = null;

/** Open (creating if needed) the project's runs.db with schema applied. */
export function openDb(payloadCwd?: string): DatabaseSync {
  if (_db) return _db;
  ensureReinsDir(payloadCwd);
  const db = new DatabaseSync(dbPath(payloadCwd));
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA busy_timeout = 2000;");
  db.exec(SCHEMA);
  _db = db;
  return db;
}

/** Open read-only for query commands; returns null if no db exists yet. */
export function openDbReadOnly(payloadCwd?: string): DatabaseSync | null {
  const fs = require("node:fs") as typeof import("node:fs");
  const p = dbPath(payloadCwd);
  if (!fs.existsSync(p)) return null;
  const db = new DatabaseSync(p, { readOnly: true });
  return db;
}

/** Insert the session row if it does not exist yet (first tool call / stop). */
export function upsertSessionStart(
  db: DatabaseSync,
  sessionId: string,
  repo: string,
  startedIso: string,
): void {
  db.prepare(
    `INSERT INTO sessions (id, repo, started) VALUES (?, ?, ?)
     ON CONFLICT(id) DO NOTHING`,
  ).run(sessionId, repo, startedIso);
}

export function nextSeq(db: DatabaseSync, sessionId: string): number {
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

export function insertToolCall(db: DatabaseSync, row: ToolCallRow): void {
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
export function countSameHash(
  db: DatabaseSync,
  sessionId: string,
  inputHash: string,
): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS c FROM tool_calls WHERE session_id = ? AND input_hash = ?`,
    )
    .get(sessionId, inputHash) as { c: number } | undefined;
  return row?.c ?? 0;
}

export function finalizeSession(
  db: DatabaseSync,
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
  db: DatabaseSync,
  sessionId: string,
  stopReason: string,
  gateResult: string | null,
): void {
  db.prepare(
    `INSERT INTO outcomes (session_id, stop_reason, gate_result) VALUES (?, ?, ?)`,
  ).run(sessionId, stopReason, gateResult);
}
