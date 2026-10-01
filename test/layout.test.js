// Run with: npm run build && npm test
// The cockpit at narrow and wide sizes: what is cut, and in which order.
const { test } = require("node:test");
const assert = require("node:assert");
const os = require("node:os");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const R = require("../dist/tui/render.js");
const term = require("../dist/tui/term.js");
const { buildWatchModel } = require("../dist/tui/model.js");
const { getDriver } = require("../dist/store.js");
const { openDbReadOnly } = require("../dist/db.js");

const CLI = path.join(__dirname, "..", "dist", "cli.js");
const hasSqlite = !!getDriver();
const NOW = Date.parse("2026-09-30T12:00:00.000Z");
const ROOT = "/work/app";
const st = new term.Style("none");

const agent = (o) => ({
  id: "3b9f2a1c-1111-2222-3333-444455556666", name: "brave-otter", label: "brave-otter", asked: null, branch: null,
  ended: false, outcome: null, calls: 4, startedMs: NOW - 600_000, lastTsMs: NOW - 120_000, streak: 1,
  steerQueued: null, spark: new Array(24).fill(0), trajectory: [], holds: 0,
  claim: { verdict: "none", text: "", command: null, edited: 0, editedSince: 0, shellWritesSince: 0 },
  footprint: { files: [], dirs: [], outside: 0, commands: [], shellWrites: 0 },
  ...o,
});
const hold = (o = {}) => ({
  action: { id: "26d8a680", session_id: "s1", tool: "Bash", rule_id: "publish-hold", reason: "r", ts: new Date(NOW - 60_000).toISOString(), transport: "deny", input: {} },
  sessionName: "opal-lynx", sessionLabel: "Publish the 0.5 release", asked: null, input: "npm publish", where: "", superseded: false,
  ...o,
});
const model = (o) => ({ repo: ROOT, nowMs: NOW, threshold: 3, captured: true, holds: [], events: [], olderEvents: 0, agents: [], broadcast: null, ...o });
const ui = (width, height, o = {}) => ({ width, height, cursor: 0, zoom: false, detailScroll: 0, modal: null, toast: null, flashUntil: 0, intervalSec: 2, ...o });

const failed = { verdict: "failed", text: "the last test run failed", command: "npm test", edited: 1, editedSince: 0, shellWritesSince: 0 };
const looper = agent({ id: "aaaa1111-0000-0000-0000-000000000000", label: "Fix the login redirect loop", streak: 3, claim: failed });
const idlers = [1, 2, 3].map((n) => agent({ id: `bbbb000${n}-0000-0000-0000-000000000000`, name: `calm-yak-${n}` }));
const live = agent({ id: "cccc0001-0000-0000-0000-000000000000", name: "quick-fox", lastTsMs: NOW - 1000 });

test("header: counts are given up before they run into the clock", () => {
  const m = model({ holds: [hold()], agents: [looper, live, ...idlers] });
  const at = (w) => R.renderScreen(m, ui(w, 24), st)[0];
  const wide = at(150);
  assert.match(wide, /1 needs you.* 1 active .* 1 looping .* 3 idle\s+every 2s · \d\d:\d\d:\d\d $/);

  for (const w of [60, 70, 80, 90, 104]) {
    const line = at(w);
    assert.strictEqual(term.width(line), w);
    assert.doesNotMatch(line, /…/, `nothing is cut mid-word at ${w}`);
    assert.match(line, / {2}(every 2s · )?\d\d:\d\d:\d\d $/, `the clock stands clear at ${w}`);
    assert.match(line, /1 needs you/);
  }
  assert.match(at(80), /1 looping/, "looping outlasts the idle count");
  assert.doesNotMatch(at(80), /every/);
  assert.doesNotMatch(at(60), /idle|active/);
});

test("agent row: a long title is cut before the status and the verdict are", () => {
  const long = agent({ label: "Upgrade eslint to v9 and fix what breaks across the whole monorepo", ended: true, claim: { ...failed, verdict: "verified", text: "tests passed" } });
  for (const w of [60, 80, 150]) {
    const out = R.renderScreen(model({ agents: [long, looper] }), ui(w, 24), st).join("\n");
    assert.match(out, /Upgrade eslint[^\n]*… {2}done {2}✓ checked +4 │/, `status and verdict survive at ${w}`);
    assert.doesNotMatch(out, /……/);
    assert.match(out, /looping {2}✗ checks failed/);
  }
});

