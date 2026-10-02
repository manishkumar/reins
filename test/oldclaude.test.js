// Run with: npm run build && npm test
// Claude Code 2.0.55 and older load no hooks from a settings file that names
// PostToolUseFailure (measured: docs/open-questions.md, item 3). init leaves
// the hook out there, and doctor says when a file would be ignored.
const { test } = require("node:test");
const assert = require("node:assert");
const os = require("node:os");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const V = require("../dist/claudeVersion.js");
const { mergeReinsHooks } = require("../dist/settingsMerge.js");
const { settingsBlockJson } = require("../dist/settingsBlock.js");

const CLI = path.join(__dirname, "..", "dist", "cli.js");
const project = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "reins-oldcc-")));
const run = (dir, version, ...args) =>
  spawnSync(process.execPath, [CLI, ...args], {
    cwd: dir,
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1", CLAUDE_PROJECT_DIR: dir, REINS_CLAUDE_VERSION: version },
  });
const hooksIn = (dir) => JSON.parse(fs.readFileSync(path.join(dir, ".claude", "settings.json"), "utf8")).hooks;

test("version: parsing and the boundary at 2.0.56", () => {
  assert.strictEqual(V.parseVersion("2.1.287 (Claude Code)"), "2.1.287");
  assert.strictEqual(V.parseVersion("command not found"), null);
  assert.strictEqual(V.predatesFailureHook("2.0.55"), true);
  assert.strictEqual(V.predatesFailureHook("1.0.128"), true);
  assert.strictEqual(V.predatesFailureHook("2.0.56"), false);
  assert.strictEqual(V.predatesFailureHook("2.1.0"), false);
  assert.strictEqual(V.predatesFailureHook("2.10.3"), false, "compared as numbers, not text");
  assert.strictEqual(V.predatesFailureHook(null), false, "unknown is not known to be old");
  assert.strictEqual(V.mayWriteFailureHook(null), false, "and not known to be current: the hook needs evidence");
  assert.strictEqual(V.mayWriteFailureHook("2.0.56"), true);
  assert.strictEqual(V.mayWriteFailureHook("2.0.55"), false);
});

test("mergeReinsHooks: an event left out is not added, and reins' own entry for it is taken out", () => {
  const fresh = mergeReinsHooks({}, ["PostToolUseFailure"]);
  assert.strictEqual(fresh.added, 3);
  assert.ok(!("PostToolUseFailure" in fresh.settings.hooks));

  const theirs = { matcher: "Bash", hooks: [{ type: "command", command: "./notify.sh" }] };
  const full = mergeReinsHooks({}).settings;
  full.hooks.PostToolUseFailure.push(theirs);
  const repaired = mergeReinsHooks(full, ["PostToolUseFailure"]);
  assert.strictEqual(repaired.added, 0);
  assert.strictEqual(repaired.removed, 1);
  assert.deepStrictEqual(repaired.settings.hooks.PostToolUseFailure, [theirs], "a hook the user wrote stays");

  assert.ok(!settingsBlockJson(["PostToolUseFailure"]).includes("PostToolUseFailure"));
  assert.ok(settingsBlockJson().includes("PostToolUseFailure"));
});

