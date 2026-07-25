// The unified decisions table + `reins audit`: a chronological, scriptable
// trail of every gate decision (deny/ask/hold/allow) and how holds were
// resolved. Exercised end-to-end via the CLI/hooks the way hold.test.js does.
const { test } = require("node:test");
const assert = require("node:assert");
const os = require("node:os");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const CLI = path.join(__dirname, "..", "dist", "cli.js");

function tmpProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reins-audit-"));
  fs.mkdirSync(path.join(dir, ".reins"), { recursive: true });
  return dir;
}

// Same override as hold.test.js: don't let CLAUDE_PROJECT_DIR leak in.
const childEnv = { ...process.env, CLAUDE_PROJECT_DIR: "" };

function runHook(name, event, cwd) {
  return execFileSync(process.execPath, [CLI, "hook", name], {
    input: JSON.stringify(event),
    cwd,
    encoding: "utf8",
    env: childEnv,
  }).trim();
}

function runCli(args, cwd) {
  return execFileSync(process.execPath, [CLI, ...args], {
    cwd,
    encoding: "utf8",
    env: childEnv,
  });
}

function writeGuards(dir, rules) {
  fs.writeFileSync(path.join(dir, ".reins", "guards.json"), JSON.stringify({ rules }, null, 2));
}

function listPendingFiles(dir) {
  const p = path.join(dir, ".reins", "pending");
  return fs.existsSync(p) ? fs.readdirSync(p).filter((f) => f.endsWith(".json")) : [];
}

const hasSqlite = (() => {
  try {
    require("node:sqlite");
    return true;
  } catch {
    return false;
  }
})();

const DENY_RULE = {
  id: "no-rm",
  type: "bash",
  pattern: "\\brm\\b",
  reason: "rm is blocked.",
  action: "deny",
};

const ASK_RULE = {
  id: "ask-push",
  type: "bash",
  pattern: "git\\s+push",
  reason: "Pushing needs a look.",
  action: "ask",
};

const HOLD_RULE = {
  id: "hold-publish",
  type: "bash",
  pattern: "npm\\s+publish",
  reason: "Publishing needs approval.",
  action: "hold",
};

const EVENT = (dir, command, session = "a1") => ({
  cwd: dir,
  session_id: session,
  tool_name: "Bash",
  tool_input: { command },
});

// ---------- schema ----------

test("decisions table is created on a fresh DB", { skip: !hasSqlite }, () => {
  const dir = tmpProject();
  writeGuards(dir, [DENY_RULE]);
  runHook("pre-tool", EVENT(dir, "rm -f x"), dir);

  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(path.join(dir, ".reins", "runs.db"), { readOnly: true });
  const row = db
    .prepare(`SELECT COUNT(*) AS c FROM sqlite_master WHERE type='table' AND name='decisions'`)
    .get();
  assert.strictEqual(row.c, 1);
});

test("decisions table is added transparently to a pre-existing DB missing it", { skip: !hasSqlite }, () => {
  const dir = tmpProject();
  // Build a runs.db with only the pre-decisions schema (mirrors an older reins).
  const { DatabaseSync } = require("node:sqlite");
  const dbPath = path.join(dir, ".reins", "runs.db");
  const seed = new DatabaseSync(dbPath);
  seed.exec(`
    CREATE TABLE sessions (id TEXT PRIMARY KEY, repo TEXT, started TEXT, ended TEXT,
      total_tokens INTEGER, total_cost REAL, final_outcome TEXT, name TEXT);
    CREATE TABLE tool_calls (session_id TEXT, seq INTEGER, tool TEXT, input_summary TEXT,
      input_hash TEXT, ok INTEGER, ts TEXT);
    CREATE TABLE outcomes (session_id TEXT, stop_reason TEXT, gate_result TEXT);
  `);
  seed.close();

  writeGuards(dir, [DENY_RULE]);
  runHook("pre-tool", EVENT(dir, "rm -f x"), dir);

  const check = new DatabaseSync(dbPath, { readOnly: true });
  const row = check
    .prepare(`SELECT COUNT(*) AS c FROM sqlite_master WHERE type='table' AND name='decisions'`)
    .get();
  assert.strictEqual(row.c, 1);
  const decisions = check.prepare(`SELECT decision, rule_id FROM decisions`).all();
  assert.strictEqual(decisions.length, 1);
  assert.strictEqual(decisions[0].decision, "deny");
  assert.strictEqual(decisions[0].rule_id, "no-rm");
});

// ---------- recording ----------

test("deny/ask/hold each record a decisions row with the firing rule", { skip: !hasSqlite }, () => {
  const dir = tmpProject();
  writeGuards(dir, [DENY_RULE, ASK_RULE, HOLD_RULE]);
  runHook("pre-tool", EVENT(dir, "rm -f x"), dir);
  runHook("pre-tool", EVENT(dir, "git push origin main"), dir);
  runHook("pre-tool", EVENT(dir, "npm publish"), dir);

  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(path.join(dir, ".reins", "runs.db"), { readOnly: true });
  const rows = db.prepare(`SELECT * FROM decisions WHERE session_id = 'a1' ORDER BY id`).all();
  assert.strictEqual(rows.length, 3);
  assert.strictEqual(rows[0].decision, "deny");
  assert.strictEqual(rows[0].rule_id, "no-rm");
  assert.strictEqual(rows[0].resolution, null);
  assert.strictEqual(rows[1].decision, "ask");
  assert.strictEqual(rows[1].rule_id, "ask-push");
  assert.strictEqual(rows[2].decision, "hold");
  assert.strictEqual(rows[2].rule_id, "hold-publish");
  assert.ok(rows[2].hold_id, "held row must carry the parked action's id");
  assert.strictEqual(rows[2].resolution, null, "unresolved until approve/deny");
});

