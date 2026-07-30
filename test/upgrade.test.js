// Policy versioning and `reins policy upgrade`.
//
// The bug this whole module answers: a repo initialized in June 2026 was still
// enforcing June's rules in late July, including a recursive-rm pattern that
// blocked plain `rm -f one-file.txt`. The fix had shipped weeks earlier and
// reached zero existing installs, because nothing ever revisited the rules
// written at init time. These tests are the guarantee that can't happen again.
const { test } = require("node:test");
const assert = require("node:assert");
const os = require("node:os");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const CLI = path.join(__dirname, "..", "dist", "cli.js");
const { DEFAULT_RULES, POLICY_VERSION, loadGuards } = require("../dist/guards.js");
const { planUpgrade, hasWork, seededDefaults, stalenessNote } = require("../dist/policyUpgrade.js");

function tmpProject(policy) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reins-upgrade-"));
  fs.mkdirSync(path.join(dir, ".reins"), { recursive: true });
  if (policy) {
    fs.writeFileSync(path.join(dir, ".reins", "policy.json"), JSON.stringify(policy, null, 2));
  }
  return dir;
}

function run(args, cwd) {
  return execFileSync(process.execPath, [CLI, ...args], { cwd, encoding: "utf8" });
}

// A faithful copy of the shape found in the wild: no `version`, no `origin`,
// and the pre-fix rm pattern that matched `rm -f`.
const LEGACY_POLICY = {
  rules: [
    {
      id: "rm-rf",
      type: "bash",
      pattern: "\\brm\\s+(-[a-zA-Z]*\\s+)*-?[a-zA-Z]*r[a-zA-Z]*f|\\brm\\s+-rf?\\b|\\brm\\s+-fr?\\b",
      reason: "Recursive force-delete (rm -rf) is blocked by a reins guard.",
    },
    { id: "sql-drop", type: "bash", pattern: "\\bDROP\\s+TABLE\\b", reason: "old" },
  ],
};

test("planUpgrade: a legacy unversioned file is upgradeable by rule id", () => {
  const plan = planUpgrade(LEGACY_POLICY);
  assert.strictEqual(plan.fromVersion, undefined);
  assert.strictEqual(plan.toVersion, POLICY_VERSION);
  assert.ok(hasWork(plan));
  const rmrf = plan.changes.find((c) => c.id === "rm-rf");
  assert.strictEqual(rmrf.kind, "updated");
  assert.ok(rmrf.details.includes("pattern changed"));
  // The whole point: the stale pattern is gone after upgrading.
  assert.notStrictEqual(rmrf.after.pattern, LEGACY_POLICY.rules[0].pattern);
});

test("planUpgrade: new shipped rules land at their canonical position", () => {
  // Order is load-bearing — checkGuards returns the FIRST match, so
  // rm-catastrophic must precede rm-rf or a generous exemption would let
  // `rm -rf /` through.
  const plan = planUpgrade(LEGACY_POLICY);
  const ids = plan.nextRules.map((r) => r.id);
  assert.ok(ids.indexOf("rm-catastrophic") < ids.indexOf("rm-rf"), "rm-catastrophic must come first");
});

test("planUpgrade: hand-written rules are never touched", () => {
  const file = { rules: [...LEGACY_POLICY.rules, { id: "mine", type: "bash", pattern: "x", reason: "r" }] };
  const plan = planUpgrade(file);
  assert.deepStrictEqual(plan.userRuleIds, ["mine"]);
  const mine = plan.nextRules.find((r) => r.id === "mine");
  assert.deepStrictEqual(mine, { id: "mine", type: "bash", pattern: "x", reason: "r" });
});

test("planUpgrade: a user's action and expires survive the upgrade", () => {
  // The fields a human is most likely to have re-tuned deliberately. Resetting
  // them to the shipped default would be exactly the clobber init avoids.
  const file = {
    rules: [{ ...DEFAULT_RULES.find((r) => r.id === "sql-drop"), action: "hold", expires: "2099-01-01" }],
  };
  const plan = planUpgrade(file);
  const after = plan.nextRules.find((r) => r.id === "sql-drop");
  assert.strictEqual(after.action, "hold");
  assert.strictEqual(after.expires, "2099-01-01");
});

test("planUpgrade: a user rule that shadows a shipped id stays theirs", () => {
  const file = { rules: [{ id: "rm-rf", type: "bash", pattern: "custom", reason: "mine", origin: "user" }] };
  const plan = planUpgrade(file);
  const after = plan.nextRules.find((r) => r.id === "rm-rf");
  assert.strictEqual(after.pattern, "custom", "explicit non-default origin must be respected");
});

