// `reins audit --guards` — the retrospective on the guards themselves.
//
// The question it exists to answer came out of real capture: of 18 denials in
// one repo over seven weeks, 15 came from a rule that had already been fixed
// upstream and 5 were undone seconds later by the same command minus a flag.
// None of that was visible, because the live bypass ledger is cleared at the
// end of each run while the DB kept the rows the whole time.
//
// Denials are seeded straight into runs.db here rather than driven through the
// hooks: the point under test is the reading of history, including history
// written by an older reins that had no decisions table.
const { test } = require("node:test");
const assert = require("node:assert");
const os = require("node:os");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const CLI = path.join(__dirname, "..", "dist", "cli.js");
const { collectDenials, attributeWorkarounds, auditGuards, firesUnder } = require("../dist/guardAudit.js");
const { DEFAULT_RULES } = require("../dist/guards.js");

const hasSqlite = (() => {
  try {
    require("node:sqlite");
    return true;
  } catch {
    return false;
  }
})();

// The pre-fix rm rule as found in the wild: no exemptions, matches `rm -f`.
const LEGACY_RM = {
  id: "rm-rf",
  type: "bash",
  pattern: "\\brm\\s+(-[a-zA-Z]*\\s+)*-?[a-zA-Z]*r[a-zA-Z]*f|\\brm\\s+-rf?\\b|\\brm\\s+-fr?\\b",
  reason: "Recursive force-delete (rm -rf) is blocked by a reins guard.",
};

function tmpProject(rules = [LEGACY_RM]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reins-gaudit-"));
  fs.mkdirSync(path.join(dir, ".reins"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".reins", "policy.json"), JSON.stringify({ rules }, null, 2));
  return dir;
}

const SCHEMA = `
  CREATE TABLE sessions (id TEXT PRIMARY KEY, repo TEXT, started TEXT, ended TEXT,
    total_tokens INTEGER, total_cost REAL, final_outcome TEXT, name TEXT);
  CREATE TABLE tool_calls (session_id TEXT, seq INTEGER, tool TEXT, input_summary TEXT,
    input_hash TEXT, ok INTEGER, ts TEXT);
  CREATE TABLE outcomes (session_id TEXT, stop_reason TEXT, gate_result TEXT);
`;
const DECISIONS_SCHEMA = `
  CREATE TABLE decisions (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, ts TEXT,
    tool TEXT, input_summary TEXT, input_hash TEXT, rule_id TEXT, rule_reason TEXT,
    decision TEXT, resolution TEXT, resolver TEXT, resolved_ts TEXT, hold_id TEXT);
`;

/** Seed a runs.db. `withDecisions: false` mirrors a pre-0.4 capture file. */
function seedDb(dir, calls, { withDecisions = true } = {}) {
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(path.join(dir, ".reins", "runs.db"));
  db.exec(SCHEMA + (withDecisions ? DECISIONS_SCHEMA : ""));
  db.prepare(`INSERT INTO sessions (id, repo, started) VALUES ('s1', ?, '2026-07-01T00:00:00.000Z')`).run(dir);
  let seq = 0;
  for (const call of calls) {
    const denied = !!call.rule_id;
    db.prepare(
      `INSERT INTO tool_calls (session_id, seq, tool, input_summary, input_hash, ok, ts)
       VALUES (?, ?, 'Bash', ?, ?, ?, ?)`,
    ).run(
      call.session ?? "s1",
      seq++,
      denied ? `DENIED: ${call.command} [guard:${call.rule_id}]` : call.command,
      "h" + seq,
      denied ? 0 : 1,
      call.ts,
    );
    if (denied && withDecisions) {
      db.prepare(
        `INSERT INTO decisions (session_id, ts, tool, input_summary, input_hash, rule_id, decision)
         VALUES (?, ?, 'Bash', ?, ?, ?, 'deny')`,
      ).run(call.session ?? "s1", call.ts, call.command, "h" + seq, call.rule_id);
    }
  }
  db.close();
  return path.join(dir, ".reins", "runs.db");
}

function openRO(dir) {
  const { DatabaseSync } = require("node:sqlite");
  return new DatabaseSync(path.join(dir, ".reins", "runs.db"), { readOnly: true });
}

function runCli(args, cwd) {
  return execFileSync(process.execPath, [CLI, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, CLAUDE_PROJECT_DIR: "" },
  });
}

const T = (mins) => new Date(Date.UTC(2026, 6, 1, 12, mins)).toISOString();

// ---------- collecting ----------

