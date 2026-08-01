// Phase-2 gate behaviors: the hold queue. A guard rule with action "hold"
// parks a proposed action instead of vetoing it; `reins pending` lists the
// queue; `reins approve` writes a one-shot allowance the identical retry
// consumes; `reins deny` refuses (optionally steering an alternative). Hooks
// and CLI are exercised end-to-end the way Claude Code / the user invoke them.
const { test } = require("node:test");
const assert = require("node:assert");
const os = require("node:os");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const CLI = path.join(__dirname, "..", "dist", "cli.js");

function tmpProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reins-hold-"));
  fs.mkdirSync(path.join(dir, ".reins"), { recursive: true });
  // These tests cover the deny transport, so pin it rather than letting the
  // environment decide (see src/defer.ts): otherwise running `npm test` from
  // inside a `claude -p` session would silently change what is under test.
  // The defer transport has its own suite in test/defer.test.js.
  fs.writeFileSync(
    path.join(dir, ".reins", "config.json"),
    JSON.stringify({ holdTransport: "deny" }),
  );
  return dir;
}

// CLAUDE_PROJECT_DIR would override cwd-based project discovery in the child
// process; strip it so the tests always operate on their temp project.
const childEnv = { ...process.env, CLAUDE_PROJECT_DIR: "" };

function runHook(name, event, cwd) {
  return execFileSync(process.execPath, [CLI, "hook", name], {
    input: JSON.stringify(event),
    cwd,
    encoding: "utf8",
    env: childEnv,
  }).trim();
}

function runCli(args, cwd) {
  return execFileSync(process.execPath, [CLI, ...args], {
    cwd,
    encoding: "utf8",
    env: childEnv,
  });
}

function writeGuards(dir, rules) {
  fs.writeFileSync(path.join(dir, ".reins", "guards.json"), JSON.stringify({ rules }, null, 2));
}

const HOLD_RULE = {
  id: "push-hold",
  type: "bash",
  pattern: "git\\s+push",
  reason: "Pushing needs approval.",
  action: "hold",
};

const PUSH_EVENT = (dir, session = "h1") => ({
  cwd: dir,
  session_id: session,
  tool_name: "Bash",
  tool_input: { command: "git push origin main" },
});

function listPendingFiles(dir) {
  const p = path.join(dir, ".reins", "pending");
  return fs.existsSync(p) ? fs.readdirSync(p).filter((f) => f.endsWith(".json")) : [];
}

// ---------- parking ----------

test("pre-tool: hold rule denies the attempt and parks the action with an id", () => {
  const dir = tmpProject();
  writeGuards(dir, [HOLD_RULE]);
  const out = JSON.parse(runHook("pre-tool", PUSH_EVENT(dir), dir));
  assert.strictEqual(out.hookSpecificOutput.permissionDecision, "deny");
  const reason = out.hookSpecificOutput.permissionDecisionReason;
  const id = /parked for approval \(id ([0-9a-f]{8})\)/.exec(reason)?.[1];
  assert.ok(id, "deny reason must carry the parked action's id: " + reason);
  assert.match(reason, /continue with work/i, "must redirect the agent to other work");

  const files = listPendingFiles(dir);
  assert.deepStrictEqual(files, [id + ".json"]);
  const parked = JSON.parse(fs.readFileSync(path.join(dir, ".reins", "pending", files[0]), "utf8"));
  assert.strictEqual(parked.session_id, "h1");
  assert.strictEqual(parked.tool, "Bash");
  assert.strictEqual(parked.rule_id, "push-hold");
  assert.deepStrictEqual(parked.input, { command: "git push origin main" });
});

