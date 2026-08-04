// Phase-1 gate behaviors: guard `ask` action, guaranteed steering delivery at
// Stop, and consecutive-only loop counting. Hooks are exercised end-to-end the
// way Claude Code invokes them: `reins hook <name>` with the event JSON on stdin.
const { test } = require("node:test");
const assert = require("node:assert");
const os = require("node:os");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const CLI = path.join(__dirname, "..", "dist", "cli.js");

function tmpProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reins-gate-"));
  fs.mkdirSync(path.join(dir, ".reins"), { recursive: true });
  return dir;
}

function runHook(name, event, cwd) {
  return execFileSync(process.execPath, [CLI, "hook", name], {
    input: JSON.stringify(event),
    cwd,
    encoding: "utf8",
  }).trim();
}

function writeGuards(dir, rules) {
  fs.writeFileSync(path.join(dir, ".reins", "guards.json"), JSON.stringify({ rules }, null, 2));
}

// ---------- guard `ask` ----------

test("pre-tool: rule with action:ask emits permissionDecision ask, with reason", () => {
  const dir = tmpProject();
  writeGuards(dir, [
    { id: "push-ask", type: "bash", pattern: "git\\s+push", reason: "Pushing needs approval.", action: "ask" },
  ]);
  const out = runHook(
    "pre-tool",
    { cwd: dir, tool_name: "Bash", tool_input: { command: "git push origin main" } },
    dir,
  );
  const parsed = JSON.parse(out);
  assert.strictEqual(parsed.hookSpecificOutput.permissionDecision, "ask");
  assert.match(parsed.hookSpecificOutput.permissionDecisionReason, /approval/);
});

test("pre-tool: rule without action still hard-denies (pre-0.2 files unchanged)", () => {
  const dir = tmpProject();
  writeGuards(dir, [
    { id: "push-deny", type: "bash", pattern: "git\\s+push", reason: "No pushing." },
  ]);
  const out = runHook(
    "pre-tool",
    { cwd: dir, tool_name: "Bash", tool_input: { command: "git push" } },
    dir,
  );
  assert.strictEqual(JSON.parse(out).hookSpecificOutput.permissionDecision, "deny");
});

test("guard add --ask: persists action ask; list shows it", () => {
  const dir = tmpProject();
  execFileSync(process.execPath, [CLI, "guard", "add", "bash", "docker\\s+push", "--ask"], {
    cwd: dir,
    encoding: "utf8",
  });
  const saved = JSON.parse(fs.readFileSync(path.join(dir, ".reins", "policy.json"), "utf8"));
  const rule = saved.rules.find((r) => r.pattern === "docker\\s+push");
  assert.strictEqual(rule.action, "ask");
  assert.match(rule.reason, /approval/);
  const listed = execFileSync(process.execPath, [CLI, "guard", "list"], { cwd: dir, encoding: "utf8" });
  assert.match(listed, /ask/);
});

// ---------- steering delivery at Stop ----------

test("stop: pending steering blocks the stop and is consumed", () => {
  const dir = tmpProject();
  const steeringFile = path.join(dir, ".reins", "steering.txt");
  fs.writeFileSync(steeringFile, "also add a changelog entry\n");
  const out = runHook("stop", { cwd: dir, session_id: "s1" }, dir);
  const parsed = JSON.parse(out);
  assert.strictEqual(parsed.decision, "block");
  assert.match(parsed.reason, /also add a changelog entry/);
  assert.match(parsed.reason, /refines the goal/);
  assert.ok(!fs.existsSync(steeringFile), "steering must be consumed on delivery");
});

test("stop: targeted steering for this session is preferred and delivered", () => {
  const dir = tmpProject();
  fs.writeFileSync(path.join(dir, ".reins", "steering.s2.txt"), "only for s2\n");
  const out = runHook("stop", { cwd: dir, session_id: "s2" }, dir);
  assert.match(JSON.parse(out).reason, /only for s2/);
});

