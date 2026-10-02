// Run with: npm run build && npm test
// One face per session on every surface: sessions, pending, lastrun, the steer
// picker and the report name a session the way the cockpit does.
const { test } = require("node:test");
const assert = require("node:assert");
const os = require("node:os");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const { sessionFace, faceReader, headOf, aboutOf } = require("../dist/sessionFace.js");
const { parseTail } = require("../dist/sessionContext.js");
const { mnemonic } = require("../dist/names.js");
const { formatPickerRow } = require("../dist/commands/steer.js");
const { getDriver } = require("../dist/store.js");

const CLI = path.join(__dirname, "..", "dist", "cli.js");
const hasSqlite = !!getDriver();
const SID = "3b9f2a1c-1111-2222-3333-444455556666";
const line = (o) => JSON.stringify(o);

function transcriptIn(dir, o = {}) {
  const file = path.join(dir, "t.jsonl");
  fs.writeFileSync(
    file,
    [
      line({ type: "ai-title", aiTitle: o.title ?? "Fix the login redirect" }),
      line({ type: "last-prompt", lastPrompt: o.asked ?? "the redirect loops on logout" }),
      line({ type: "user", gitBranch: o.branch ?? "fix/login-redirect" }),
    ].join("\n") + "\n",
  );
  return file;
}

function tmp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reins-face-"));
  fs.mkdirSync(path.join(dir, ".reins", "pending"), { recursive: true });
  return dir;
}

const env = (dir) => ({ ...process.env, CLAUDE_PROJECT_DIR: "", NO_COLOR: "1" });
const cli = (args, dir) => execFileSync(process.execPath, [CLI, ...args], { cwd: dir, encoding: "utf8", env: env(dir) });
const hook = (name, event, dir) =>
  execFileSync(process.execPath, [CLI, "hook", name], { cwd: dir, encoding: "utf8", env: env(dir), input: JSON.stringify(event) });

test("sessionFace: a custom name leads, then the transcript title, then the mnemonic", () => {
  const dir = tmp();
  try {
    const t = transcriptIn(dir);
    const titled = sessionFace(SID, null, t);
    assert.strictEqual(titled.label, "Fix the login redirect");
    assert.strictEqual(titled.name, mnemonic(SID));
    assert.strictEqual(headOf(titled, SID), "Fix the login redirect");
    assert.strictEqual(aboutOf(titled, SID), `${mnemonic(SID)} 3b9f2a1c · ⎇ fix/login-redirect · ❯ the redirect loops on logout`);

    const named = sessionFace(SID, "auth-work", t);
    assert.strictEqual(named.label, "auth-work");
    assert.strictEqual(named.name, "auth-work");
    assert.strictEqual(headOf(named, SID), "auth-work 3b9f2a1c");

    const bare = sessionFace(SID);
    assert.strictEqual(headOf(bare, SID), `${mnemonic(SID)} 3b9f2a1c`);
    assert.strictEqual(aboutOf(bare, SID), "");
    assert.strictEqual(faceReader(null)(SID).label, mnemonic(SID), "no DB: the mnemonic stands");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("parseTail: control characters never leave the transcript reader", () => {
  const ctx = parseTail(
    [line({ type: "ai-title", aiTitle: "nice\u001b]52;c;ZXZpbA==\u0007title" }), line({ type: "last-prompt", lastPrompt: "a\u001b[2Jb\u0085c" })].join("\n"),
  );
  assert.ok(!/[\u0000-\u001f\u007f-\u009f]/.test(ctx.title + ctx.asked), "no C0/C1 controls survive");
  assert.match(ctx.title, /^nice /);
});

test("formatPickerRow: leads with the title and keeps the address on the next line", () => {
  const now = Date.now();
  const row = { id: SID, name: null, calls: 3, lastTsMs: now - 1000, lastTool: "Bash", lastSummary: "npm test" };
  const face = { name: mnemonic(SID), label: "Fix the login redirect", asked: "the redirect loops", branch: "fix/login" };
  const out = formatPickerRow(row, 0, now, face);
  const [first, second] = out.split("\n");
  assert.match(first, /1\. .*Fix the login redirect/);
  assert.ok(second.includes(`${mnemonic(SID)} 3b9f2a1c`), "mnemonic and short id stay addressable");
  assert.match(second, /⎇ fix\/login · ❯ the redirect loops/);
});

test("sessions, pending, lastrun and report all name the session by its title", { skip: !hasSqlite }, () => {
  const dir = tmp();
  try {
    const t = transcriptIn(dir);
    hook("post-tool", { session_id: SID, cwd: dir, transcript_path: t, tool_name: "Bash", tool_input: { command: "npm test" }, tool_response: {} }, dir);
    fs.writeFileSync(
      path.join(dir, ".reins", "pending", "abcd1234.json"),
      JSON.stringify({ id: "abcd1234", session_id: SID, tool: "Bash", input: { command: "npm publish" }, input_hash: "h1", cwd: fs.realpathSync(dir), transport: "deny", rule_id: "publish-hold", reason: "r", ts: new Date().toISOString() }),
    );
    const name = mnemonic(SID);

    for (const args of [["sessions"], ["pending"], ["lastrun"], ["lastrun", name]]) {
      const out = cli(args, dir);
      assert.match(out, /Fix the login redirect/, `${args.join(" ")} shows the title`);
      assert.ok(out.includes(name), `${args.join(" ")} keeps the mnemonic`);
      assert.match(out, /3b9f2a1c/, `${args.join(" ")} keeps the id`);
    }
    assert.match(cli(["sessions"], dir), /⎇ fix\/login-redirect · ❯ the redirect loops on logout/);
    assert.match(cli(["lastrun"], dir), /asked\s+the redirect loops on logout/);

    const html = path.join(dir, "r.html");
    cli(["report", "--no-open", "--out", html], dir);
    const page = fs.readFileSync(html, "utf8");
    assert.match(page, /<span class="sid">Fix the login redirect<\/span>/);
    assert.match(page, /Fix the login redirect \(3b9f2a1c\)/, "the held action names its session");
    assert.ok(page.includes(`${name} 3b9f2a1c · ⎇ fix/login-redirect`));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("report: a title is escaped like any other run text", { skip: !hasSqlite }, () => {
  const dir = tmp();
  try {
    const t = transcriptIn(dir, { title: "<img src=x onerror=alert(1)>" });
    hook("post-tool", { session_id: SID, cwd: dir, transcript_path: t, tool_name: "Bash", tool_input: { command: "ls" }, tool_response: {} }, dir);
    const html = path.join(dir, "r.html");
    cli(["report", "--no-open", "--out", html], dir);
    const page = fs.readFileSync(html, "utf8");
    assert.ok(!page.includes("<img src=x"), "no raw markup from a title");
    assert.match(page, /&lt;img src=x/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