test("planUpgrade: current defaults report no work, and upgrading is idempotent", () => {
  const plan = planUpgrade({ rules: seededDefaults(), version: POLICY_VERSION });
  assert.strictEqual(hasWork(plan), false);
  assert.strictEqual(stalenessNote(plan), null);
  const twice = planUpgrade({ rules: plan.nextRules, version: POLICY_VERSION });
  assert.strictEqual(hasWork(twice), false);
});

test("stalenessNote: names the generation gap and the fix", () => {
  const note = stalenessNote(planUpgrade(LEGACY_POLICY));
  assert.match(note, /pre-versioning → v\d+/);
  assert.match(note, /reins policy upgrade/);
});

// ---------- CLI ----------

test("reins policy upgrade: writes nothing without --apply", () => {
  const dir = tmpProject(LEGACY_POLICY);
  const before = fs.readFileSync(path.join(dir, ".reins", "policy.json"), "utf8");
  const out = run(["policy", "upgrade"], dir);
  assert.match(out, /Nothing written/);
  assert.strictEqual(fs.readFileSync(path.join(dir, ".reins", "policy.json"), "utf8"), before);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("reins policy upgrade --apply: writes, stamps the version, then is a no-op", () => {
  const dir = tmpProject(LEGACY_POLICY);
  run(["policy", "upgrade", "--apply"], dir);
  const after = loadGuards(dir);
  assert.strictEqual(after.version, POLICY_VERSION);
  assert.ok(after.rules.every((r) => r.origin === `default@${POLICY_VERSION}`));
  assert.match(run(["policy", "upgrade"], dir), /up to date/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("reins init: seeds rules carrying their provenance", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reins-init-"));
  run(["init", "--local"], dir);
  const file = JSON.parse(fs.readFileSync(path.join(dir, ".reins", "policy.json"), "utf8"));
  assert.strictEqual(file.version, POLICY_VERSION);
  assert.ok(file.rules.every((r) => r.origin === `default@${POLICY_VERSION}`));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("reins doctor: flags a stale policy as a note", () => {
  const dir = tmpProject(LEGACY_POLICY);
  let out;
  try {
    out = run(["doctor"], dir);
  } catch (e) {
    out = e.stdout || ""; // doctor exits nonzero when it finds problems
  }
  assert.match(out, /policy version/);
  assert.match(out, /reins policy upgrade/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("planUpgrade: at the current generation, a differing rule is the USER's edit", () => {
  // Same version + different content means nothing new shipped, so the change
  // came from them. Refreshing it would silently undo their work.
  const mine = { ...DEFAULT_RULES.find((r) => r.id === "rm-rf"), pattern: "my-own-narrower-pattern" };
  const plan = planUpgrade({ rules: [mine], version: POLICY_VERSION });
  assert.deepStrictEqual(plan.customizedRuleIds, ["rm-rf"]);
  assert.strictEqual(plan.nextRules.find((r) => r.id === "rm-rf").pattern, "my-own-narrower-pattern");
  // New shipped rules are still offered — customization isn't a blanket opt-out.
  assert.ok(plan.changes.some((ch) => ch.kind === "added" && ch.id === "rm-catastrophic"));
});

test("planUpgrade: an OLDER generation does get its rules refreshed", () => {
  // The mirror image: a version behind means the difference is upstream's.
  const stale = { ...DEFAULT_RULES.find((r) => r.id === "rm-rf"), pattern: "old-shipped-pattern" };
  const plan = planUpgrade({ rules: [stale], version: POLICY_VERSION - 1 });
  assert.deepStrictEqual(plan.customizedRuleIds, []);
  assert.notStrictEqual(plan.nextRules.find((r) => r.id === "rm-rf").pattern, "old-shipped-pattern");
});

test("reins policy version: separates the shared binary from the per-project rules", () => {
  // The distinction the command exists to make: a project does not pin a reins
  // version (hooks call bare `reins`), it pins a POLICY generation.
  const dir = tmpProject(LEGACY_POLICY);
  const out = run(["policy", "version"], dir);
  assert.match(out, /Binary/);
  assert.match(out, /reins version/);
  assert.match(out, /This project/);
  assert.match(out, /policy version\s+unversioned/);
  assert.match(out, /Rules are behind/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("reins policy version: says so plainly when rules are current", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reins-ver-"));
  run(["init", "--local"], dir);
  assert.match(run(["policy", "version"], dir), /Rules are current/);
  fs.rmSync(dir, { recursive: true, force: true });
});
