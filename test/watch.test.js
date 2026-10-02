// Run with: npm run build && npm test
// The `reins watch` cockpit: the pure renderer, the terminal primitives it is
// built on, the file-backed model, and the checks that make approving from a
// keypress as safe as typing `reins approve`.
const { test } = require("node:test");
const assert = require("node:assert");
const os = require("node:os");
const fs = require("node:fs");
const path = require("node:path");

const term = require("../dist/tui/term.js");
const R = require("../dist/tui/render.js");
const { buildWatchModel, liveness } = require("../dist/tui/model.js");
const { reloadForDecision } = require("../dist/holdActions.js");

const plain = new term.Style("none");
const color = new term.Style("truecolor");
const NOW = Date.parse("2026-09-30T12:00:00.000Z");

function agent(over) {
  return {
    id: "3b9f2a1c-1111-2222-3333-444455556666",
    name: "brave-otter",
    ended: false,
    outcome: null,
    calls: 4,
    startedMs: NOW - 600_000,
    lastTsMs: NOW - 1_000,
    streak: 1,
    steerQueued: null,
    spark: new Array(24).fill(0).map((_, i) => i % 3),
    trajectory: [{ tool: "Bash", summary: "npm test", kind: "ok", ruleId: null, tsMs: NOW - 1_000, streak: 1 }],
    holds: 0,
    ...over,
  };
}

function hold(over = {}, input = "git push origin main") {
  return {
    action: {
      id: "e8e88a97",
      session_id: "2808668f-0000-0000-0000-000000000000",
      tool: "Bash",
      input: { command: input },
      input_hash: "h1",
      transport: "deny",
      rule_id: "push-hold",
      reason: "Pushing waits for sign-off.",
      ts: new Date(NOW - 3 * 86400_000).toISOString(),
      ...over,
    },
    sessionName: "civil-moose",
    input,
    where: "",
    superseded: false,
  };
}

function model(over) {
  return {
    repo: "/Users/me/reins",
    nowMs: NOW,
    threshold: 3,
    captured: true,
    holds: [],
    events: [],
    olderEvents: 0,
    agents: [agent()],
    broadcast: null,
    ...over,
  };
}

function ui(over) {
  return {
    width: 140,
    height: 40,
    cursor: 0,
    zoom: false,
    detailScroll: 0,
    modal: null,
    toast: null,
    flashUntil: 0,
    intervalSec: 2,
    ...over,
  };
}

const screen = (m, u, st = plain) => R.renderScreen(m, u, st).join("\n");

/* ------------------------------------------------------------ primitives */

test("term.clean: escape sequences in agent text can't reach the terminal", () => {
  // OSC 52 would write the clipboard; CSI would move the cursor over the prompt.
  const hostile = "echo hi\x1b]52;c;cm0gLXJmIC8=\x07\x1b[2J\x1b[H\r\x9b";
  const out = term.clean(hostile);
  assert.ok(!out.includes("\x1b"), "no ESC survives");
  assert.ok(!out.includes("\x07"), "no BEL survives");
  assert.ok(!out.includes("\x9b"), "no C1 CSI survives");
  assert.match(out, /␛/, "the escape is shown, not hidden");
  assert.strictEqual(term.clean("a\nb", true), "a\nb");
  assert.strictEqual(term.clean("a\nb"), "a b");
});

test("term.width/fit: styled and wide text measure by columns", () => {
  assert.strictEqual(term.width(color.fg("bad", "abc")), 3);
  assert.strictEqual(term.width("日本"), 4);
  assert.strictEqual(term.width(term.fit("hello world", 8)), 8);
  assert.match(term.fit("hello world", 8), /…$/);
  assert.strictEqual(term.width(term.fit(color.bold("日本語テキスト"), 7)), 7);
  assert.strictEqual(term.fit("ab", 5), "ab   ");
});

test("term.wrap: words wrap, long tokens hard-break, blank lines survive", () => {
  assert.deepStrictEqual(term.wrap("aa bb cc", 5), ["aa bb", "cc"]);
  assert.deepStrictEqual(term.wrap("abcdefghij", 4), ["abcd", "efgh", "ij"]);
  assert.deepStrictEqual(term.wrap("a\n\nb", 10), ["a", "", "b"]);
});

test("term.sparkline: scales to its own peak; zero is blank", () => {
  assert.strictEqual(term.sparkline([0, 0]), "  ");
  const s = term.sparkline([0, 1, 8]);
  assert.strictEqual(s[0], " ");
  assert.strictEqual(s[2], "█");
});

