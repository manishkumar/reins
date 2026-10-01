// Run with: npm run build && npm test
// The footprint: what a session edited and ran, as facts beside its prompt.
const { test } = require("node:test");
const assert = require("node:assert");
const os = require("node:os");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const { footprint, footprintLines, commandHeads } = require("../dist/footprint.js");
const { shellCommands, mayWriteFiles } = require("../dist/shell.js");
const { checkClaim } = require("../dist/claim.js");
const { getDriver } = require("../dist/store.js");

const CLI = path.join(__dirname, "..", "dist", "cli.js");
const hasSqlite = !!getDriver();
const ROOT = "/work/app";
const bash = (summary, ok = 1) => ({ tool: "Bash", summary, ok });
const edit = (file, ok = 1) => ({ tool: "Edit", summary: file, ok });

test("shellCommands: quoted text and heredoc bodies are not commands", () => {
  const heads = (s) => shellCommands(s).map((c) => c.words[0]);
  assert.deepStrictEqual(heads("cd app && FOO=1 npx vitest run | tail -3; git status"), ["cd", "vitest", "git"]);
  assert.deepStrictEqual(heads(`node -e 'const a = 1; console.log(a)'`), ["node"]);
  assert.deepStrictEqual(heads(`grep -E "a|b;c" file && ls`), ["grep", "ls"]);
  assert.deepStrictEqual(heads("python3 - <<'EOF' import os; os.system('npm test') EOF"), ["python3"]);
  assert.deepStrictEqual(heads(`echo "unterminated; git push x`), ["echo"], "an open quote swallows the rest");
  assert.strictEqual(shellCommands("npm test | tail")[0].piped, true);
  assert.strictEqual(shellCommands("npm test || true")[0].piped, false);
});

test("commandHeads: leading words, with the subcommand where it matters", () => {
  assert.deepStrictEqual(commandHeads("cd src && git status --short | head; npm run build && /usr/bin/grep -rn x ."), [
    "git status",
    "npm run build",
    "grep",
  ]);
  assert.deepStrictEqual(commandHeads("D=$(ls -d /tmp/x) && echo hi"), [], "a flag left from a subshell is not a command");
  assert.deepStrictEqual(commandHeads("npm test"), ["npm test"]);
});

test("mayWriteFiles: redirects, in-place edits and inline scripts", () => {
  for (const yes of [
    "cat > src/a.ts <<'EOF' x EOF",
    "sed -i '' s/a/b/ f.ts",
    "echo x >> log.txt",
    "python3 - <<'EOF' open('a','w') EOF",
    "git checkout -- src",
    "ls | tee out.txt",
  ]) {
    assert.strictEqual(mayWriteFiles(yes), true, yes);
  }
  for (const no of ["npm test 2>&1 | tail", "ls > /dev/null", "grep -n x file", "git status", "cat file"]) {
    assert.strictEqual(mayWriteFiles(no), false, no);
  }
});

test("footprint: files, directories, outside-the-project count and commands", () => {
  const fp = footprint(
    [
      edit(`${ROOT}/src/tui/render.ts`),
      edit(`${ROOT}/src/tui/render.ts`),
      edit(`${ROOT}/src/tui/model.ts`),
      edit(`${ROOT}/README.md`),
      edit("/etc/hosts"),
      edit(`${ROOT}/src/broken.ts`, 0),
      { tool: "Bash", summary: "DENIED: docker system prune [guard:docker-prune]", ok: 0 },
      bash("npm test"),
      bash("npm test"),
      bash("git status"),
      bash("sed -i '' s/a/b/ src/x.ts"),
      { tool: "Read", summary: `${ROOT}/src/a.ts`, ok: 1 },
    ],
    ROOT,
  );
  assert.deepStrictEqual(fp.files[0], { path: "src/tui/render.ts", edits: 2 });
  assert.strictEqual(fp.files.length, 4, "a failed edit and a read are not edits");
  assert.deepStrictEqual(fp.dirs[0], { dir: "src/tui/", files: 2, edits: 3 });
  assert.ok(fp.dirs.some((d) => d.dir === "./"), "a root-level file is in ./");
  assert.strictEqual(fp.outside, 1);
  assert.strictEqual(fp.shellWrites, 1);
  assert.deepStrictEqual(fp.commands[0], { head: "npm test", runs: 2 });
  assert.ok(!fp.commands.some((c) => c.head.startsWith("docker")), "a denied command never ran");

  const lines = footprintLines(fp);
  assert.strictEqual(lines[0], "edited 4 files in 3 directories, 5 edits (1 outside the project)");
  assert.ok(lines.includes("  src/tui/  2 files · 3 edits"));
  assert.match(lines.join("\n"), /1 shell command may have changed files too/);
  assert.match(lines[lines.length - 1], /^ran: npm test ×2 · /);
  assert.deepStrictEqual(footprintLines(footprint([], ROOT)), []);
});

