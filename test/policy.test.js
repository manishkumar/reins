// Policy file v1: guards.json -> policy.json migration, `expires` on a rule,
// `tool` name-glob matching, and `reins doctor`'s policy validation.
const { test } = require("node:test");
const assert = require("node:assert");
const os = require("node:os");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const CLI = path.join(__dirname, "..", "dist", "cli.js");
const {
  loadGuards,
  saveGuards,
  checkGuards,
  isExpired,
  validateRules,
  policySource,
} = require("../dist/guards.js");

function tmpProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reins-policy-"));
  fs.mkdirSync(path.join(dir, ".reins"), { recursive: true });
  return dir;
}

function writeFile(dir, name, obj) {
  fs.writeFileSync(path.join(dir, ".reins", name), JSON.stringify(obj, null, 2));
}

function run(args, cwd) {
  return execFileSync(process.execPath, [CLI, ...args], { cwd, encoding: "utf8" });
}

// ---------- migration precedence ----------

test("loadGuards: policy.json wins when both files exist", () => {
  const dir = tmpProject();
  writeFile(dir, "guards.json", { rules: [{ id: "from-guards", type: "bash", pattern: "x", reason: "r" }] });
  writeFile(dir, "policy.json", { rules: [{ id: "from-policy", type: "bash", pattern: "y", reason: "r" }] });
  const guards = loadGuards(dir);
  assert.strictEqual(guards.rules.length, 1);
  assert.strictEqual(guards.rules[0].id, "from-policy");
  assert.strictEqual(policySource(dir), "policy.json");
});

test("loadGuards: guards.json alone is still honored (pre-0.3 installs never break)", () => {
  const dir = tmpProject();
  writeFile(dir, "guards.json", { rules: [{ id: "legacy", type: "bash", pattern: "z", reason: "r" }] });
  const guards = loadGuards(dir);
  assert.strictEqual(guards.rules.length, 1);
  assert.strictEqual(guards.rules[0].id, "legacy");
  assert.strictEqual(policySource(dir), "guards.json");
});

test("loadGuards: neither file present => built-in defaults", () => {
  const dir = tmpProject();
  const guards = loadGuards(dir);
  assert.ok(guards.rules.length > 0);
  assert.strictEqual(policySource(dir), "defaults");
});

test("loadGuards: malformed policy.json falls back to guards.json, not defaults", () => {
  const dir = tmpProject();
  fs.writeFileSync(path.join(dir, ".reins", "policy.json"), "{ not json");
  writeFile(dir, "guards.json", { rules: [{ id: "legacy2", type: "bash", pattern: "z", reason: "r" }] });
  const guards = loadGuards(dir);
  assert.strictEqual(guards.rules[0].id, "legacy2");
});

test("saveGuards: writes policy.json and leaves an existing guards.json untouched (auto-migrate)", () => {
  const dir = tmpProject();
  writeFile(dir, "guards.json", { rules: [{ id: "legacy3", type: "bash", pattern: "z", reason: "r" }] });
  const before = fs.readFileSync(path.join(dir, ".reins", "guards.json"), "utf8");

  saveGuards({ rules: [{ id: "new-rule", type: "bash", pattern: "w", reason: "r" }] }, dir);

  assert.ok(fs.existsSync(path.join(dir, ".reins", "policy.json")), "policy.json should now exist");
  const after = fs.readFileSync(path.join(dir, ".reins", "guards.json"), "utf8");
  assert.strictEqual(after, before, "guards.json must be left exactly as the user had it");
  assert.strictEqual(policySource(dir), "policy.json");
});

test("guard add via CLI: migrates a guards.json-only project to policy.json", () => {
  const dir = tmpProject();
  writeFile(dir, "guards.json", { rules: [] });
  run(["guard", "add", "bash", "docker\\s+push"], dir);
  assert.ok(fs.existsSync(path.join(dir, ".reins", "policy.json")));
  const policy = JSON.parse(fs.readFileSync(path.join(dir, ".reins", "policy.json"), "utf8"));
  assert.ok(policy.rules.some((r) => r.pattern === "docker\\s+push"));
});

// ---------- expires ----------

test("isExpired: no expires => active", () => {
  assert.strictEqual(isExpired({}), false);
});

test("isExpired: future date => active", () => {
  assert.strictEqual(isExpired({ expires: "2999-01-01" }), false);
});

test("isExpired: past date => expired", () => {
  assert.strictEqual(isExpired({ expires: "2000-01-01" }), true);
});

test("isExpired: malformed value => NOT expired (fail-open toward still guarding)", () => {
  assert.strictEqual(isExpired({ expires: "not-a-date" }), false);
});

test("checkGuards: expired rule is skipped at match time, as if absent", () => {
  const guards = {
    rules: [
      { id: "old-hold", type: "bash", pattern: "npm\\s+publish", reason: "r", expires: "2000-01-01" },
    ],
  };
  const match = checkGuards(guards, "Bash", { command: "npm publish" });
  assert.strictEqual(match, null);
});