test("term.detectColorMode: NO_COLOR and pipes get none", () => {
  assert.strictEqual(term.detectColorMode(false, {}), "none");
  assert.strictEqual(term.detectColorMode(true, { NO_COLOR: "1", COLORTERM: "truecolor" }), "none");
  assert.strictEqual(term.detectColorMode(true, { COLORTERM: "truecolor" }), "truecolor");
});

/* -------------------------------------------------------------- geometry */

test("renderScreen: always exactly height lines of exactly width columns", () => {
  const m = model({ holds: [hold()], agents: [agent(), agent({ id: "bbbbbbbb-x", name: "b" })] });
  for (const [w, h] of [
    [140, 40],
    [104, 20],
    [90, 30],
    [60, 14],
    [40, 10],
  ]) {
    for (const st of [plain, color]) {
      for (const extra of [{}, { zoom: true }, { modal: { kind: "help" } }, { modal: { kind: "approve", holdId: "e8e88a97", scroll: 0 } }]) {
        const lines = R.renderScreen(m, ui({ width: w, height: h, ...extra }), st);
        assert.strictEqual(lines.length, h, `${w}x${h} line count`);
        for (const l of lines) assert.strictEqual(term.width(l), w, `${w}x${h} ${JSON.stringify(extra)} width`);
      }
    }
  }
});

test("renderScreen: too small says so instead of drawing garbage", () => {
  assert.match(screen(model(), ui({ width: 50, height: 10 })), /needs at least 60×14/);
});

/* ------------------------------------------------------------- content */

test("renderScreen: held actions lead, with the hold's rule, session and age", () => {
  const out = screen(model({ holds: [hold()] }), ui());
  assert.match(out, /NEEDS YOU/);
  assert.match(out, /HELD Bash/);
  assert.match(out, /push-hold/);
  assert.match(out, /civil-moose/);
  assert.match(out, /3d 0h/);
  assert.ok(out.indexOf("NEEDS YOU") < out.indexOf("AGENTS"));
});

test("renderScreen: an empty queue reads as clear, not as missing", () => {
  const out = screen(model(), ui());
  assert.match(out, /nothing is waiting on you/);
  assert.match(out, /all clear/);
});

test("renderScreen: the selected hold's detail shows the full input", () => {
  const long = Array.from({ length: 8 }, (_, i) => `step ${i}`).join("\n");
  const out = screen(model({ holds: [hold({}, long)] }), ui());
  for (let i = 0; i < 8; i++) assert.match(out, new RegExp(`step ${i}`));
  assert.match(out, /deny — approving lets the identical retry/);
});

test("renderScreen: hostile hold input is shown inert", () => {
  const out = R.renderScreen(model({ holds: [hold({}, "x\x1b]52;c;ZXZpbA==\x07y")] }), ui(), color).join("");
  assert.ok(!out.includes("\x1b]52"), "the OSC 52 sequence is not emitted");
  assert.ok(!out.includes("\x07"));
});

test("renderScreen: superseded deferred holds are flagged", () => {
  const h = { ...hold({ transport: "defer", tool_use_id: "toolu_1" }), superseded: true };
  assert.match(screen(model({ holds: [h] }), ui()), /superseded/);
});

test("renderScreen: breaches and bypasses appear under NEEDS YOU with advice", () => {
  const ev = { kind: "bypass", sessionId: "s1", ts: new Date(NOW - 60_000).toISOString(), tool: "Bash", summary: "rm -r build", ruleId: "rm-rf", detail: "Denied 9s earlier" };
  const m = model({ events: [ev] });
  const out = screen(m, ui());
  assert.match(out, /WORKED AROUND/);
  assert.match(out, /reins guard remove[\s│]+rm-rf/);
});

test("renderScreen: capture off keeps the holds and explains the agent pane", () => {
  const out = screen(model({ captured: false, agents: [], holds: [hold()] }), ui());
  assert.match(out, /capture is off/);
  assert.match(out, /HELD Bash/);
});

test("renderScreen: queued steering shows on the agent", () => {
  const out = screen(model({ agents: [agent({ steerQueued: "stay on payments" })] }), ui());
  assert.match(out, /steer queued/);
  assert.match(out, /stay on payments/);
});

