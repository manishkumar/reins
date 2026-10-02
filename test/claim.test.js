// Run with: npm run build && npm test
// The claim check: what a session's own tool calls say about its work being
// done. It reports on every surface and decides nothing.
const { test } = require("node:test");
const assert = require("node:assert");
const os = require("node:os");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const { checkClaim, verificationIn, claimNeedsAttention } = require("../dist/claim.js");
const { getDriver } = require("../dist/store.js");
const R = require("../dist/tui/render.js");
const term = require("../dist/tui/term.js");

const CLI = path.join(__dirname, "..", "dist", "cli.js");
const hasSqlite = !!getDriver();
const plain = new term.Style("none");

const bash = (summary, ok = 1) => ({ tool: "Bash", summary, ok });
const edit = (file, ok = 1) => ({ tool: "Edit", summary: file, ok });

test("verificationIn: a test or build command counts only at command position", () => {
  assert.deepStrictEqual(verificationIn("npm test"), { kinds: ["test"], visible: true });
  assert.deepStrictEqual(verificationIn("cd app && CI=1 npx vitest run"), { kinds: ["test"], visible: true });
  assert.deepStrictEqual(verificationIn("npm run build && npm test").kinds.sort(), ["build", "test"]);
  assert.deepStrictEqual(verificationIn("cargo clippy").kinds, ["build"]);
  assert.deepStrictEqual(verificationIn("python3 -m pytest -q tests/").kinds, ["test"]);
  assert.deepStrictEqual(verificationIn("node --test test/"), { kinds: ["test"], visible: true });

  for (const notARun of [
    'grep -n "npm test" README.md',
    "cat test/unit.test.js",
    'echo "run npm test before you push"',
    "git commit -m 'fix the build'",
    "ls test",
    "cat > notes.md <<'EOF' npm test EOF",
  ]) {
    assert.strictEqual(verificationIn(notARun), null, notARun);
  }
});

test("verificationIn: a piped or cut-short run has no visible result", () => {
  assert.strictEqual(verificationIn("npm test 2>&1 | tail -5").visible, false, "the exit status is tail's");
  assert.strictEqual(verificationIn("set -o pipefail; npm test 2>&1 | tail -5").visible, true);
  assert.strictEqual(verificationIn("npm test 2>&1").visible, true, "a redirect is not a pipe");
  assert.strictEqual(verificationIn("npm test || exit 1").visible, true, "the failure still ends the call");
  assert.strictEqual(verificationIn("npm run build && npm test").visible, true);
  assert.strictEqual(verificationIn("npm test;").visible, true, "nothing follows the separator");
  assert.strictEqual(verificationIn("npm test -- --grep a-very-long-pattern…").visible, false, "the summary was truncated");
});

test("verificationIn: a run whose exit status is replaced has no visible result", () => {
  for (const masked of [
    "npm test || true",
    "npm test || echo failed",
    "npm test || exit 0",
    "npm test; echo done",
    "npm test 2>&1; git status",
    "npm test &",
    "npm test & wait",
    "if npm test; then echo ok; fi",
  ]) {
    const v = verificationIn(masked);
    assert.ok(v, masked);
    assert.strictEqual(v.visible, false, masked);
  }
  assert.strictEqual(verificationIn("set -e; npm test; echo done").visible, true, "set -e ends the call at the failure");
  assert.strictEqual(verificationIn("npm test 2>&1 && echo ok").visible, true);
  assert.strictEqual(verificationIn("npm test > out.log 2>&1").visible, true, "2>&1 is not a background job");

  // A masked pass is not reported as verified.
  assert.strictEqual(checkClaim([edit("src/a.ts"), bash("npm test || true", 1)]).verdict, "unknown");
});

test("verificationIn: a run behind a wrapper, a subshell or a path still counts", () => {
  for (const [command, kind] of [
    ["timeout 120 npm test", "test"],
    ["timeout -s KILL 5m npx jest", "test"],
    ["(cd pkg && npm test)", "test"],
    ["./node_modules/.bin/jest --ci", "test"],
    ["node_modules/.bin/tsc --noEmit", "build"],
    ['bash -c "npm test"', "test"],
    ["sh -c 'cd app && cargo test'", "test"],
    ["env CI=1 npm test", "test"],
    ["./gradlew test", "test"],
  ]) {
    const v = verificationIn(command);
    assert.ok(v, command);
    assert.deepStrictEqual(v.kinds, [kind], command);
    assert.strictEqual(v.visible, true, command);
  }
  assert.strictEqual(verificationIn('echo "$(npm test)"'), null);
  assert.strictEqual(verificationIn("ls ./test"), null);
});

