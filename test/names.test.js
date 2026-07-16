// Run with: npm run build && npm test
const { test } = require("node:test");
const assert = require("node:assert");

const { mnemonic, displayName } = require("../dist/names.js");
const { parsePickerChoice, formatPickerRow } = require("../dist/commands/steer.js");

let DatabaseSync = null;
try {
  ({ DatabaseSync } = require("node:sqlite"));
} catch {
  /* pre-22.5 Node — DB-backed tests skip */
}

// ---------------------------------------------------------------- mnemonics

test("mnemonic: deterministic and adjective-animal shaped", () => {
  const id = "3b9f2a1c-1111-2222-3333-444455556666";
  assert.strictEqual(mnemonic(id), mnemonic(id));
  assert.match(mnemonic(id), /^[a-z]+-[a-z]+$/);
});

test("mnemonic: spreads across ids (few collisions in a fleet-sized sample)", () => {
  const names = new Set();
  for (let i = 0; i < 200; i++) names.add(mnemonic(`session-${i}-abcdef`));
  // 200 draws from 2304 combos: expect ~192 unique; anything above 170 means
  // the hash is mixing, not clumping.
  assert.ok(names.size > 170, `only ${names.size} unique names in 200 ids`);
});

test("displayName: custom label wins, blank falls back to mnemonic", () => {
  const id = "3b9f2a1c-1111-2222-3333-444455556666";
  assert.strictEqual(displayName(id, "auth-work"), "auth-work");
  assert.strictEqual(displayName(id, "   "), mnemonic(id));
  assert.strictEqual(displayName(id, null), mnemonic(id));
  assert.strictEqual(displayName(id), mnemonic(id));
});

// ---------------------------------------------------------- picker parsing

test("parsePickerChoice: empty / a / all mean broadcast (old muscle memory)", () => {
  assert.deepStrictEqual(parsePickerChoice("", 3), { kind: "broadcast" });
  assert.deepStrictEqual(parsePickerChoice("  ", 3), { kind: "broadcast" });
  assert.deepStrictEqual(parsePickerChoice("a", 3), { kind: "broadcast" });
  assert.deepStrictEqual(parsePickerChoice("All", 3), { kind: "broadcast" });
});

test("parsePickerChoice: numbers select in range, reject out of range", () => {
  assert.deepStrictEqual(parsePickerChoice("1", 3), { kind: "session", index: 0 });
  assert.deepStrictEqual(parsePickerChoice(" 3 ", 3), { kind: "session", index: 2 });
  assert.deepStrictEqual(parsePickerChoice("0", 3), { kind: "invalid" });
  assert.deepStrictEqual(parsePickerChoice("4", 3), { kind: "invalid" });
});

test("parsePickerChoice: q cancels, junk is invalid", () => {
  assert.deepStrictEqual(parsePickerChoice("q", 3), { kind: "cancel" });
  assert.deepStrictEqual(parsePickerChoice("quit", 3), { kind: "cancel" });
  assert.deepStrictEqual(parsePickerChoice("banana", 3), { kind: "invalid" });
});

test("formatPickerRow: shows name, short id, liveness, and last call", () => {
  const now = Date.now();
  const row = {
    id: "3b9f2a1c-1111-2222-3333-444455556666",
    name: "auth-work",
    calls: 12,
    lastTsMs: now - 5_000,
    lastTool: "Bash",
    lastSummary: "npm test",
  };
  const out = formatPickerRow(row, 0, now);
  assert.match(out, /1\./);
  assert.match(out, /auth-work/);
  assert.match(out, /3b9f2a1c/);
  assert.ok(!out.includes("444455556666"), "full uuid is not shown");
  assert.match(out, /active/);
  assert.match(out, /Bash: npm test/);

  const idle = formatPickerRow({ ...row, name: null, lastTsMs: now - 120_000 }, 1, now);
  assert.match(idle, /idle 2m/);
  assert.ok(idle.includes(mnemonic(row.id)), "unnamed session shows its mnemonic");
});

// ------------------------------------------------- names in the capture DB

function freshDb() {
  const db = new DatabaseSync(":memory:");
  // The PRE-name schema, to exercise the migration path.
  db.exec(`CREATE TABLE sessions (
    id TEXT PRIMARY KEY, repo TEXT, started TEXT, ended TEXT,
    total_tokens INTEGER, total_cost REAL, final_outcome TEXT
  );
  CREATE TABLE tool_calls (
    session_id TEXT, seq INTEGER, tool TEXT, input_summary TEXT,
    input_hash TEXT, ok INTEGER, ts TEXT
  );`);
  return db;
}