test("renderScreen: agent detail shows the trajectory newest first", () => {
  const traj = ["a.ts", "b.ts", "c.ts"].map((f, i) => ({ tool: "Read", summary: f, kind: "ok", ruleId: null, tsMs: NOW - (3 - i) * 1000, streak: 1 }));
  const out = screen(model({ agents: [agent({ trajectory: traj })] }), ui());
  assert.ok(out.indexOf("c.ts") < out.indexOf("b.ts") && out.indexOf("b.ts") < out.indexOf("a.ts"));
  assert.match(out, /trajectory · newest first/);
});

test("renderScreen: denied and held calls carry their glyphs and rule", () => {
  const traj = [
    { tool: "Bash", summary: "rm -rf build", kind: "denied", ruleId: "rm-rf", tsMs: NOW, streak: 1 },
    { tool: "Bash", summary: "git push", kind: "held", ruleId: "push-hold", tsMs: NOW, streak: 1 },
  ];
  const out = screen(model({ agents: [agent({ trajectory: traj })] }), ui());
  assert.match(out, /⊘ Bash\s+denied rm -rf build \[rm-rf\]/);
  assert.match(out, /◆ Bash\s+held git push \[push-hold\]/);
});

test("renderScreen: hints follow the selection", () => {
  const onHold = screen(model({ holds: [hold()] }), ui({ cursor: 0 }));
  assert.match(onHold, /a approve/);
  const onAgent = screen(model({ holds: [hold()] }), ui({ cursor: 1 }));
  assert.ok(!/a approve/.test(onAgent));
  assert.match(onAgent, /s steer/);
});

test("renderScreen: a new hold flashes the header pill", () => {
  const m = model({ holds: [hold()] });
  assert.match(screen(m, ui({ flashUntil: NOW + 1000 })), /1 NEEDS YOU/);
  assert.match(screen(m, ui({ flashUntil: 0 })), /1 needs you/);
});

/* ------------------------------------------------------------ liveness */

test("liveness: active, idle, done, and ended-but-recent reads active", () => {
  assert.strictEqual(liveness(agent({ lastTsMs: NOW - 1000 }), NOW, 3), "active");
  assert.strictEqual(liveness(agent({ lastTsMs: NOW - 120_000 }), NOW, 3), "idle");
  assert.strictEqual(liveness(agent({ lastTsMs: NOW - 120_000, ended: true }), NOW, 3), "done");
  // Claude Code fires Stop at every turn boundary; recent activity wins.
  assert.strictEqual(liveness(agent({ lastTsMs: NOW - 2000, ended: true }), NOW, 3), "active");
});

test("liveness: looping is a consecutive streak, like the loop alarm", () => {
  assert.strictEqual(liveness(agent({ streak: 3 }), NOW, 3), "looping");
  assert.strictEqual(liveness(agent({ streak: 2 }), NOW, 3), "active");
});

/* ------------------------------------------------------------ approving */

test("approve modal: locked until the whole input has been scrolled through", () => {
  const long = Array.from({ length: 200 }, (_, i) => `echo ${i}`).join("\n");
  const m = model({ holds: [hold({}, long)] });
  const u = ui({ modal: { kind: "approve", holdId: "e8e88a97", scroll: 0 } });
  assert.strictEqual(R.approveSeenAll(m, u, plain, "e8e88a97", 0), false);
  assert.match(screen(m, u), /read to the end to enable approve/);
  assert.match(screen(m, u), /y unlocks at the end/);

  const { lines, view } = R.approveBody(m, u, plain, "e8e88a97");
  const end = lines.length - view;
  assert.strictEqual(R.approveSeenAll(m, u, plain, "e8e88a97", end), true);
  const done = screen(m, ui({ modal: { kind: "approve", holdId: "e8e88a97", scroll: end } }));
  assert.match(done, /y approve once/);
  assert.match(done, /echo 199/, "the last line of the input is on screen");
});

test("approve modal: a short input is approvable immediately", () => {
  const m = model({ holds: [hold()] });
  assert.strictEqual(R.approveSeenAll(m, ui(), plain, "e8e88a97", 0), true);
});

test("approve modal: targets the hold by id, not by cursor position", () => {
  const a = hold({ id: "aaaa0001" }, "first");
  const b = hold({ id: "bbbb0002" }, "second");
  // Cursor on a, modal opened for b: the modal must show b.
  const out = screen(model({ holds: [a, b] }), ui({ cursor: 0, modal: { kind: "approve", holdId: "bbbb0002", scroll: 0 } }));
  const modal = out.slice(out.indexOf("APPROVE"));
  assert.match(modal, /second/);
});