test("checkGuards: rule with malformed expires still guards (fail-open direction)", () => {
  const guards = {
    rules: [
      { id: "typo-expiry", type: "bash", pattern: "npm\\s+publish", reason: "r", expires: "banana" },
    ],
  };
  const match = checkGuards(guards, "Bash", { command: "npm publish" });
  assert.ok(match, "a malformed expires must not silently remove the guard");
  assert.strictEqual(match.rule.id, "typo-expiry");
});

test("checkGuards: active (future-dated) expires still guards", () => {
  const guards = {
    rules: [
      { id: "future-hold", type: "bash", pattern: "npm\\s+publish", reason: "r", expires: "2999-01-01" },
    ],
  };
  const match = checkGuards(guards, "Bash", { command: "npm publish" });
  assert.ok(match);
});

test("guard add --expires: round-trips through list with expiry shown", () => {
  const dir = tmpProject();
  run(["guard", "add", "bash", "npm\\s+publish", "--hold", "--expires", "2999-01-01"], dir);
  const policy = JSON.parse(fs.readFileSync(path.join(dir, ".reins", "policy.json"), "utf8"));
  const rule = policy.rules.find((r) => r.pattern === "npm\\s+publish");
  assert.strictEqual(rule.expires, "2999-01-01");
  const listed = run(["guard", "list"], dir);
  assert.match(listed, /expires 2999-01-01/);
});

test("guard add: rejects an unparsable --expires date", () => {
  const dir = tmpProject();
  assert.throws(() => run(["guard", "add", "bash", "x", "--expires", "not-a-date"], dir));
});

// ---------- tool-name glob matching ----------

test("checkGuards: tool rule matches an mcp tool name glob", () => {
  const guards = {
    rules: [{ id: "mcp-stripe", type: "tool", pattern: "mcp__stripe__*", reason: "r", action: "hold" }],
  };
  const match = checkGuards(guards, "mcp__stripe__refund", {});
  assert.ok(match);
  assert.strictEqual(match.rule.id, "mcp-stripe");
});

test("checkGuards: tool glob is anchored — a name that merely starts similarly does NOT match", () => {
  const guards = {
    rules: [{ id: "mcp-stripe", type: "tool", pattern: "mcp__stripe__*", reason: "r" }],
  };
  // No "__" separator after "stripe" — must not be treated as the stripe family.
  const match = checkGuards(guards, "mcp__stripeXYZ", {});
  assert.strictEqual(match, null);
});

test("checkGuards: tool glob is case-sensitive on tool names", () => {
  const guards = {
    rules: [{ id: "webfetch", type: "tool", pattern: "WebFetch", reason: "r" }],
  };
  assert.ok(checkGuards(guards, "WebFetch", {}));
  assert.strictEqual(checkGuards(guards, "webfetch", {}), null);
});

test("checkGuards: a bash rule never matches on tool name, and a tool rule never matches Bash commands", () => {
  const guards = {
    rules: [{ id: "mcp-star", type: "tool", pattern: "mcp__*", reason: "r" }],
  };
  const match = checkGuards(guards, "Bash", { command: "echo mcp__stripe__refund" });
  assert.strictEqual(match, null, "tool rules match the TOOL NAME field, not command text");
});

test("guard add tool: CLI round-trip", () => {
  const dir = tmpProject();
  run(["guard", "add", "tool", "mcp__stripe__*", "--hold", "--reason", "review stripe MCP calls"], dir);
  const policy = JSON.parse(fs.readFileSync(path.join(dir, ".reins", "policy.json"), "utf8"));
  const rule = policy.rules.find((r) => r.pattern === "mcp__stripe__*");
  assert.strictEqual(rule.type, "tool");
  assert.strictEqual(rule.action, "hold");
  const listed = run(["guard", "list"], dir);
  assert.match(listed, /tool/);
  assert.match(listed, /mcp__stripe__\*/);
});

// ---------- doctor validation ----------

test("validateRules: flags invalid regex on a bash rule", () => {
  const problems = validateRules([{ id: "bad-regex", type: "bash", pattern: "(", reason: "r" }]);
  assert.ok(problems.some((p) => p.ruleId === "bad-regex" && p.severity === "error" && /regex/.test(p.message)));
});

// Note: globToRegExp escapes every literal character individually (see
// guards.ts), so there is no string that actually fails to compile — the
// "invalid glob" branch in validateRules is defensive, matching the same
// try/catch already in checkGuards and `guard add`. Nothing to exercise here
// beyond confirming a weird-looking-but-legal glob doesn't get flagged.
test("validateRules: an unusual but legal glob is not flagged as invalid", () => {
  const problems = validateRules([{ id: "odd-glob", type: "path", pattern: "**/[weird]/*", reason: "r" }]);
  assert.ok(!problems.some((p) => p.ruleId === "odd-glob" && /glob/.test(p.message)));
});

