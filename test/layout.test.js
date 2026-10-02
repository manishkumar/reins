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
    assert.match(out, /Upgrade eslint[^\n]*… {2}done {2}✓ checked +│/, `status and verdict survive at ${w}`);
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

/* ------------------------------------------------- what a human reads first */

const { whyMatched } = require("../dist/tui/why.js");
const { firingSegment } = require("../dist/guards.js");
const pushRule = { id: "push-hold", type: "bash", pattern: "git\\s+push\\b", reason: "r", action: "hold" };

test("whyMatched: finds the text the guard fired on, by line", () => {
  const script = ["cd pkg", "npm run build", "echo done", "git  push origin main", "echo pushed"].join("\n");
  const m = whyMatched(pushRule, script);
  assert.strictEqual(script.slice(m.start, m.end), "git  push");
  assert.deepStrictEqual([m.line, m.lines], [4, 5]);
  assert.strictEqual(firingSegment(pushRule, script), "git  push origin main", "the same segment the guard decides on");

  assert.strictEqual(whyMatched(pushRule, 'git commit -m "then git push"'), null, "a rule that does not fire has no match to show");
  assert.strictEqual(whyMatched(undefined, script), null, "a rule removed since the action parked");
  assert.strictEqual(whyMatched({ ...pushRule, type: "path" }, script), null);

  // An exempt segment is skipped, as the guard skips it.
  const rm = { id: "rm", type: "bash", pattern: "\\brm\\b.*-r", except: ["^build$"], reason: "r", action: "hold" };
  const cmd = "rm -r build && rm -r src";
  const hit = whyMatched(rm, cmd);
  assert.strictEqual(cmd.slice(hit.start), "rm -r src");
  assert.strictEqual(cmd.slice(hit.start, hit.end), "rm -r");
});

test("hold detail: a match far down a long command is lifted above the input", () => {
  const input = [...Array.from({ length: 30 }, (_, i) => `echo step ${i}`), "git push origin main", "echo after"].join("\n");
  const far = hold({ input, match: whyMatched(pushRule, input), lastActiveMs: null });
  const out = R.renderScreen(model({ holds: [far] }), ui(150, 40), st);
  const text = out.join("\n");
  assert.match(text, /the rule matched line 31 of 32/);
  const why = out.findIndex((l) => /the rule matched line/.test(l));
  const full = out.findIndex((l) => /proposed Bash input/.test(l));
  assert.ok(why > 0 && why < full, "it comes before the full input");
  assert.match(out[why + 1], /▶ git push origin main/);
  assert.strictEqual(R.holdDetail(far, model({}), st, 80).filter((l) => l.startsWith("▶ ")).length, 2, "and is marked again in place");

  const { lines } = R.approveBody(model({ holds: [far] }), ui(150, 40), st, far.action.id);
  assert.ok(lines.some((l) => /the rule matched line 31 of 32/.test(l)), "the approve dialog shows it too");

  const near = hold({ input: "git push origin main", match: whyMatched(pushRule, "git push origin main"), lastActiveMs: null });
  const short = R.holdDetail(near, model({}), st, 80).join("\n");
  assert.doesNotMatch(short, /the rule matched line/, "a match already in view is not repeated");
  assert.match(short, /▶ git push origin main/);
});