test("name column: migration is detected, applied, and idempotent", { skip: !DatabaseSync }, () => {
  const { hasSessionNameColumn, ensureSessionNameColumn } = require("../dist/db.js");
  const db = freshDb();
  assert.strictEqual(hasSessionNameColumn(db), false);
  ensureSessionNameColumn(db);
  assert.strictEqual(hasSessionNameColumn(db), true);
  ensureSessionNameColumn(db); // second run must not throw
  assert.strictEqual(hasSessionNameColumn(db), true);
});

test("matchSessions: id prefix, custom name, and mnemonic all resolve", { skip: !DatabaseSync }, () => {
  const { ensureSessionNameColumn, setSessionName, matchSessions } = require("../dist/db.js");
  const db = freshDb();
  ensureSessionNameColumn(db);
  const a = "3b9f2a1c-1111-2222-3333-444455556666";
  const b = "b0be190a-7777-8888-9999-000011112222";
  db.prepare(`INSERT INTO sessions (id, started) VALUES (?, ?)`).run(a, "2026-07-16T00:00:00Z");
  db.prepare(`INSERT INTO sessions (id, started) VALUES (?, ?)`).run(b, "2026-07-16T01:00:00Z");
  setSessionName(db, a, "auth-work");

  assert.deepStrictEqual(matchSessions(db, a), [a], "exact id");
  assert.deepStrictEqual(matchSessions(db, "3b9f"), [a], "id prefix");
  assert.deepStrictEqual(matchSessions(db, "auth-work"), [a], "custom name");
  assert.deepStrictEqual(matchSessions(db, "AUTH-WORK"), [a], "name is case-insensitive");
  assert.deepStrictEqual(matchSessions(db, mnemonic(b)), [b], "auto mnemonic");
  assert.deepStrictEqual(matchSessions(db, "nope"), [], "unknown token");
});

test("matchSessions: an id prefix can never be shadowed by a name", { skip: !DatabaseSync }, () => {
  const { ensureSessionNameColumn, setSessionName, matchSessions } = require("../dist/db.js");
  const db = freshDb();
  ensureSessionNameColumn(db);
  const a = "3b9f2a1c-1111-2222-3333-444455556666";
  const b = "b0be190a-7777-8888-9999-000011112222";
  db.prepare(`INSERT INTO sessions (id, started) VALUES (?, ?)`).run(a, "2026-07-16T00:00:00Z");
  db.prepare(`INSERT INTO sessions (id, started) VALUES (?, ?)`).run(b, "2026-07-16T01:00:00Z");
  setSessionName(db, b, "3b9f"); // adversarially name b after a's prefix
  assert.deepStrictEqual(matchSessions(db, "3b9f"), [a], "prefix tier wins over name tier");
});

test("recentActiveSessions: only sessions with activity inside the window", { skip: !DatabaseSync }, () => {
  const { ensureSessionNameColumn, recentActiveSessions } = require("../dist/db.js");
  const db = freshDb();
  ensureSessionNameColumn(db);
  const now = Date.now();
  const fresh = "aaaaaaaa-0000-0000-0000-000000000000";
  const stale = "bbbbbbbb-0000-0000-0000-000000000000";
  db.prepare(`INSERT INTO sessions (id, started) VALUES (?, ?)`).run(fresh, new Date(now - 600_000).toISOString());
  db.prepare(`INSERT INTO sessions (id, started) VALUES (?, ?)`).run(stale, new Date(now - 3_600_000).toISOString());
  db.prepare(`INSERT INTO tool_calls (session_id, seq, tool, input_summary, input_hash, ok, ts) VALUES (?,?,?,?,?,?,?)`)
    .run(fresh, 1, "Bash", "npm test", "h1", 1, new Date(now - 10_000).toISOString());
  db.prepare(`INSERT INTO tool_calls (session_id, seq, tool, input_summary, input_hash, ok, ts) VALUES (?,?,?,?,?,?,?)`)
    .run(stale, 1, "Bash", "old call", "h2", 1, new Date(now - 3_600_000).toISOString());

  const rows = recentActiveSessions(db, now, 15 * 60_000);
  assert.deepStrictEqual(rows.map((r) => r.id), [fresh]);
  assert.strictEqual(rows[0].lastTool, "Bash");
  assert.strictEqual(rows[0].lastSummary, "npm test");
});