test("approve resolves the held decision; a denied hold resolves too", { skip: !hasSqlite }, () => {
  const dir = tmpProject();
  writeGuards(dir, [HOLD_RULE]);
  runHook("pre-tool", EVENT(dir, "npm publish"), dir);
  const id = listPendingFiles(dir)[0].replace(".json", "");
  runCli(["approve", id], dir);

  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(path.join(dir, ".reins", "runs.db"), { readOnly: true });
  const row = db.prepare(`SELECT * FROM decisions WHERE hold_id = ?`).get(id);
  assert.strictEqual(row.resolution, "approved");
  assert.strictEqual(row.resolver, "human-cli");
  assert.ok(row.resolved_ts);

  // A second, DIFFERENT hold (an approved input_hash's one-shot allowance is
  // not scoped by command, so reusing "npm publish" here would just consume
  // the still-live allowance instead of parking a new proposal).
  runHook("pre-tool", EVENT(dir, "npm publish --tag next", "a2"), dir);
  const id2 = listPendingFiles(dir)[0].replace(".json", "");
  runCli(["deny", id2], dir);
  const row2 = db.prepare(`SELECT * FROM decisions WHERE hold_id = ?`).get(id2);
  assert.strictEqual(row2.resolution, "denied");
  assert.strictEqual(row2.resolver, "human-cli");
});

// ---------- reins audit ----------

test("audit: chronological table shows tool, rule and resolution", { skip: !hasSqlite }, () => {
  const dir = tmpProject();
  writeGuards(dir, [DENY_RULE, HOLD_RULE]);
  runHook("pre-tool", EVENT(dir, "rm -f x"), dir);
  runHook("pre-tool", EVENT(dir, "npm publish"), dir);
  const id = listPendingFiles(dir)[0].replace(".json", "");
  runCli(["approve", id], dir);

  const out = runCli(["audit", "a1"], dir);
  assert.match(out, /no-rm/);
  assert.match(out, /hold-publish/);
  assert.match(out, /approved/);
});

test("audit --json emits the raw decisions rows", { skip: !hasSqlite }, () => {
  const dir = tmpProject();
  writeGuards(dir, [DENY_RULE]);
  runHook("pre-tool", EVENT(dir, "rm -f x"), dir);

  const out = runCli(["audit", "a1", "--json"], dir);
  const rows = JSON.parse(out);
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].decision, "deny");
  assert.strictEqual(rows[0].rule_id, "no-rm");
  assert.strictEqual(rows[0].session_id, "a1");
});

test("audit: no session argument defaults to the most recent session", { skip: !hasSqlite }, () => {
  const dir = tmpProject();
  writeGuards(dir, [DENY_RULE]);
  runHook("pre-tool", EVENT(dir, "rm -f x", "old1"), dir);
  runHook("pre-tool", EVENT(dir, "rm -f y", "new1"), dir);

  const out = runCli(["audit", "--json"], dir);
  const rows = JSON.parse(out);
  assert.ok(rows.length > 0);
  assert.strictEqual(rows[0].session_id, "new1");
});

test("audit: unknown session name fails with exit 1", { skip: !hasSqlite }, () => {
  const dir = tmpProject();
  writeGuards(dir, [DENY_RULE]);
  runHook("pre-tool", EVENT(dir, "rm -f x"), dir);
  assert.throws(
    () => runCli(["audit", "no-such-session"], dir),
    (e) => e.status === 1 && /No session matches/.test(e.stderr),
  );
});

// ---------- graceful degradation ----------

test("audit: no runs.db yet says so instead of erroring", () => {
  const dir = tmpProject();
  const out = runCli(["audit"], dir);
  assert.match(out, /No runs recorded|capture is disabled/);
});

test("audit --json: no runs.db yet emits a JSON error object, not a crash", () => {
  const dir = tmpProject();
  const out = runCli(["audit", "--json"], dir);
  const parsed = JSON.parse(out);
  assert.ok(parsed.error);
});

test("lastrun shows a gate-decisions rollup for a session with gated calls", { skip: !hasSqlite }, () => {
  const dir = tmpProject();
  writeGuards(dir, [DENY_RULE, HOLD_RULE]);
  runHook("pre-tool", EVENT(dir, "rm -f x"), dir);
  runHook("pre-tool", EVENT(dir, "npm publish"), dir);

  const out = runCli(["lastrun", "a1"], dir);
  assert.match(out, /Gate decisions/);
  assert.match(out, /1 deny/);
  assert.match(out, /1 hold/);
  assert.match(out, /awaiting a decision/);
});
