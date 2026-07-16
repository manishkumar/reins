import { ensureReinsDir, dbPath } from "./paths";
import { getDriver, SqlDb } from "./store";
import { mnemonic } from "./names";

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
  const path = dbPath(payloadCwd);

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
    } catch (e) {
      if (!/locked|busy/i.test(String((e as Error)?.message ?? e))) throw e;
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
  } catch {
    /* naming unavailable on this db — display falls back to mnemonics */
  }
  _db = db;
  return db;
}

/** True if this runs.db has the sessions.name column (added in 0.3.x). */
export function hasSessionNameColumn(db: SqlDb): boolean {
  try {
    const row = db
      .prepare(`SELECT COUNT(*) AS c FROM pragma_table_info('sessions') WHERE name = 'name'`)
      .get() as { c: number } | undefined;
    return (row?.c ?? 0) > 0;
  } catch {
    return false;
  }
}

/** Add sessions.name to a pre-0.3.x runs.db. Idempotent. */
export function ensureSessionNameColumn(db: SqlDb): void {
  if (hasSessionNameColumn(db)) return;
  withRetry(() => db.exec(`ALTER TABLE sessions ADD COLUMN name TEXT`));
}

/** Set (or with null, clear) a session's custom display name. */
export function setSessionName(db: SqlDb, sessionId: string, name: string | null): void {
  withRetry(() => db.prepare(`UPDATE sessions SET name = ? WHERE id = ?`).run(name, sessionId));
}

export interface SessionIdRow {
  id: string;
  name: string | null;
}

/** Recent session ids (+ custom names where the column exists), newest first. */
export function listSessionIds(db: SqlDb, limit = 200): SessionIdRow[] {
  const hasName = hasSessionNameColumn(db);
  const rows = db
    .prepare(
      `SELECT id${hasName ? ", name" : ""} FROM sessions ORDER BY started DESC LIMIT ?`,
    )
    .all(limit) as Array<{ id: string; name?: string | null }>;
  return rows.map((r) => ({ id: r.id, name: hasName ? r.name ?? null : null }));
}

/**
 * Resolve a human-typed token to session ids. Tiers, first non-empty wins:
 * exact id → id prefix → custom name → auto mnemonic. Ordering matters: an id
 * prefix can never be shadowed by someone naming a session "3b9f". More than
 * one result means the token is ambiguous — callers report, never guess.
 */
export function matchSessions(db: SqlDb, token: string): string[] {
  const rows = listSessionIds(db);
  const t = token.toLowerCase();
  const exact = rows.filter((r) => r.id === token);
  if (exact.length) return exact.map((r) => r.id);
  const prefix = rows.filter((r) => r.id.startsWith(token));
  if (prefix.length) return prefix.map((r) => r.id);
  const named = rows.filter((r) => (r.name ?? "").trim().toLowerCase() === t);
  if (named.length) return named.map((r) => r.id);
  return rows.filter((r) => mnemonic(r.id) === t).map((r) => r.id);
}

export interface ActiveSessionRow {
  id: string;
  name: string | null;
  calls: number;
  lastTsMs: number | null;
  lastTool: string | null;
  lastSummary: string | null;
}

/**
 * Sessions with activity inside `windowMs` — the candidates a human might mean
 * when they steer without naming a target. "Activity" is the last tool call
 * (or session start, for a session that hasn't called a tool yet); the `ended`
 * flag is ignored because Claude Code sets it at every turn boundary.
 */