test("steer modal: shows what's already queued and that new text appends", () => {
  const m = model({ agents: [agent({ steerQueued: "use pnpm" })] });
  const out = screen(m, ui({ modal: { kind: "steer", target: m.agents[0].id, text: "and skip e2e" } }));
  assert.match(out, /use pnpm/);
  assert.match(out, /appended; nothing queued is dropped/);
  assert.match(out, /and skip e2e/);
});

test("selection helpers: rows run holds → events → agents; steer target follows", () => {
  const ev = { kind: "breach", sessionId: "s9", ts: new Date(NOW).toISOString(), tool: "Bash", summary: "x", ruleId: "", detail: "" };
  const m = model({ holds: [hold()], events: [ev] });
  const rows = R.listRows(m);
  assert.deepStrictEqual(rows.map((r) => r.kind), ["hold", "event", "agent"]);
  assert.strictEqual(R.steerTarget(m, rows[0]), "2808668f-0000-0000-0000-000000000000");
  assert.strictEqual(R.steerTarget(m, rows[1]), "s9");
  assert.strictEqual(R.steerTarget(m, rows[2]), m.agents[0].id);
});

/* ------------------------------------------------- model + decision checks */

function tmpProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reins-watch-"));
  fs.mkdirSync(path.join(dir, ".reins", "pending"), { recursive: true });
  return dir;
}

function park(dir, over = {}) {
  const p = {
    id: "abcd1234",
    session_id: "sess-1",
    tool: "Bash",
    input: { command: "npm publish" },
    input_hash: "h1",
    // The hook stores the resolved directory (proposalWorkdir), not the spelling.
    cwd: fs.realpathSync(dir),
    transport: "deny",
    rule_id: "publish-hold",
    reason: "Publishing waits for sign-off.",
    ts: new Date().toISOString(),
    ...over,
  };
  fs.writeFileSync(path.join(dir, ".reins", "pending", p.id + ".json"), JSON.stringify(p));
  return p;
}

/** Run fn with cwd in `dir` and project discovery pinned to it. */
function inProject(dir, fn) {
  const cwd = process.cwd();
  const env = process.env.CLAUDE_PROJECT_DIR;
  process.chdir(dir);
  process.env.CLAUDE_PROJECT_DIR = "";
  try {
    return fn();
  } finally {
    process.chdir(cwd);
    if (env === undefined) delete process.env.CLAUDE_PROJECT_DIR;
    else process.env.CLAUDE_PROJECT_DIR = env;
  }
}