test("hold row: the session label is cut before the rule id, and never touches it", () => {
  const m = model({ holds: [hold()], agents: [looper] });
  const row = R.renderScreen(m, ui(104, 30), st)[2];
  assert.match(row, /◆ HELD Bash {2}publish-hold Publish the 0\.5… · 1m /);
  assert.match(R.renderScreen(m, ui(80, 24), st)[2], /publish-hold +Publish the 0\.5 release · 1m /);
});

test("inProject: a path under the project is shown from its root", () => {
  assert.strictEqual(R.inProject("/work/app/src/a.ts", ROOT), "src/a.ts");
  assert.strictEqual(R.inProject("C:\\work\\app\\src\\a.ts", "C:\\work\\app"), "src\\a.ts");
  assert.strictEqual(R.inProject("/work/application/a.ts", ROOT), "/work/application/a.ts", "a sibling directory is not inside");
  assert.strictEqual(R.inProject("/etc/hosts", ROOT), "/etc/hosts");
  assert.strictEqual(R.inProject("/work/app", ROOT), "/work/app");
  assert.strictEqual(R.inProject("/work/app/x", ""), "/work/app/x");

  const a = agent({ trajectory: [{ tool: "Read", summary: `${ROOT}/README.md`, kind: "ok", ruleId: null, tsMs: NOW, streak: 1 }] });
  const b = agent({ id: "dddd0001-0000-0000-0000-000000000000", trajectory: [{ tool: "Bash", summary: `cat ${ROOT}/README.md`, kind: "ok", ruleId: null, tsMs: NOW, streak: 1 }] });
  const out = R.renderScreen(model({ agents: [a, b] }), ui(80, 24), st).join("\n");
  assert.match(out, /› Read {3}README\.md/);
  assert.match(out, /› Bash {3}cat \/work\/app\/README\.md/, "a command is shown as it was run");
});

test("help and approve dialogs fit a narrow terminal", () => {
  const m = model({ holds: [hold()] });
  const help = R.renderScreen(m, ui(80, 24, { modal: { kind: "help" } }), st).join("\n");
  assert.match(help, /J K {2}pgup\/dn {3}scroll the detail pane/);
  const narrow = R.renderScreen(m, ui(60, 20, { modal: { kind: "approve", holdId: "26d8a680", scroll: 0 } }), st).join("\n");
  assert.match(narrow, /Approve this exact call, once\? +│/, "the heading is whole, without a cut second sentence");
  const wide = R.renderScreen(m, ui(120, 30, { modal: { kind: "approve", holdId: "26d8a680", scroll: 0 } }), st).join("\n");
  assert.match(wide, /Any change to it is a new proposal and parks again\./);
});

test("buildWatchModel: a looping session is listed first, the rest newest first", { skip: !hasSqlite }, () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "reins-layout-")));
  fs.mkdirSync(path.join(dir, ".reins"), { recursive: true });
  const env = { ...process.env, CLAUDE_PROJECT_DIR: dir, NO_COLOR: "1" };
  const did = (session, command) =>
    execFileSync(process.execPath, [CLI, "hook", "post-tool"], {
      cwd: dir,
      env,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "ignore"],
      input: JSON.stringify({ cwd: dir, session_id: session, tool_name: "Bash", tool_input: { command }, tool_response: {} }),
    });
  try {
    for (let i = 0; i < 3; i++) did("loop-1", "npm test");
    did("fresh-1", "ls");
    did("fresh-2", "pwd");
    const before = process.env.CLAUDE_PROJECT_DIR;
    process.env.CLAUDE_PROJECT_DIR = dir;
    let m;
    try {
      const db = openDbReadOnly(dir);
      m = buildWatchModel(db, dir, 3);
      db.close();
    } finally {
      if (before === undefined) delete process.env.CLAUDE_PROJECT_DIR;
      else process.env.CLAUDE_PROJECT_DIR = before;
    }
    assert.deepStrictEqual(m.agents.map((a) => a.id), ["loop-1", "fresh-2", "fresh-1"]);
    assert.deepStrictEqual(R.listRows(m).map((r) => r.id), ["loop-1", "fresh-2", "fresh-1"], "the cursor walks the same order");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