test("checkClaim: the five verdicts", () => {
  assert.strictEqual(checkClaim([bash("ls"), { tool: "Read", summary: "a.ts", ok: 1 }]).verdict, "none");

  const unverified = checkClaim([edit("src/a.ts"), edit("src/b.ts"), edit("src/a.ts")]);
  assert.strictEqual(unverified.verdict, "unverified");
  assert.strictEqual(unverified.text, "2 files edited, no test or build run");

  const failed = checkClaim([edit("src/a.ts"), bash("npm test", 0)]);
  assert.strictEqual(failed.verdict, "failed");
  assert.strictEqual(failed.text, "the last test run failed");
  assert.strictEqual(failed.command, "npm test");

  const stale = checkClaim([edit("src/a.ts"), bash("npm test"), edit("src/b.ts")]);
  assert.strictEqual(stale.verdict, "stale");
  assert.strictEqual(stale.text, "1 file edited after the last test run");

  const unknown = checkClaim([edit("src/a.ts"), bash("npm test | tail -3")]);
  assert.strictEqual(unknown.verdict, "unknown");

  const verified = checkClaim([edit("src/a.ts"), bash("npm test", 0), edit("src/a.ts"), bash("npm test")]);
  assert.strictEqual(verified.verdict, "verified");
  assert.strictEqual(verified.text, "tests passed after the last edit");

  for (const c of [unverified, failed, stale]) assert.strictEqual(claimNeedsAttention(c), true);
  for (const c of [unknown, verified]) assert.strictEqual(claimNeedsAttention(c), false);
});

test("checkClaim: it does not over-claim", () => {
  // A build that passed after a failed test run does not repair the tests.
  const c = checkClaim([edit("src/a.ts"), bash("npm test", 0), bash("npm run build")]);
  assert.strictEqual(c.verdict, "failed");
  assert.match(c.text, /test run failed/);

  // A build alone is not a test run, and the text says so.
  assert.strictEqual(checkClaim([edit("src/a.ts"), bash("npm run build")]).text, "the build passed after the last edit; no test run after the last edit");

  // An interrupted run (ok unknown) is not a pass.
  assert.strictEqual(checkClaim([edit("src/a.ts"), bash("npm test", null)]).verdict, "unknown");

  // A held or denied call never ran, and an edit that failed changed nothing.
  assert.strictEqual(checkClaim([{ tool: "Bash", summary: "DENIED: npm test [guard:x]", ok: 0 }]).verdict, "none");
  assert.strictEqual(checkClaim([edit("src/a.ts", 0)]).verdict, "none");

  // Prose is not what a test run verifies.
  assert.strictEqual(checkClaim([edit("README.md"), edit("docs/notes.txt")]).verdict, "none");
  assert.strictEqual(checkClaim([bash("npm test"), edit("CHANGELOG.md")]).verdict, "verified");
});

// ----------------------------------------------------------- on each surface

function tmp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reins-claim-"));
  fs.mkdirSync(path.join(dir, ".reins"), { recursive: true });
  return dir;
}
const env = { ...process.env, CLAUDE_PROJECT_DIR: "", NO_COLOR: "1" };
const cli = (args, dir) => execFileSync(process.execPath, [CLI, ...args], { cwd: dir, encoding: "utf8", env });
function hook(name, event, dir) {
  const r = require("node:child_process").spawnSync(process.execPath, [CLI, "hook", name], { cwd: dir, encoding: "utf8", env, input: JSON.stringify(event) });
  return { out: r.stdout.trim(), err: r.stderr, status: r.status };
}
const SID = "claim-session-1";
const did = (dir, tool, input, failed = false) =>
  hook(failed ? "post-tool-failure" : "post-tool", { cwd: dir, session_id: SID, tool_name: tool, tool_input: input, ...(failed ? { error: "Exit code 1" } : { tool_response: {} }) }, dir);