test("reins init: only a Claude Code known to be current gets the fourth hook", () => {
  for (const [version, events] of [
    ["2.0.55", ["PostToolUse", "PreToolUse", "Stop"]],
    ["2.0.56", ["PostToolUse", "PostToolUseFailure", "PreToolUse", "Stop"]],
    ["unknown", ["PostToolUse", "PreToolUse", "Stop"]],
  ]) {
    const dir = project();
    try {
      const r = run(dir, version, "init");
      assert.deepStrictEqual(Object.keys(hooksIn(dir)).sort(), events, version);
      if (version === "2.0.55") assert.match(r.stdout, /Claude Code 2\.0\.55 is older than 2\.0\.56/);
      if (version === "unknown") assert.match(r.stdout, /Could not tell which Claude Code is installed, so PostToolUseFailure is left out/);
      if (version === "2.0.56") assert.doesNotMatch(r.stdout, /older than|Could not tell/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("reins init and doctor: a file written for a current Claude Code is repaired on an old one", () => {
  const dir = project();
  try {
    run(dir, "2.1.287", "init");
    assert.ok("PostToolUseFailure" in hooksIn(dir));

    const sick = run(dir, "2.0.55", "doctor");
    assert.match(sick.stdout, /loads NO hooks/);
    assert.strictEqual(sick.status, 1);

    assert.match(run(dir, "2.0.55", "init").stdout, /PostToolUseFailure removed/);
    assert.ok(!("PostToolUseFailure" in hooksIn(dir)));

    const well = run(dir, "2.0.55", "doctor");
    assert.doesNotMatch(well.stdout, /loads NO hooks|partly wired/);
    assert.match(well.stdout, /failed tool calls are not captured/);

    // Back on a current Claude Code, the missing hook is reported and init adds it.
    assert.match(run(dir, "2.1.287", "doctor").stdout, /missing PostToolUseFailure/);
    run(dir, "2.1.287", "init");
    assert.ok("PostToolUseFailure" in hooksIn(dir));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("reins init --failure-hook: the person's word counts when the version is unknown, never when it is known old", () => {
  const dir = project();
  try {
    assert.match(run(dir, "unknown", "init", "--failure-hook").stdout, /written on your word/);
    assert.ok("PostToolUseFailure" in hooksIn(dir));
    // Unknown again, without the flag: what is there is left alone.
    run(dir, "unknown", "init");
    assert.ok("PostToolUseFailure" in hooksIn(dir), "an unknown version removes nothing");
    // Known old: it comes out, flag or no flag.
    assert.match(run(dir, "2.0.55", "init", "--failure-hook").stdout, /--failure-hook was not applied/);
    assert.ok(!("PostToolUseFailure" in hooksIn(dir)));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("version: read from the session's environment, and the oldest sighting wins", () => {
  const H = require("../dist/heartbeat.js");
  assert.strictEqual(H.claudeVersionFromEnv({ AI_AGENT: "claude-code_2-1-287_agent" }), "2.1.287");
  assert.strictEqual(H.claudeVersionFromEnv({ CLAUDE_CODE_EXECPATH: "/Users/x/.local/share/claude/versions/2.0.40" }), "2.0.40");
  assert.strictEqual(H.claudeVersionFromEnv({ AI_AGENT: "something-else" }), null);
  assert.strictEqual(H.claudeVersionFromEnv({}), null);

  const before = process.env.REINS_CLAUDE_VERSION;
  try {
    process.env.REINS_CLAUDE_VERSION = "unknown";
    assert.strictEqual(V.claudeCodeVersion("2.0.40"), null, "the stated value is the only source when set");
    delete process.env.REINS_CLAUDE_VERSION;
    const seen = V.claudeSightings("2.0.40");
    assert.ok(seen.some((s) => s.from === "the last hook run here" && s.version === "2.0.40"));
    assert.strictEqual(V.claudeCodeVersion("2.0.40"), "2.0.40", "an old install seen by a hook outranks a newer one on PATH");
  } finally {
    if (before === undefined) delete process.env.REINS_CLAUDE_VERSION;
    else process.env.REINS_CLAUDE_VERSION = before;
  }
});

test("heartbeat: a hook notes that it ran, only for a real session in an initialized project", () => {
  const H = require("../dist/heartbeat.js");
  const dir = project();
  const hook = (payload, env = {}) =>
    spawnSync(process.execPath, [CLI, "hook", "pre-tool"], {
      cwd: dir,
      input: JSON.stringify(payload),
      encoding: "utf8",
      env: { ...process.env, CLAUDE_PROJECT_DIR: dir, AI_AGENT: "", CLAUDE_CODE_EXECPATH: "", ...env },
    });
  const call = { tool_name: "Bash", tool_input: { command: "ls" }, cwd: dir };
  try {
    hook({ ...call, session_id: "s1" });
    assert.strictEqual(H.readHooksSeen(path.join(dir, ".reins")), null, "no .reins: nothing is created");

    run(dir, "unknown", "init");
    const manual = hook(call);
    assert.strictEqual(manual.stdout, "", "the hook still passes the call through");
    assert.strictEqual(H.readHooksSeen(path.join(dir, ".reins")), null, "no session id: a manual run proves nothing");

    const real = hook({ ...call, session_id: "s1" }, { AI_AGENT: "claude-code_2-1-287_agent" });
    assert.strictEqual(real.stdout, "", "noting the run writes nothing to stdout");
    const seen = H.readHooksSeen(path.join(dir, ".reins"));
    assert.deepStrictEqual(Object.keys(seen.events), ["PreToolUse"]);
    assert.strictEqual(seen.claude, "2.1.287");

    // Within a minute the file is left alone.
    const first = seen.events.PreToolUse;
    hook({ ...call, session_id: "s1" }, { AI_AGENT: "claude-code_2-1-287_agent" });
    assert.strictEqual(H.readHooksSeen(path.join(dir, ".reins")).events.PreToolUse, first);

    // An unreadable file does not stop the hook.
    fs.writeFileSync(path.join(dir, ".reins", "hooks-seen.json"), "{ not json");
    assert.strictEqual(hook({ ...call, session_id: "s1" }).status, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("reins init: with claude off PATH, the version a hook saw is the evidence", () => {
  const dir = project();
  // No claude on this PATH, and no session environment.
  const bare = (...args) =>
    spawnSync(process.execPath, [CLI, ...args], {
      cwd: dir,
      encoding: "utf8",
      env: { PATH: path.dirname(process.execPath), HOME: process.env.HOME, NO_COLOR: "1", CLAUDE_PROJECT_DIR: dir },
    });
  try {
    assert.match(bare("init").stdout, /Could not tell which Claude Code/);
    assert.ok(!("PostToolUseFailure" in hooksIn(dir)));

    fs.writeFileSync(path.join(dir, ".reins", "hooks-seen.json"), JSON.stringify({ events: { PreToolUse: new Date().toISOString() }, claude: "2.1.287" }));
    bare("init");
    assert.ok("PostToolUseFailure" in hooksIn(dir), "a hook reported a current version, so the fourth hook is added");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("reins doctor: says whether a hook has run since the settings file changed", () => {
  const dir = project();
  const seenFile = path.join(dir, ".reins", "hooks-seen.json");
  try {
    run(dir, "unknown", "init", "--failure-hook");
    const blind = run(dir, "unknown", "doctor");
    assert.match(blind.stdout, /version unknown/);
    assert.match(blind.stdout, /assume no guard is active/);
    assert.strictEqual(blind.status, 1, "unknown version, the risky key, and no proof: a problem");

    const later = new Date(Date.now() + 60_000).toISOString();
    fs.writeFileSync(seenFile, JSON.stringify({ events: { PreToolUse: later, Stop: later } }));
    const proven = run(dir, "unknown", "doctor");
    assert.match(proven.stdout, /PreToolUse, Stop ran after the settings file last changed/);
    assert.doesNotMatch(proven.stdout, /assume no guard is active/);

    // Three hooks and an unknown version: nothing risky in the file, so a note, not a problem.
    const safe = project();
    try {
      run(safe, "unknown", "init");
      const out = run(safe, "unknown", "doctor");
      assert.match(out.stdout, /no hook has run since the settings file last changed/);
      assert.doesNotMatch(out.stdout, /assume no guard is active|partly wired/);
    } finally {
      fs.rmSync(safe, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
