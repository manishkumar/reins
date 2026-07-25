// The defer transport: a hold rule parks Claude Code's own tool call instead of
// vetoing it, so approving later runs the ORIGINAL call.
//
// Claude Code honors defer only in print mode, which a hook cannot observe
// directly — src/defer.ts infers it from the Claude Code process's own argv.
// That judgment is unit-tested below against real command lines; the end-to-end
// behavior here pins the transport through config instead of depending on how
// the test suite itself happened to be launched.
const { test } = require("node:test");
const assert = require("node:assert");
const os = require("node:os");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { isPrintModeArgv } = require("../dist/defer");

const CLI = path.join(__dirname, "..", "dist", "cli.js");

function tmpProject(transport = "defer") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reins-defer-"));
  fs.mkdirSync(path.join(dir, ".reins"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, ".reins", "config.json"),
    JSON.stringify({ holdTransport: transport }),
  );
  fs.writeFileSync(
    path.join(dir, ".reins", "guards.json"),
    JSON.stringify({
      rules: [
        {
          id: "push-hold",
          type: "bash",
          pattern: "git\\s+push",
          reason: "Pushing needs approval.",
          action: "hold",
        },
      ],
    }),
  );
  return dir;
}

const childEnv = { ...process.env, CLAUDE_PROJECT_DIR: "" };