test("hold detail: dates read the same in any locale, and a quiet session is said", () => {
  assert.strictEqual(R.stamp(new Date(2026, 8, 10, 22, 50).getTime(), new Date(2026, 9, 2).getTime()), "10 Sep 22:50");
  assert.strictEqual(R.stamp(new Date(2025, 0, 3, 9, 5).getTime(), new Date(2026, 9, 2).getTime()), "3 Jan 2025 09:05");

  const quiet = R.holdDetail(hold({ match: null, lastActiveMs: NOW - 3 * 86400_000 }), model({}), st, 100).join("\n");
  assert.match(quiet, /the session's last call was 3d 0h ago; an approval is used only if it retries this call/);
  const recent = R.holdDetail(hold({ match: null, lastActiveMs: NOW - 60_000 }), model({}), st, 100).join("\n");
  assert.doesNotMatch(recent, /last call was/);
});

test("agent row: an untitled session takes two lines, the count is labeled, and an unseen result has no chip", () => {
  const unseen = { ...failed, verdict: "unknown", text: "the last test run's result is not visible" };
  const bare = agent({ ended: true, claim: unseen });
  const titled = agent({ id: "eeee0001-0000-0000-0000-000000000000", label: "Fix the parser", asked: "fix it", ended: true });
  const out = R.renderScreen(model({ agents: [bare, titled] }), ui(150, 24), st);
  const at = out.findIndex((l) => /brave-otter 3b9f2a1c {2}done/.test(l));
  assert.ok(at > 0, "the id sits beside the mnemonic");
  assert.match(out[at], /4 calls │/);
  assert.doesNotMatch(out[at], /result unseen/);
  assert.match(out[at + 1], /\(no calls yet\)/);
  assert.match(out[at + 2], /Fix the parser {2}done/, "the next session starts on the third line");
  assert.match(out[at + 3], /brave-otter eeee0001 · ❯ fix it/);

  const detail = R.detailContent(model({ agents: [bare] }), st, { kind: "agent", id: bare.id }, 80).lines.join("\n");
  assert.match(detail, /\? the last test run's result is not visible/, "the detail pane still says it");
});

test("agents box: sessions quiet for over a day are counted in the footer", () => {
  const out = R.renderScreen(model({ agents: [looper], quietAgents: 9 }), ui(104, 24), st).join("\n");
  assert.match(out, /9 quiet for over a day · reins sessions/);
});

test("buildWatchModel: a session with a held action leads the quiet ones, and old sessions are counted", { skip: !hasSqlite }, () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "reins-order-")));
  fs.mkdirSync(path.join(dir, ".reins", "pending"), { recursive: true });
  const env = { ...process.env, CLAUDE_PROJECT_DIR: dir, NO_COLOR: "1" };
  const did = (session, command) =>
    execFileSync(process.execPath, [CLI, "hook", "post-tool"], {
      cwd: dir,
      env,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "ignore"],
      input: JSON.stringify({ cwd: dir, session_id: session, tool_name: "Bash", tool_input: { command }, tool_response: {} }),
    });
  const build = (o) => {
    const before = process.env.CLAUDE_PROJECT_DIR;
    process.env.CLAUDE_PROJECT_DIR = dir;
    try {
      const db = openDbReadOnly(dir);
      const m = buildWatchModel(db, dir, 3, o);
      db.close();
      return m;
    } finally {
      if (before === undefined) delete process.env.CLAUDE_PROJECT_DIR;
      else process.env.CLAUDE_PROJECT_DIR = before;
    }
  };
  try {
    did("holder", "ls");
    did("fresh-1", "ls");
    did("fresh-2", "pwd");
    fs.writeFileSync(
      path.join(dir, ".reins", "pending", "abcd1234.json"),
      JSON.stringify({ id: "abcd1234", session_id: "holder", tool: "Bash", input: { command: "echo a\necho b\necho c\ngit push" }, input_hash: "h", cwd: dir, transport: "deny", rule_id: "push-hold", reason: "r", ts: new Date().toISOString() }),
    );
    fs.writeFileSync(path.join(dir, ".reins", "policy.json"), JSON.stringify({ version: 2, rules: [pushRule] }));

    const m = build();
    assert.deepStrictEqual(m.agents.map((a) => a.id), ["holder", "fresh-2", "fresh-1"]);
    assert.strictEqual(m.quietAgents, 0);
    assert.strictEqual(m.holds[0].match.line, 4, "the model carries where the rule matched");

    const later = build({ nowMs: Date.now() + 2 * 86400_000 });
    assert.deepStrictEqual(later.agents.map((a) => a.id), ["holder"], "the one with something waiting stays listed");
    assert.strictEqual(later.quietAgents, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