export function recentActiveSessions(
  db: SqlDb,
  nowMs: number,
  windowMs: number,
  limit = 9,
): ActiveSessionRow[] {
  const hasName = hasSessionNameColumn(db);
  const rows = db
    .prepare(
      `SELECT s.id${hasName ? ", s.name" : ""}, COUNT(t.seq) AS calls,
              COALESCE(MAX(t.ts), s.started) AS last_ts
         FROM sessions s
         LEFT JOIN tool_calls t ON t.session_id = s.id
        GROUP BY s.id
        ORDER BY COALESCE(MAX(t.ts), s.started) DESC
        LIMIT ?`,
    )
    .all(limit) as Array<{ id: string; name?: string | null; calls: number; last_ts: string | null }>;

  const out: ActiveSessionRow[] = [];
  for (const r of rows) {
    const ts = r.last_ts ? Date.parse(r.last_ts) : NaN;
    const lastTsMs = Number.isFinite(ts) ? ts : null;
    if (lastTsMs == null || nowMs - lastTsMs > windowMs) continue;
    let lastTool: string | null = null;
    let lastSummary: string | null = null;
    try {
      const call = db
        .prepare(`SELECT tool, input_summary FROM tool_calls WHERE session_id = ? ORDER BY seq DESC LIMIT 1`)
        .get(r.id) as { tool: string; input_summary: string } | undefined;
      if (call) {
        lastTool = call.tool;
        lastSummary = call.input_summary;
      }
    } catch {
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
export function openDbReadOnly(payloadCwd?: string): SqlDb | null {
  const driver = getDriver();
  if (!driver) return null;
  const fs = require("node:fs") as typeof import("node:fs");
  const p = dbPath(payloadCwd);
  if (!fs.existsSync(p)) return null;
  return driver.open(p, { readOnly: true });
}

/**
 * Retry a synchronous DB write on SQLITE_BUSY/locked. busy_timeout handles most
 * contention, but under several agents hammering one runs.db it can still be
 * exhausted — dogfooding saw ~40% of rows dropped without this. Capture is
 * best-effort, so after the retries we give up silently (never block the agent).
 */
function withRetry<T>(fn: () => T): T {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      return fn();
    } catch (e) {
      const msg = String((e as Error)?.message ?? e);
      if (!/locked|busy/i.test(msg)) throw e;
      lastErr = e;
      syncSleep(25 * (attempt + 1) + Math.floor(Math.random() * 25));
    }
  }
  throw lastErr;
}

/** Block the current (short-lived hook) process briefly, without async. */
function syncSleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Insert the session row if it does not exist yet (first tool call / stop). */
export function upsertSessionStart(
  db: SqlDb,
  sessionId: string,
  repo: string,
  startedIso: string,
): void {
  withRetry(() =>
    db
      .prepare(
        `INSERT INTO sessions (id, repo, started) VALUES (?, ?, ?)
         ON CONFLICT(id) DO NOTHING`,
      )
      .run(sessionId, repo, startedIso),
  );
}

export interface ToolCallRow {
  session_id: string;
  tool: string;
  input_summary: string;
  input_hash: string;
  ok: number | null;
  ts: string;
}

/**
 * Insert a tool-call row, computing seq atomically inside the statement. Doing
 * MAX(seq)+1 as a subquery of the INSERT (rather than a separate read) keeps
 * seq collision-free under concurrent writers, since the write holds a lock for
 * the whole statement.
 */
export function insertToolCall(db: SqlDb, row: ToolCallRow): void {
  withRetry(() =>
    db
      .prepare(
        `INSERT INTO tool_calls (session_id, seq, tool, input_summary, input_hash, ok, ts)
         VALUES (
           ?,
           (SELECT COALESCE(MAX(seq), 0) + 1 FROM tool_calls WHERE session_id = ?),
           ?, ?, ?, ?, ?
         )`,
      )
      .run(
        row.session_id,
        row.session_id,
        row.tool,
        row.input_summary,
        row.input_hash,
        row.ok,
        row.ts,
      ),
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

/**
 * Length of the CONSECUTIVE trailing streak of this input_hash in the session.
 * This — not the all-session count — is what the loop alarm keys on: the 3rd
 * `npm test` of a long, healthy edit→test cycle is iteration, not a loop; three
 * identical calls with nothing in between is a loop. Counting session-wide
 * repeats made the alarm fire on the healthiest pattern an agent has, and then
 * on every later occurrence, teaching the model to discount the channel.
 */
export function countTrailingSameHash(
  db: SqlDb,
  sessionId: string,
  inputHash: string,
): number {
  // A streak longer than 50 identical calls is already far past any sane
  // threshold; capping the scan keeps the hot post-tool path cheap.
  const rows = db
    .prepare(
      `SELECT input_hash FROM tool_calls WHERE session_id = ? ORDER BY seq DESC LIMIT 50`,
    )
    .all(sessionId) as { input_hash: string }[];
  let streak = 0;
  for (const r of rows) {
    if (r.input_hash !== inputHash) break;
    streak++;
  }
  return streak;
}

export function finalizeSession(
  db: SqlDb,
  sessionId: string,
  endedIso: string,
  outcome: string,
  totalTokens: number | null,
  totalCost: number | null,
): void {
  withRetry(() =>
    db
      .prepare(
        `UPDATE sessions
           SET ended = ?, final_outcome = ?,
               total_tokens = COALESCE(?, total_tokens),
               total_cost = COALESCE(?, total_cost)
         WHERE id = ?`,
      )
      .run(endedIso, outcome, totalTokens, totalCost, sessionId),
  );
}

export function insertOutcome(
  db: SqlDb,
  sessionId: string,
  stopReason: string,
  gateResult: string | null,
): void {
  withRetry(() =>
    db
      .prepare(`INSERT INTO outcomes (session_id, stop_reason, gate_result) VALUES (?, ?, ?)`)
      .run(sessionId, stopReason, gateResult),
  );
}