function runHook(name, event, cwd) {
  return execFileSync(process.execPath, [CLI, "hook", name], {
    input: JSON.stringify(event),
    cwd,
    encoding: "utf8",
    env: childEnv,
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
}

function runCli(args, cwd) {
  return execFileSync(process.execPath, [CLI, ...args], {
    cwd,
    encoding: "utf8",
    env: childEnv,
  });
}

// The predicate that decides the transport. Getting this wrong toward "defer"
// means a hold that silently doesn't hold, so the cases are pinned explicitly.
test("isPrintModeArgv: recognizes real print-mode command lines", () => {
  assert.equal(isPrintModeArgv("claude -p run the bash command: echo hi"), true);
  assert.equal(isPrintModeArgv("claude --print 'do the thing'"), true);
  assert.equal(isPrintModeArgv("claude --init-only"), true);
  assert.equal(isPrintModeArgv("claude --sdk-url=http://localhost:1234"), true);
  assert.equal(
    isPrintModeArgv("claude -p run the bash command: echo hi --output-format json"),
    true,
  );
});

test("isPrintModeArgv: an interactive session is never mistaken for print mode", () => {
  assert.equal(isPrintModeArgv("claude"), false);
  assert.equal(isPrintModeArgv("claude --model sonnet"), false);
  // The dangerous case: an interactive session started with a prompt that
  // merely CONTAINS a flag-looking word. ps loses the quoting, so only flags
  // before the first non-flag token may count.
  assert.equal(isPrintModeArgv("claude fix the --print bug in the parser"), false);
  assert.equal(isPrintModeArgv("claude why does -p not work here"), false);
});

test("isPrintModeArgv: ambiguity resolves toward deny, not defer", () => {
  // A flag value hides the later -p; we lose the better transport rather than
  // risk emitting a defer that gets silently discarded.
  assert.equal(isPrintModeArgv("claude --model sonnet -p 'do the thing'"), false);
  assert.equal(isPrintModeArgv(""), false);
});

const pushEvent = (dir, { session = "s1", toolUseId = "toolu_A", command = "git push origin main" } = {}) => ({
  cwd: dir,
  session_id: session,
  tool_name: "Bash",
  tool_input: { command },
  tool_use_id: toolUseId,
});

function decisionOf(out) {
  return JSON.parse(out).hookSpecificOutput.permissionDecision;
}

function pendingEntries(dir) {
  const d = path.join(dir, ".reins", "pending");
  if (!fs.existsSync(d)) return [];
  return fs
    .readdirSync(d)
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(fs.readFileSync(path.join(d, f), "utf8")));
}

test("print mode: a hold rule defers the call and parks it with its tool_use_id", () => {
  const dir = tmpProject();
  const out = runHook("pre-tool", pushEvent(dir), dir);
  assert.equal(decisionOf(out), "defer");

  const parked = pendingEntries(dir);
  assert.equal(parked.length, 1);
  assert.equal(parked[0].transport, "defer");
  assert.equal(parked[0].tool_use_id, "toolu_A");
});

test("where defer would be discarded, the same rule denies and queues instead", () => {
  const dir = tmpProject("deny");
  const out = runHook("pre-tool", pushEvent(dir), dir);
  assert.equal(decisionOf(out), "deny");
  assert.equal(pendingEntries(dir)[0].transport, "deny");
});

test("with no evidence of print mode, the transport falls back to deny", () => {
  // "auto" with no CLAUDE_PID to inspect: the predicate cannot prove defer
  // will be honored, so it must not be used.
  const dir = tmpProject("auto");
  const out = execFileSync(process.execPath, [CLI, "hook", "pre-tool"], {
    input: JSON.stringify(pushEvent(dir)),
    cwd: dir,
    encoding: "utf8",
    env: { ...childEnv, CLAUDE_PID: "" },
  }).trim();
  assert.equal(decisionOf(out), "deny");
});

test("replay of an unapproved deferred call defers again, without duplicating the queue entry", () => {
  const dir = tmpProject();
  runHook("pre-tool", pushEvent(dir), dir);
  // The resume replay: same tool_use_id, no prompt_id.
  const out = runHook("pre-tool", pushEvent(dir), dir);
  assert.equal(decisionOf(out), "defer");
  assert.equal(pendingEntries(dir).length, 1);
});

test("approve then replay: the ORIGINAL call is allowed, once", () => {
  const dir = tmpProject();
  runHook("pre-tool", pushEvent(dir), dir);
  const id = pendingEntries(dir)[0].id;

  const approved = runCli(["approve", id], dir);
  assert.match(approved, /Approved/);
  // The resume command is handed over — an approval nobody resumes is silent.
  assert.match(approved, /claude --resume s1/);

  const allowed = runHook("pre-tool", pushEvent(dir), dir);
  assert.equal(decisionOf(allowed), "allow");

  // One-shot: the same call attempted again is a new proposal.
  const again = runHook("pre-tool", pushEvent(dir), dir);
  assert.equal(decisionOf(again), "defer");
});

test("deny --steer: the replay is refused at the boundary and carries the alternative", () => {
  const dir = tmpProject();
  runHook("pre-tool", pushEvent(dir), dir);
  const id = pendingEntries(dir)[0].id;

  runCli(["deny", id, "--steer", "open a PR instead"], dir);

  const out = runHook("pre-tool", pushEvent(dir), dir);
  const parsed = JSON.parse(out).hookSpecificOutput;
  assert.equal(parsed.permissionDecision, "deny");
  assert.match(parsed.permissionDecisionReason, /refused/i);
  assert.match(parsed.permissionDecisionReason, /open a PR instead/);
});

test("a refused action does not re-park itself into the queue forever", () => {
  const dir = tmpProject();
  runHook("pre-tool", pushEvent(dir), dir);
  const id = pendingEntries(dir)[0].id;
  runCli(["deny", id], dir);
  assert.equal(pendingEntries(dir).length, 0);

  runHook("pre-tool", pushEvent(dir), dir); // the replay collects the refusal
  assert.equal(pendingEntries(dir).length, 0);
});

test("approval is bound to the exact call: a different session cannot spend it", () => {
  const dir = tmpProject();
  // Two sessions propose the identical command.
  runHook("pre-tool", pushEvent(dir, { session: "s1", toolUseId: "toolu_1" }), dir);
  runHook("pre-tool", pushEvent(dir, { session: "s2", toolUseId: "toolu_2" }), dir);
  const forS1 = pendingEntries(dir).find((p) => p.session_id === "s1");

  runCli(["approve", forS1.id], dir);

  // s2's identical call must still be held — the approval was s1's.
  const s2 = runHook("pre-tool", pushEvent(dir, { session: "s2", toolUseId: "toolu_2" }), dir);
  assert.equal(decisionOf(s2), "defer");

  const s1 = runHook("pre-tool", pushEvent(dir, { session: "s1", toolUseId: "toolu_1" }), dir);
  assert.equal(decisionOf(s1), "allow");
});

test("a changed retry of an approved call is a new proposal", () => {
  const dir = tmpProject();
  runHook("pre-tool", pushEvent(dir), dir);
  runCli(["approve", pendingEntries(dir)[0].id], dir);

  const changed = runHook(
    "pre-tool",
    pushEvent(dir, { toolUseId: "toolu_B", command: "git push --tags origin main" }),
    dir,
  );
  assert.equal(decisionOf(changed), "defer");
});

test("config holdTransport pins the transport, evidence or not", () => {
  const denied = tmpProject("deny");
  assert.equal(decisionOf(runHook("pre-tool", pushEvent(denied), denied)), "deny");

  const deferred = tmpProject("defer");
  assert.equal(decisionOf(runHook("pre-tool", pushEvent(deferred), deferred)), "defer");
});

test("a pre-0.4 allowance file is still honored (upgrading mid-run strands nothing)", () => {
  const dir = tmpProject("deny");
  // Park under the deny transport, the way reins < 0.4 did.
  runHook("pre-tool", pushEvent(dir, { toolUseId: "" }), dir);
  const parked = pendingEntries(dir)[0];

  fs.mkdirSync(path.join(dir, ".reins", "allowed"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, ".reins", "allowed", parked.input_hash + ".json"),
    JSON.stringify({
      action_id: parked.id,
      session_id: parked.session_id,
      tool: parked.tool,
      input_hash: parked.input_hash,
      rule_id: parked.rule_id,
      approved_ts: new Date().toISOString(),
    }),
  );

  const out = runHook("pre-tool", pushEvent(dir, { toolUseId: "" }), dir);
  assert.equal(decisionOf(out), "allow");
});

test("post-tool flags a hold breach when a still-parked action executed anyway", () => {
  const dir = tmpProject();
  runHook("pre-tool", pushEvent(dir), dir);

  // Simulate the known gap: the call ran despite being parked. spawnSync (not
  // execFileSync) because the warning goes to stderr on a SUCCESSFUL exit —
  // the detector must never break the run it is reporting on.
  const res = require("node:child_process").spawnSync(
    process.execPath,
    [CLI, "hook", "post-tool"],
    {
      input: JSON.stringify({
        ...pushEvent(dir),
        tool_response: { stdout: "pushed", stderr: "" },
      }),
      cwd: dir,
      encoding: "utf8",
      env: childEnv,
    },
  );
  assert.match(res.stderr, /HOLD BREACH/);
  assert.equal(res.status, 0); // detection must never break the run
});