test("buildWatchModel: holds come from files, with no DB at all", () => {
  const dir = tmpProject();
  try {
    park(dir);
    const m = buildWatchModel(null, dir, 3);
    assert.strictEqual(m.captured, false);
    assert.strictEqual(m.holds.length, 1);
    assert.strictEqual(m.holds[0].input, "npm publish");
    assert.strictEqual(m.holds[0].where, "", "the project root is the empty label");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("reloadForDecision: refuses a hold that is gone or no longer what was reviewed", () => {
  const dir = tmpProject();
  try {
    const p = park(dir);
    inProject(dir, () => {
      assert.strictEqual(reloadForDecision("abcd1234", p).ok, true);
      assert.deepStrictEqual(reloadForDecision("abcd1234", { ...p, input_hash: "other" }), { ok: false, reason: "changed" });
      assert.deepStrictEqual(reloadForDecision("abcd1234", { ...p, cwd: "/elsewhere" }), { ok: false, reason: "changed" });
      // A prefix is not an id: the TUI approves exactly what it showed.
      assert.deepStrictEqual(reloadForDecision("abcd", p), { ok: false, reason: "gone" });
      fs.rmSync(path.join(dir, ".reins", "pending", "abcd1234.json"));
      assert.deepStrictEqual(reloadForDecision("abcd1234", p), { ok: false, reason: "gone" });
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("renderSnapshot: piped output lists holds with the commands to answer them", () => {
  const out = R.renderSnapshot(model({ holds: [hold()] }), plain, 100);
  assert.match(out, /NEEDS YOU \(1\)/);
  assert.match(out, /reins approve e8e88a97/);
  assert.match(out, /brave-otter/);
  assert.ok(!out.includes("\x1b"), "no styling when piped");
});

/* ------------------------------------------------- what a session is about */

const { parseTail, readSessionContext } = require("../dist/sessionContext.js");
const { execFileSync } = require("node:child_process");
const CLI = path.join(__dirname, "..", "dist", "cli.js");

const line = (o) => JSON.stringify(o);

test("parseTail: the newest title and prompt win, and /rename beats the generated title", () => {
  const ctx = parseTail(
    [
      line({ type: "ai-title", aiTitle: "Old title" }),
      line({ type: "last-prompt", lastPrompt: "first ask" }),
      line({ type: "user", gitBranch: "main", message: { content: "hi" } }),
      line({ type: "ai-title", aiTitle: "Cockpit session names" }),
      line({ type: "last-prompt", lastPrompt: "make the names\nreadable" }),
      line({ type: "assistant", gitBranch: "feat/watch-cockpit" }),
    ].join("\n"),
  );
  assert.deepStrictEqual(ctx, { title: "Cockpit session names", asked: "make the names readable", branch: "feat/watch-cockpit" });

  const renamed = parseTail([line({ type: "custom-title", customTitle: "Auth refactor" }), line({ type: "ai-title", aiTitle: "Later generated" })].join("\n"));
  assert.strictEqual(renamed.title, "Auth refactor");
});

test("parseTail: a tool result that quotes a title line is not a title", () => {
  const quoted = line({ type: "user", message: { content: line({ type: "ai-title", aiTitle: "Injected", gitBranch: "evil" }) } });
  assert.deepStrictEqual(parseTail(quoted + "\nnot json\n"), { title: null, asked: null, branch: null });
});

test("readSessionContext: reads the tail of a large transcript; anything unreadable is empty", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reins-ctx-"));
  try {
    const file = path.join(dir, "s.jsonl");
    const big = line({ type: "user", message: { content: "x".repeat(400_000) } });
    fs.writeFileSync(file, [line({ type: "ai-title", aiTitle: "Stale" }), big, line({ type: "ai-title", aiTitle: "Fresh" })].join("\n") + "\n");
    assert.strictEqual(readSessionContext(file).title, "Fresh");
    assert.strictEqual(readSessionContext(path.join(dir, "missing.jsonl")).title, null);
    assert.strictEqual(readSessionContext(dir).title, null);
    fs.writeFileSync(path.join(dir, "notes.txt"), line({ type: "ai-title", aiTitle: "Not a transcript" }));
    assert.strictEqual(readSessionContext(path.join(dir, "notes.txt")).title, null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("buildWatchModel: a session leads with its transcript title; the mnemonic still addresses it", () => {
  const { getDriver } = require("../dist/store.js");
  if (!getDriver()) return; // no SQLite backend on this Node: capture disabled, skip
  const { openDbReadOnly } = require("../dist/db.js");
  const dir = tmpProject();
  let db = null;
  try {
    const transcript = path.join(dir, "t.jsonl");
    fs.writeFileSync(
      transcript,
      [line({ type: "ai-title", aiTitle: "Publish the 0.5 release" }), line({ type: "last-prompt", lastPrompt: "cut the release" }), line({ type: "user", gitBranch: "release/0.5.0" })].join("\n") + "\n",
    );
    const sid = "sess-1";
    execFileSync(process.execPath, [CLI, "hook", "post-tool"], {
      cwd: dir,
      env: { ...process.env, CLAUDE_PROJECT_DIR: dir },
      input: JSON.stringify({ session_id: sid, cwd: dir, transcript_path: transcript, tool_name: "Bash", tool_input: { command: "npm test" }, tool_response: {} }),
    });
    park(dir, { session_id: sid });
    db = inProject(dir, () => openDbReadOnly(dir));
    const m = buildWatchModel(db, dir, 3);
    const a = m.agents[0];
    assert.strictEqual(a.label, "Publish the 0.5 release");
    assert.match(a.name, /^[a-z]+-[a-z]+$/, "the steer-able name is still the mnemonic");
    assert.strictEqual(a.asked, "cut the release");
    assert.strictEqual(a.branch, "release/0.5.0");
    assert.strictEqual(m.holds[0].sessionLabel, "Publish the 0.5 release");

    const screen = R.renderScreen(m, ui({ width: 140, height: 30 }), plain).join("\n");
    assert.match(screen, /Publish the 0\.5 release/);
    assert.match(screen, /⎇ release\/0\.5\.0/);
    assert.match(screen, /❯ cut the release/);
    assert.ok(screen.includes(a.name), "the mnemonic is still on screen");
  } finally {
    if (db) db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("renderScreen: a session with no transcript shows its mnemonic, as before", () => {
  const out = R.renderScreen(model({}), ui({ width: 140, height: 30 }), plain).join("\n");
  assert.match(out, /brave-otter/);
  assert.match(out, /3b9f2a1c/);
});