test("checkClaim: a pass says how many shell writes after it could not be seen", () => {
  const c = checkClaim([edit("src/a.ts"), bash("npm test"), bash("sed -i '' s/a/b/ src/a.ts")]);
  assert.strictEqual(c.verdict, "verified");
  assert.strictEqual(c.shellWritesSince, 1);
  assert.strictEqual(c.text, "tests passed after the last edit; 1 shell command after it may have changed files");
});

test("lastrun and report show the footprint beside the ask", { skip: !hasSqlite }, () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "reins-fp-")));
  fs.mkdirSync(path.join(dir, ".reins"), { recursive: true });
  const env = { ...process.env, CLAUDE_PROJECT_DIR: "", NO_COLOR: "1" };
  const did = (tool, input) =>
    execFileSync(process.execPath, [CLI, "hook", "post-tool"], {
      cwd: dir,
      env,
      encoding: "utf8",
      input: JSON.stringify({ cwd: dir, session_id: "fp-1", tool_name: tool, tool_input: input, tool_response: {} }),
    });
  try {
    did("Edit", { file_path: path.join(dir, "src", "auth", "login.ts") });
    did("Edit", { file_path: path.join(dir, "src", "auth", "login.ts") });
    did("Write", { file_path: path.join(dir, "src", "billing", "invoice.ts") });
    did("Bash", { command: "npm test" });
    const out = execFileSync(process.execPath, [CLI, "lastrun"], { cwd: dir, env, encoding: "utf8" });
    assert.match(out, /Footprint/);
    assert.match(out, /edited 2 files in 2 directories, 3 edits/);
    assert.match(out, /src\/auth\/ {2}1 file · 2 edits/);
    assert.match(out, /ran: npm test ×1/);

    const html = path.join(dir, "r.html");
    execFileSync(process.execPath, [CLI, "report", "--out", html], { cwd: dir, env, encoding: "utf8" });
    assert.match(fs.readFileSync(html, "utf8"), /<pre class="footprint">edited 2 files in 2 directories, 3 edits/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("cockpit: the agent detail pane shows the footprint under what it was asked", () => {
  const R = require("../dist/tui/render.js");
  const term = require("../dist/tui/term.js");
  const NOW = Date.parse("2026-09-30T12:00:00.000Z");
  const a = {
    id: "3b9f2a1c-1111-2222-3333-444455556666", name: "brave-otter", label: "Fix the login redirect",
    asked: "the redirect loops on logout", branch: "fix/login", ended: false, outcome: null, calls: 4,
    startedMs: NOW - 600_000, lastTsMs: NOW - 1000, streak: 1, steerQueued: null, spark: new Array(24).fill(0),
    trajectory: [], holds: 0,
    claim: { verdict: "none", text: "", command: null, edited: 0, editedSince: 0, shellWritesSince: 0 },
    footprint: footprint([edit(`${ROOT}/src/billing/invoice.ts`), bash("npm test")], ROOT),
  };
  const m = { repo: ROOT, nowMs: NOW, threshold: 3, captured: true, holds: [], events: [], olderEvents: 0, agents: [a], broadcast: null };
  const ui = { width: 140, height: 34, cursor: 0, zoom: false, detailScroll: 0, modal: null, toast: null, flashUntil: 0, intervalSec: 2 };
  const out = R.renderScreen(m, ui, new term.Style("none")).join("\n");
  assert.ok(out.indexOf("asked") < out.indexOf("footprint"), "the ask comes first");
  assert.match(out, /edited 1 file in 1 directory, 1 edit/);
  assert.match(out, /src\/billing\/ {2}1 file · 1 edit/);
  assert.match(out, /ran: npm test ×1/);
});