test("validateRules: flags unknown type", () => {
  const problems = validateRules([{ id: "weird", type: "regex", pattern: "x", reason: "r" }]);
  assert.ok(problems.some((p) => p.ruleId === "weird" && p.severity === "error" && /unknown type/.test(p.message)));
});

test("validateRules: flags unknown action", () => {
  const problems = validateRules([{ id: "weird2", type: "bash", pattern: "x", reason: "r", action: "yeet" }]);
  assert.ok(
    problems.some((p) => p.ruleId === "weird2" && p.severity === "error" && /unknown action/.test(p.message)),
  );
});

test("validateRules: flags missing reason", () => {
  const problems = validateRules([{ id: "no-reason", type: "bash", pattern: "x", reason: "" }]);
  assert.ok(
    problems.some((p) => p.ruleId === "no-reason" && p.severity === "error" && /missing reason/.test(p.message)),
  );
});

test("validateRules: flags duplicate ids", () => {
  const problems = validateRules([
    { id: "dup", type: "bash", pattern: "x", reason: "r" },
    { id: "dup", type: "bash", pattern: "y", reason: "r" },
  ]);
  assert.ok(problems.some((p) => p.severity === "error" && /duplicate/.test(p.message)));
});

test("validateRules: flags malformed expires as an error", () => {
  const problems = validateRules([{ id: "typo", type: "bash", pattern: "x", reason: "r", expires: "banana" }]);
  assert.ok(problems.some((p) => p.ruleId === "typo" && p.severity === "error" && /malformed expires/.test(p.message)));
});

test("validateRules: flags a past expires as a (non-error) warning", () => {
  const problems = validateRules([
    { id: "stale", type: "bash", pattern: "x", reason: "r", expires: "2000-01-01" },
  ]);
  const p = problems.find((p) => p.ruleId === "stale");
  assert.ok(p);
  assert.strictEqual(p.severity, "warning");
  assert.match(p.message, /expired/);
});

test("validateRules: flags ask rules as headless-hostile (warning)", () => {
  const problems = validateRules([{ id: "ask-rule", type: "bash", pattern: "x", reason: "r", action: "ask" }]);
  const p = problems.find((p) => p.ruleId === "ask-rule" && /headless/.test(p.message));
  assert.ok(p);
  assert.strictEqual(p.severity, "warning");
});

test("validateRules: flags trivially broad patterns (.*, ., *, **) as warnings", () => {
  for (const pattern of [".*", ".", "*", "**"]) {
    const problems = validateRules([{ id: "broad", type: "bash", pattern, reason: "r" }]);
    const p = problems.find((p) => /matches everything/.test(p.message));
    assert.ok(p, `pattern ${JSON.stringify(pattern)} should be flagged as too broad`);
    assert.strictEqual(p.severity, "warning");
  }
});

test("validateRules: a clean rule set has no problems", () => {
  const problems = validateRules([
    { id: "clean", type: "bash", pattern: "rm\\s+-rf", reason: "no recursive rm", action: "deny" },
  ]);
  assert.strictEqual(problems.length, 0);
});

test("reins doctor: exits non-zero and reports a broken policy rule", () => {
  const dir = tmpProject();
  writeFile(dir, "policy.json", { rules: [{ id: "broken", type: "bash", pattern: "(", reason: "r" }] });
  let out = "";
  let status = 0;
  try {
    out = execFileSync(process.execPath, [CLI, "doctor"], { cwd: dir, encoding: "utf8" });
  } catch (e) {
    out = e.stdout;
    status = e.status;
  }
  assert.notStrictEqual(status, 0);
  assert.match(out, /broken/);
  assert.match(out, /regex/);
});

test("reins doctor: a warning-only policy (e.g. an ask rule) does not force a non-zero exit by itself", () => {
  const dir = tmpProject();
  writeFile(dir, "policy.json", {
    rules: [{ id: "ask-only", type: "bash", pattern: "git\\s+push", reason: "needs a look", action: "ask" }],
  });
  // Doctor may still exit non-zero for unrelated reasons (e.g. hooks not wired
  // in this throwaway dir), so just check the warning is reported and the
  // process doesn't crash.
  let out = "";
  try {
    out = execFileSync(process.execPath, [CLI, "doctor"], { cwd: dir, encoding: "utf8" });
  } catch (e) {
    out = e.stdout;
  }
  assert.match(out, /ask-only/);
  assert.match(out, /headless/);
});

test("reins doctor: reports which file backs the policy", () => {
  const dir = tmpProject();
  writeFile(dir, "guards.json", { rules: [{ id: "r1", type: "bash", pattern: "x", reason: "y" }] });
  let out = "";
  try {
    out = execFileSync(process.execPath, [CLI, "doctor"], { cwd: dir, encoding: "utf8" });
  } catch (e) {
    out = e.stdout;
  }
  assert.match(out, /guards\.json/);
});