test("pre-tool: retrying a parked action re-denies with the SAME id (no duplicate)", () => {
  const dir = tmpProject();
  writeGuards(dir, [HOLD_RULE]);
  const first = JSON.parse(runHook("pre-tool", PUSH_EVENT(dir), dir));
  const second = JSON.parse(runHook("pre-tool", PUSH_EVENT(dir), dir));
  const idOf = (o) =>
    /\(id ([0-9a-f]{8})\)/.exec(o.hookSpecificOutput.permissionDecisionReason)[1];
  assert.strictEqual(idOf(first), idOf(second));
  assert.strictEqual(listPendingFiles(dir).length, 1);
});

test("pre-tool: hold without a session_id denies but does not park (manual invocation)", () => {
  const dir = tmpProject();
  writeGuards(dir, [HOLD_RULE]);
  const out = JSON.parse(
    runHook("pre-tool", { cwd: dir, tool_name: "Bash", tool_input: { command: "git push" } }, dir),
  );
  assert.strictEqual(out.hookSpecificOutput.permissionDecision, "deny");
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /not parked/);
  assert.strictEqual(listPendingFiles(dir).length, 0);
});

// ---------- pending / approve / deny ----------

test("pending: lists the parked action with id, tool, and rule", () => {
  const dir = tmpProject();
  writeGuards(dir, [HOLD_RULE]);
  runHook("pre-tool", PUSH_EVENT(dir), dir);
  const id = listPendingFiles(dir)[0].replace(".json", "");
  const out = runCli(["pending"], dir);
  assert.match(out, new RegExp(id));
  assert.match(out, /git push origin main/);
  assert.match(out, /push-hold/);
});

test("pending: empty queue says so", () => {
  const dir = tmpProject();
  assert.match(runCli(["pending"], dir), /No actions awaiting approval/);
});

test("approve: allowance lets the IDENTICAL retry through once, then holds again", () => {
  const dir = tmpProject();
  writeGuards(dir, [HOLD_RULE]);
  runHook("pre-tool", PUSH_EVENT(dir), dir);
  const id = listPendingFiles(dir)[0].replace(".json", "");

  const out = runCli(["approve", id], dir);
  assert.match(out, /Approved/);
  assert.strictEqual(listPendingFiles(dir).length, 0, "approved action must leave the queue");
  // The reply channel: the session got a targeted steer telling it to retry.
  const steer = fs.readFileSync(path.join(dir, ".reins", "steering.h1.txt"), "utf8");
  assert.match(steer, new RegExp(id));
  assert.match(steer, /approved/);

  // Identical retry: explicitly allowed (bypasses the platform prompt too).
  const retry = JSON.parse(runHook("pre-tool", PUSH_EVENT(dir), dir));
  assert.strictEqual(retry.hookSpecificOutput.permissionDecision, "allow");
  assert.match(retry.hookSpecificOutput.permissionDecisionReason, new RegExp(id));

  // One-shot: the same call after consumption parks again, under a NEW id.
  const third = JSON.parse(runHook("pre-tool", PUSH_EVENT(dir), dir));
  assert.strictEqual(third.hookSpecificOutput.permissionDecision, "deny");
  const newId = /\(id ([0-9a-f]{8})\)/.exec(
    third.hookSpecificOutput.permissionDecisionReason,
  )[1];
  assert.notStrictEqual(newId, id);
});

test("approve: a CHANGED retry is a new proposal, not pre-approved", () => {
  const dir = tmpProject();
  writeGuards(dir, [HOLD_RULE]);
  runHook("pre-tool", PUSH_EVENT(dir), dir);
  const id = listPendingFiles(dir)[0].replace(".json", "");
  runCli(["approve", id], dir);

  const changed = JSON.parse(
    runHook(
      "pre-tool",
      { cwd: dir, session_id: "h1", tool_name: "Bash", tool_input: { command: "git push origin main --tags" } },
      dir,
    ),
  );
  assert.strictEqual(changed.hookSpecificOutput.permissionDecision, "deny");
  assert.match(changed.hookSpecificOutput.permissionDecisionReason, /parked for approval/);
});

