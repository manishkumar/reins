// Run with: npm run build && npm test
const { test } = require("node:test");
const assert = require("node:assert");
const os = require("node:os");
const fs = require("node:fs");
const path = require("node:path");

const guards = require("../dist/guards.js");
const util = require("../dist/util.js");
const steering = require("../dist/steering.js");

test("globToRegExp: ** crosses separators, * does not", () => {
  assert.ok(guards.globToRegExp("**/.env").test("/a/b/.env"));
  assert.ok(guards.globToRegExp("**/.env").test(".env"));
  assert.ok(guards.globToRegExp("infra/**").test("infra/k8s/deploy.yaml"));
  assert.ok(!guards.globToRegExp("*.pem").test("a/b.pem")); // * stays within a segment
  assert.ok(guards.globToRegExp("*.pem").test("key.pem"));
});

test("matchesPathGlob: matches ABSOLUTE paths (Marcus's infra/** bug)", () => {
  const infra = guards.globToRegExp("infra/**");
  assert.ok(guards.matchesPathGlob(infra, "infra/main.tf"));
  assert.ok(guards.matchesPathGlob(infra, "/Users/x/proj/infra/main.tf")); // was silently allowed
  assert.ok(!guards.matchesPathGlob(infra, "/Users/x/proj/src/main.tf"));
});

test("matchesPathGlob: .env* family, but not lookalikes", () => {
  const env = guards.globToRegExp("**/.env*");
  assert.ok(guards.matchesPathGlob(env, "/p/.env"));
  assert.ok(guards.matchesPathGlob(env, "/p/.env.local")); // the real secret files
  assert.ok(guards.matchesPathGlob(env, "/p/.env.production"));
  assert.ok(!guards.matchesPathGlob(env, "/p/server.env.log")); // must NOT false-positive
});

test("matchesPathGlob: Windows backslash separators are normalized", () => {
  const git = guards.globToRegExp("**/.git/**");
  assert.ok(guards.matchesPathGlob(git, "C:\\proj\\.git\\config"));
});

test("checkGuards: bash rm -rf is denied, safe command is not", () => {
  const g = { rules: guards.DEFAULT_RULES };
  assert.ok(guards.checkGuards(g, "Bash", { command: "rm -rf build" }));
  assert.ok(guards.checkGuards(g, "Bash", { command: "sudo rm -fr /tmp/x" }));
  assert.strictEqual(guards.checkGuards(g, "Bash", { command: "ls -la" }), null);
  assert.strictEqual(guards.checkGuards(g, "Bash", { command: "npm run format" }), null);
});

test("checkGuards: path rule only applies to file tools, not bash", () => {
  const g = { rules: guards.DEFAULT_RULES };
  assert.ok(guards.checkGuards(g, "Write", { file_path: "/proj/.env" }));
  assert.ok(guards.checkGuards(g, "Write", { file_path: ".env" }));
  // .env via shell is caught by the dedicated bash rule
  assert.ok(guards.checkGuards(g, "Bash", { command: "printf x > .env" }));
  assert.strictEqual(guards.checkGuards(g, "Bash", { command: "cat .env" }), null);
});

test("checkGuards: malformed user regex is skipped, not thrown", () => {
  const g = { rules: [{ id: "bad", type: "bash", pattern: "(", reason: "x" }] };
  assert.doesNotThrow(() => guards.checkGuards(g, "Bash", { command: "anything" }));
  assert.strictEqual(guards.checkGuards(g, "Bash", { command: "anything" }), null);
});

test("hashToolInput: stable across key order, differs on content", () => {
  const a = util.hashToolInput("Write", { file_path: "x", content: "y" });
  const b = util.hashToolInput("Write", { content: "y", file_path: "x" });
  const c = util.hashToolInput("Write", { file_path: "x", content: "z" });
  assert.strictEqual(a, b);
  assert.notStrictEqual(a, c);
});

test("summarizeToolInput: prefers meaningful field, truncates", () => {
  assert.strictEqual(util.summarizeToolInput("Bash", { command: "ls -la" }), "ls -la");
  assert.strictEqual(util.summarizeToolInput("Write", { file_path: "/a/b.ts" }), "/a/b.ts");
  const long = "x".repeat(500);
  assert.ok(util.summarizeToolInput("Bash", { command: long }).length <= 160);
});

test("steering: consume is one-shot", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reins-test-"));
  steering.writeSteering("keep it minimal", dir);
  assert.strictEqual(steering.peekSteering(dir), "keep it minimal");
  assert.strictEqual(steering.consumeSteering(dir), "keep it minimal");
  assert.strictEqual(steering.consumeSteering(dir), null); // cleared
  fs.rmSync(dir, { recursive: true, force: true });
});

test("formatSteeringContext: additive framing, not hijack", () => {
  const ctx = steering.formatSteeringContext("focus on token refresh");
  assert.ok(ctx.includes("focus on token refresh"));
  assert.ok(/refines the goal; it does not replace it/i.test(ctx));
});
