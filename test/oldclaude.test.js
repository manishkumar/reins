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
  assert.strictEqual(V.predatesFailureHook(null), false, "an unknown version is treated as current");
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

test("reins init: an old Claude Code gets three hooks, a current or unknown one gets four", () => {
  for (const [version, events] of [
    ["2.0.55", ["PostToolUse", "PreToolUse", "Stop"]],
    ["2.0.56", ["PostToolUse", "PostToolUseFailure", "PreToolUse", "Stop"]],
    ["unknown", ["PostToolUse", "PostToolUseFailure", "PreToolUse", "Stop"]],
  ]) {
    const dir = project();
    try {
      const r = run(dir, version, "init");
      assert.deepStrictEqual(Object.keys(hooksIn(dir)).sort(), events, version);
      if (version === "2.0.55") assert.match(r.stdout, /Claude Code 2\.0\.55 is older than 2\.0\.56/);
      if (version === "unknown") assert.match(r.stdout, /Could not run claude --version/);
      if (version === "2.0.56") assert.doesNotMatch(r.stdout, /older than|Could not run/);
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