test("approve: id prefix works; unknown and ambiguous ids fail with exit 1", () => {
  const dir = tmpProject();
  writeGuards(dir, [HOLD_RULE]);
  runHook("pre-tool", PUSH_EVENT(dir), dir);
  const id = listPendingFiles(dir)[0].replace(".json", "");

  assert.throws(
    () => runCli(["approve", "zzzzzzzz"], dir),
    (e) => e.status === 1 && /No pending action/.test(e.stderr),
  );
  // Prefix resolution succeeds.
  const out = runCli(["approve", id.slice(0, 4)], dir);
  assert.match(out, /Approved/);
});

test("deny: removes the parked action and queues the alternative as steering", () => {
  const dir = tmpProject();
  writeGuards(dir, [HOLD_RULE]);
  runHook("pre-tool", PUSH_EVENT(dir), dir);
  const id = listPendingFiles(dir)[0].replace(".json", "");

  const out = runCli(["deny", id, "--steer", "push to the staging remote instead"], dir);
  assert.match(out, /Refused/);
  assert.strictEqual(listPendingFiles(dir).length, 0);
  const steer = fs.readFileSync(path.join(dir, ".reins", "steering.h1.txt"), "utf8");
  assert.match(steer, /refused/);
  assert.match(steer, /staging remote instead/);
  // No allowance was written: the retry parks again rather than passing.
  const retry = JSON.parse(runHook("pre-tool", PUSH_EVENT(dir), dir));
  assert.strictEqual(retry.hookSpecificOutput.permissionDecision, "deny");
});

test("deny without --steer queues nothing", () => {
  const dir = tmpProject();
  writeGuards(dir, [HOLD_RULE]);
  runHook("pre-tool", PUSH_EVENT(dir), dir);
  const id = listPendingFiles(dir)[0].replace(".json", "");
  runCli(["deny", id], dir);
  assert.ok(!fs.existsSync(path.join(dir, ".reins", "steering.h1.txt")));
});

// ---------- guard add --hold ----------

test("guard add --hold persists action hold; list shows it", () => {
  const dir = tmpProject();
  runCli(["guard", "add", "bash", "npm\\s+publish", "--hold"], dir);
  const saved = JSON.parse(fs.readFileSync(path.join(dir, ".reins", "policy.json"), "utf8"));
  const rule = saved.rules.find((r) => r.pattern === "npm\\s+publish");
  assert.strictEqual(rule.action, "hold");
  assert.match(runCli(["guard", "list"], dir), /hold/);
});

test("guard add rejects --ask combined with --hold", () => {
  const dir = tmpProject();
  assert.throws(
    () => runCli(["guard", "add", "bash", "git\\s+push", "--ask", "--hold"], dir),
    (e) => e.status === 1 && /Pick one hardness/.test(e.stderr),
  );
});

// ---------- audit trail + session end (need a SQLite backend) ----------

const hasSqlite = (() => {
  try {
    require("node:sqlite");
    return true;
  } catch {
    return false;
  }
})();