test("stop: no pending steering => no block (normal finalization, silent)", () => {
  const dir = tmpProject();
  const out = runHook("stop", { cwd: dir, session_id: "s3" }, dir);
  assert.strictEqual(out, "", "stop must stay silent when nothing is pending");
});

test("stop: delivery self-terminates — second stop passes through", () => {
  const dir = tmpProject();
  fs.writeFileSync(path.join(dir, ".reins", "steering.txt"), "one nudge\n");
  const first = runHook("stop", { cwd: dir, session_id: "s4" }, dir);
  assert.strictEqual(JSON.parse(first).decision, "block");
  const second = runHook("stop", { cwd: dir, session_id: "s4" }, dir);
  assert.strictEqual(second, "", "re-stop must not block again");
});

// ---------- consecutive-only loop counting ----------

const hasSqlite = (() => {
  try {
    require("node:sqlite");
    return true;
  } catch {
    return false;
  }
})();

test("loop alarm: interleaved repeats do not trip it; a true streak does", { skip: !hasSqlite }, () => {
  const dir = tmpProject();
  const post = (cmd) =>
    runHook(
      "post-tool",
      { cwd: dir, session_id: "loop1", tool_name: "Bash", tool_input: { command: cmd }, tool_response: {} },
      dir,
    );

  // Healthy edit→test iteration: npm test appears 3 times, never consecutively.
  post("npm test");
  post("edit-something");
  post("npm test");
  post("edit-something-else");
  const healthy = post("npm test");
  assert.strictEqual(healthy, "", "3rd interleaved `npm test` must NOT trip the alarm");

  // An actual loop: the same call three times in a row.
  post("npm run build");
  post("npm run build");
  const looped = post("npm run build");
  assert.match(looped, /loop alarm/);
  assert.match(looped, /3 times in a row/);
});

test("denied and asked rows carry the rule id for the audit trail", { skip: !hasSqlite }, () => {
  const dir = tmpProject();
  writeGuards(dir, [
    { id: "rm-rf", type: "bash", pattern: "rm\\s+-rf", reason: "no", action: "deny" },
    { id: "push-ask", type: "bash", pattern: "git\\s+push", reason: "ask first", action: "ask" },
  ]);
  runHook("pre-tool", { cwd: dir, session_id: "a1", tool_name: "Bash", tool_input: { command: "rm -rf build" } }, dir);
  runHook("pre-tool", { cwd: dir, session_id: "a1", tool_name: "Bash", tool_input: { command: "git push" } }, dir);

  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(path.join(dir, ".reins", "runs.db"), { readOnly: true });
  const rows = db.prepare("SELECT input_summary, ok FROM tool_calls ORDER BY seq").all();
  assert.strictEqual(rows.length, 2);
  assert.match(rows[0].input_summary, /^DENIED: rm -rf build \[guard:rm-rf\]$/);
  assert.strictEqual(rows[0].ok, 0);
  assert.match(rows[1].input_summary, /^ASKED: git push \[guard:push-ask\]$/);
  assert.strictEqual(rows[1].ok, null);
});

test("asked row's hash differs from the executed call's (no loop-count inflation)", { skip: !hasSqlite }, () => {
  const dir = tmpProject();
  writeGuards(dir, [
    { id: "push-ask", type: "bash", pattern: "git\\s+push", reason: "ask first", action: "ask" },
  ]);
  const event = { cwd: dir, session_id: "a2", tool_name: "Bash", tool_input: { command: "git push" } };
  runHook("pre-tool", event, dir); // ASKED row
  runHook("post-tool", { ...event, tool_response: {} }, dir); // human approved; call executed

  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(path.join(dir, ".reins", "runs.db"), { readOnly: true });
  const rows = db.prepare("SELECT input_hash FROM tool_calls ORDER BY seq").all();
  assert.strictEqual(rows.length, 2);
  assert.notStrictEqual(rows[0].input_hash, rows[1].input_hash);
});

// ---------- the project root, seen from a subdirectory ----------
//
// Claude Code's event `cwd` is the working directory of the TOOL CALL, not the
// project root — one `cd packages/api` in a Bash call and every later event
// carries the subdirectory. These are the behaviors that silently stopped
// working when the hooks took that path verbatim.