test("stop: a turn that left a failing test run says so, and does not block the stop", { skip: !hasSqlite }, () => {
  const dir = tmp();
  try {
    did(dir, "Edit", { file_path: "src/a.ts" });
    did(dir, "Bash", { command: "npm test" }, true);
    const r = hook("stop", { cwd: dir, session_id: SID }, dir);
    assert.strictEqual(r.status, 0);
    const obj = JSON.parse(r.out);
    assert.deepStrictEqual(Object.keys(obj), ["systemMessage"], "a message only: no decision, so the stop proceeds");
    assert.match(obj.systemMessage, /Claim check: the last test run failed \(npm test\)/);
    assert.match(r.err, /Claim check/);

    // The next turn is conversation only: nothing new to say, so nothing is said.
    assert.strictEqual(hook("stop", { cwd: dir, session_id: SID }, dir).out, "");

    // Fixed and re-run: verified is not an interruption.
    did(dir, "Edit", { file_path: "src/a.ts" });
    did(dir, "Bash", { command: "npm test" });
    assert.strictEqual(hook("stop", { cwd: dir, session_id: SID }, dir).out, "");

    assert.match(cli(["lastrun"], dir), /Claim check[\s\S]*tests passed after the last edit/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("stop: claimCheck false silences the line; edits with nothing run are reported by default", { skip: !hasSqlite }, () => {
  const dir = tmp();
  try {
    did(dir, "Write", { file_path: "src/new.ts" });
    assert.match(JSON.parse(hook("stop", { cwd: dir, session_id: SID }, dir).out).systemMessage, /1 file edited, no test or build run/);

    fs.writeFileSync(path.join(dir, ".reins", "config.json"), JSON.stringify({ claimCheck: false }));
    did(dir, "Write", { file_path: "src/other.ts" });
    assert.strictEqual(hook("stop", { cwd: dir, session_id: SID }, dir).out, "");
    assert.match(cli(["lastrun"], dir), /2 files edited, no test or build run/, "lastrun still shows it");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("report and lastrun: the verdict is on the session", { skip: !hasSqlite }, () => {
  const dir = tmp();
  try {
    did(dir, "Edit", { file_path: "src/a.ts" });
    did(dir, "Bash", { command: "npm test" }, true);
    assert.match(cli(["lastrun"], dir), /Claim check[\s\S]*the last test run failed/);
    const html = path.join(dir, "r.html");
    cli(["report", "--out", html], dir);
    assert.match(fs.readFileSync(html, "utf8"), /<div class="claim failed">Claim check: the last test run failed\. <code>npm test<\/code><\/div>/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("cockpit: an idle agent carries its verdict; a working one does not", () => {
  const NOW = Date.parse("2026-09-30T12:00:00.000Z");
  const agent = (over) => ({
    id: "3b9f2a1c-1111-2222-3333-444455556666", name: "brave-otter", label: "brave-otter", asked: null, branch: null,
    ended: false, outcome: null, calls: 4, startedMs: NOW - 600_000, lastTsMs: NOW - 120_000, streak: 1, steerQueued: null,
    spark: new Array(24).fill(0), trajectory: [], holds: 0,
    claim: { verdict: "failed", text: "the last test run failed", command: "npm test", edited: 1, editedSince: 0 },
    ...over,
  });
  const model = (a) => ({ repo: "/r", nowMs: NOW, threshold: 3, captured: true, holds: [], events: [], olderEvents: 0, agents: [a], broadcast: null });
  const ui = { width: 140, height: 30, cursor: 0, zoom: false, detailScroll: 0, modal: null, toast: null, flashUntil: 0, intervalSec: 2 };

  const idle = R.renderScreen(model(agent({})), ui, plain).join("\n");
  assert.match(idle, /idle 2m\s+✗ checks failed/);
  assert.match(idle, /claim\s+✗ the last test run failed/);

  const working = R.renderScreen(model(agent({ lastTsMs: NOW - 1000 })), ui, plain);
  assert.ok(!working.some((l) => /active\s+✗ checks failed/.test(l)), "no chip on the row while active");
  assert.match(working.join("\n"), /claim\s+✗ the last test run failed/, "the detail pane still has it");
});