test("held/approved/refused rows carry rule and hold ids", { skip: !hasSqlite }, () => {
  const dir = tmpProject();
  writeGuards(dir, [HOLD_RULE]);
  runHook("pre-tool", PUSH_EVENT(dir), dir); // HELD
  const id = listPendingFiles(dir)[0].replace(".json", "");
  runCli(["approve", id], dir);
  runHook("pre-tool", PUSH_EVENT(dir), dir); // APPROVED (allowance consumed)
  runHook("pre-tool", PUSH_EVENT(dir), dir); // parks again
  const id2 = listPendingFiles(dir)[0].replace(".json", "");
  runCli(["deny", id2], dir); // REFUSED

  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(path.join(dir, ".reins", "runs.db"), { readOnly: true });
  const rows = db.prepare("SELECT input_summary, input_hash, ok FROM tool_calls ORDER BY seq").all();
  assert.strictEqual(rows.length, 4);
  assert.match(rows[0].input_summary, new RegExp(`^HELD: git push origin main \\[guard:push-hold\\] \\[hold:${id}\\]$`));
  assert.strictEqual(rows[0].ok, 0);
  assert.match(rows[1].input_summary, new RegExp(`^APPROVED: git push origin main \\[guard:push-hold\\] \\[hold:${id}\\]$`));
  assert.strictEqual(rows[1].ok, null);
  assert.match(rows[3].input_summary, new RegExp(`\\[hold:${id2}\\]$`));
  assert.match(rows[3].input_summary, /^REFUSED: /);
  // Decision rows use decision-derived hashes so the eventual real execution's
  // loop counting stays clean: none may collide with the executed call's hash.
  // (The two HELD rows of the SAME proposal sharing a hash is by design.)
  const crypto = require("node:crypto");
  const realHash = crypto
    .createHash("sha256")
    .update('Bash {"command":"git push origin main"}')
    .digest("hex")
    .slice(0, 16);
  for (const r of rows) assert.notStrictEqual(r.input_hash, realHash, r.input_summary);
  assert.notStrictEqual(rows[0].input_hash, rows[1].input_hash, "HELD vs APPROVED must differ");
});

test("stop: a run ending with parked actions records holds-pending in outcomes", { skip: !hasSqlite }, () => {
  const dir = tmpProject();
  writeGuards(dir, [HOLD_RULE]);
  runHook("pre-tool", PUSH_EVENT(dir, "h9"), dir);
  runHook("stop", { cwd: dir, session_id: "h9" }, dir);

  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(path.join(dir, ".reins", "runs.db"), { readOnly: true });
  const row = db.prepare("SELECT gate_result FROM outcomes WHERE session_id = 'h9'").get();
  assert.strictEqual(row.gate_result, "holds-pending:1");

  // And the human-facing views surface it.
  assert.match(runCli(["lastrun", "h9"], dir), /awaiting your approval/);
  assert.match(runCli(["sessions"], dir), /awaiting approval/);
});

test("pre-tool: a park tells the HUMAN directly, in the same single JSON object", () => {
  const dir = tmpProject();
  writeGuards(dir, [HOLD_RULE]);
  const out = runHook("pre-tool", PUSH_EVENT(dir, "hn1"), dir);

  // The stdout protocol is ONE object, not two writes — a second JSON blob
  // would corrupt the hook channel even though each half parses alone.
  assert.strictEqual(out.trim().indexOf("}{"), -1, "must not emit two objects");
  const parsed = JSON.parse(out);

  // Agent-facing half unchanged.
  assert.strictEqual(parsed.hookSpecificOutput.permissionDecision, "deny");
  assert.match(parsed.hookSpecificOutput.permissionDecisionReason, /parked for approval/);

  // Human-facing half: systemMessage is the only field Claude Code shows the
  // user. It has to carry the id and the action, so the reader can act without
  // hunting through tool output for what the agent said.
  assert.ok(parsed.systemMessage, "the human must be told directly");
  assert.match(parsed.systemMessage, /HELD/);
  assert.match(parsed.systemMessage, /origin main/);
  const id = parsed.hookSpecificOutput.permissionDecisionReason.match(/id ([0-9a-f]{8})/)[1];
  assert.match(parsed.systemMessage, new RegExp("reins approve " + id));
});

test("pre-tool: re-proposing a parked action does not re-notify the human", () => {
  const dir = tmpProject();
  writeGuards(dir, [HOLD_RULE]);
  const first = JSON.parse(runHook("pre-tool", PUSH_EVENT(dir, "hn2"), dir));
  const again = JSON.parse(runHook("pre-tool", PUSH_EVENT(dir, "hn2"), dir));

  assert.ok(first.systemMessage, "first park notifies");
  assert.strictEqual(again.systemMessage, undefined, "the same park must not notify twice");
  // Quieter is not weaker — it is still held.
  assert.strictEqual(again.hookSpecificOutput.permissionDecision, "deny");
});