test("collectDenials: reads denials a pre-0.4 capture only kept in tool_calls", { skip: !hasSqlite }, () => {
  const dir = tmpProject();
  seedDb(dir, [{ command: "rm -rf .next", rule_id: "rm-rf", ts: T(0) }], { withDecisions: false });
  const rows = collectDenials(openRO(dir));
  assert.strictEqual(rows.length, 1);
  // The tag is stripped back off, so the command can be re-matched as recorded.
  assert.strictEqual(rows[0].summary, "rm -rf .next");
  assert.strictEqual(rows[0].rule_id, "rm-rf");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("collectDenials: a denial in both tables is counted once", { skip: !hasSqlite }, () => {
  const dir = tmpProject();
  seedDb(dir, [{ command: "rm -rf .next", rule_id: "rm-rf", ts: T(0) }]);
  assert.strictEqual(collectDenials(openRO(dir)).length, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------- verdict: stale ----------

test("firesUnder: today's shipped rules exempt the build artifacts the old one blocked", () => {
  assert.strictEqual(firesUnder([LEGACY_RM], "Bash", "rm -rf .next"), true);
  assert.strictEqual(firesUnder(DEFAULT_RULES, "Bash", "rm -rf .next"), false);
  // ...and still catch what no exemption may ever wave through.
  assert.strictEqual(firesUnder(DEFAULT_RULES, "Bash", "rm -rf /"), true);
});

test("auditGuards: counts denials the shipped rules would not produce", { skip: !hasSqlite }, () => {
  const dir = tmpProject();
  seedDb(dir, [
    { command: "rm -rf .next", rule_id: "rm-rf", ts: T(0) },
    { command: "rm -f /tmp/ours.tsx", rule_id: "rm-rf", ts: T(5) },
    { command: "rm -rf /", rule_id: "rm-rf", ts: T(10) },
  ]);
  const report = auditGuards(openRO(dir), dir);
  assert.strictEqual(report.denials, 3);
  assert.strictEqual(report.stale, 2);
  // The local policy is the stale one, so this is a live problem, not history.
  assert.strictEqual(report.policyBehind, true);
  assert.strictEqual(report.rules[0].rule_id, "rm-rf");
  assert.strictEqual(report.rules[0].stale, 2);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("auditGuards: an already-upgraded project is told these are history", { skip: !hasSqlite }, () => {
  const dir = tmpProject(DEFAULT_RULES);
  seedDb(dir, [{ command: "rm -rf .next", rule_id: "rm-rf", ts: T(0) }]);
  const report = auditGuards(openRO(dir), dir);
  assert.strictEqual(report.stale, 1);
  assert.strictEqual(report.policyBehind, false);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------- verdict: worked around ----------

test("auditGuards: a denial undone by the same command minus a flag", { skip: !hasSqlite }, () => {
  const dir = tmpProject();
  seedDb(dir, [
    { command: "rm -f src/app/harness/page.tsx && rmdir src/app/harness", rule_id: "rm-rf", ts: T(0) },
    { command: "rm src/app/harness/page.tsx && rmdir src/app/harness", ts: T(1) },
  ]);
  const report = auditGuards(openRO(dir), dir);
  assert.strictEqual(report.workedAround, 1);
  const sample = report.rules[0].samples.find((s) => s.workaround);
  assert.ok(sample.workaround.score >= 0.8);
  assert.strictEqual(sample.workaround.gapMs, 60000);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("auditGuards: a different verb on the same target is NOT a workaround", { skip: !hasSqlite }, () => {
  // Found by running this audit over real capture: a denied force-push shares
  // almost every token with an innocent `git fetch` of the same branch, because
  // fingerprinting drops flags. Claiming that as a bypass is the kind of
  // confident-but-wrong output that makes people stop reading the report.
  const dir = tmpProject([
    { id: "git-force-push", type: "bash", pattern: "git\\s+push\\s+.*--force", reason: "no force push" },
  ]);
  seedDb(dir, [
    { command: "cd /repo && git push --force-with-lease origin feat/x", rule_id: "git-force-push", ts: T(0) },
    { command: "cd /repo && git fetch origin feat/x", ts: T(2) },
  ]);
  const report = auditGuards(openRO(dir), dir);
  assert.strictEqual(report.workedAround, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("auditGuards: a retry outside the window is not attributed", { skip: !hasSqlite }, () => {
  const dir = tmpProject();
  seedDb(dir, [
    { command: "rm -rf build", rule_id: "rm-rf", ts: T(0) },
    { command: "rm -r build", ts: T(30) }, // window is 15 minutes
  ]);
  assert.strictEqual(auditGuards(openRO(dir), dir).workedAround, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("auditGuards: another session's call is never someone else's bypass", { skip: !hasSqlite }, () => {
  const dir = tmpProject();
  seedDb(dir, [
    { command: "rm -rf build", rule_id: "rm-rf", ts: T(0) },
    { command: "rm -r build", ts: T(1), session: "s2" },
  ]);
  assert.strictEqual(auditGuards(openRO(dir), dir).workedAround, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------- the command ----------

test("reins audit --guards: reports both verdicts and what to do", { skip: !hasSqlite }, () => {
  const dir = tmpProject();
  seedDb(dir, [
    { command: "rm -rf .next", rule_id: "rm-rf", ts: T(0) },
    { command: "rm -f src/x.tsx", rule_id: "rm-rf", ts: T(5) },
    { command: "rm src/x.tsx", ts: T(6) },
  ]);
  const out = runCli(["audit", "--guards"], dir);
  assert.match(out, /guard audit/);
  assert.match(out, /rm-rf/);
  assert.match(out, /wouldn't fire under today's shipped rules/);
  assert.match(out, /ran anyway/);
  assert.match(out, /reins policy upgrade/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("reins audit --guards --json: the machine-readable shape", { skip: !hasSqlite }, () => {
  const dir = tmpProject();
  seedDb(dir, [{ command: "rm -rf .next", rule_id: "rm-rf", ts: T(0) }]);
  const report = JSON.parse(runCli(["audit", "--guards", "--json"], dir));
  assert.strictEqual(report.denials, 1);
  assert.strictEqual(report.stale, 1);
  assert.strictEqual(report.rules[0].rule_id, "rm-rf");
  assert.strictEqual(report.rules[0].samples[0].firesShipped, false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("reins audit --guards: says so plainly when there is nothing to audit", { skip: !hasSqlite }, () => {
  const dir = tmpProject();
  seedDb(dir, [{ command: "npm test", ts: T(0) }]);
  assert.match(runCli(["audit", "--guards"], dir), /nothing to audit/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("reins audit --guards: a project with no capture at all still exits clean", () => {
  const dir = tmpProject();
  const out = runCli(["audit", "--guards"], dir);
  assert.ok(out.length >= 0); // no runs.db — falls through to the normal audit path
  fs.rmSync(dir, { recursive: true, force: true });
});