/** Run a hook with the event cwd set to a subdirectory of the project, the way
 *  Claude Code reports a tool call made after the agent has cd'd. */
function runHookFromSubdir(name, event, project, sub) {
  const dir = path.join(project, sub);
  fs.mkdirSync(dir, { recursive: true });
  return execFileSync(process.execPath, [CLI, "hook", name], {
    input: JSON.stringify({ ...event, cwd: dir }),
    cwd: dir,
    encoding: "utf8",
    // Pin the session root: without it the suite inherits whatever the shell
    // running the tests happens to have set.
    env: { ...process.env, CLAUDE_PROJECT_DIR: project },
  }).trim();
}

test("pre-tool: a hand-written rule still fires for a tool call made from a subdirectory", () => {
  const dir = tmpProject();
  writeGuards(dir, [
    { id: "pytest-deny", type: "bash", pattern: "pytest", reason: "no pytest here" },
  ]);
  const out = runHookFromSubdir(
    "pre-tool",
    { tool_name: "Bash", tool_input: { command: "pytest -x" } },
    dir,
    "packages/api",
  );
  const parsed = JSON.parse(out);
  assert.strictEqual(parsed.hookSpecificOutput.permissionDecision, "deny");
  assert.strictEqual(parsed.hookSpecificOutput.permissionDecisionReason, "no pytest here");
});

test("pre-tool: steering queued at the root is delivered from a subdirectory", () => {
  const dir = tmpProject();
  fs.writeFileSync(path.join(dir, ".reins", "steering.txt"), "stay in the auth module\n");
  const out = runHookFromSubdir(
    "pre-tool",
    { tool_name: "Bash", tool_input: { command: "ls" } },
    dir,
    "packages/api",
  );
  const parsed = JSON.parse(out);
  assert.match(parsed.hookSpecificOutput.additionalContext, /stay in the auth module/);
  // ...and consumed from the root's queue, not a phantom one in the subdirectory.
  assert.strictEqual(fs.existsSync(path.join(dir, ".reins", "steering.txt")), false);
});

test("hooks never create a second .reins in a subdirectory", () => {
  const dir = tmpProject();
  writeGuards(dir, [{ id: "noop", type: "bash", pattern: "zzz-never-matches" }]);
  runHookFromSubdir(
    "pre-tool",
    { session_id: "sub1", tool_name: "Bash", tool_input: { command: "ls" } },
    dir,
    "packages/api",
  );
  runHookFromSubdir(
    "post-tool",
    { session_id: "sub1", tool_name: "Bash", tool_input: { command: "ls" }, tool_response: {} },
    dir,
    "packages/api",
  );
  assert.strictEqual(fs.existsSync(path.join(dir, "packages", "api", ".reins")), false);
});

test("hold: an approval filed at the root is seen by a call proposed from a subdirectory", () => {
  const dir = tmpProject();
  writeGuards(dir, [
    { id: "publish-hold", type: "bash", pattern: "npm\\s+publish", reason: "sign-off needed", action: "hold" },
  ]);
  const event = { session_id: "h1", tool_name: "Bash", tool_input: { command: "npm publish" } };
  // Parked from the subdirectory...
  const parked = JSON.parse(runHookFromSubdir("pre-tool", event, dir, "packages/api"));
  assert.strictEqual(parked.hookSpecificOutput.permissionDecision, "deny");
  const id = /id ([0-9a-f]{8})/.exec(parked.hookSpecificOutput.permissionDecisionReason)[1];

  // ...listed and approved at the root, where the human works.
  execFileSync(process.execPath, [CLI, "approve", id], { cwd: dir, encoding: "utf8" });

  // ...and the retry, still reported from the subdirectory, is let through.
  const retry = JSON.parse(runHookFromSubdir("pre-tool", event, dir, "packages/api"));
  assert.strictEqual(retry.hookSpecificOutput.permissionDecision, "allow");
});
