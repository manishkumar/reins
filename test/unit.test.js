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
  assert.ok(guards.checkGuards(g, "Bash", { command: "rm -rf src" }));
  assert.ok(guards.checkGuards(g, "Bash", { command: "sudo rm -fr /opt/myapp" }));
  assert.strictEqual(guards.checkGuards(g, "Bash", { command: "ls -la" }), null);
  assert.strictEqual(guards.checkGuards(g, "Bash", { command: "npm run format" }), null);
});

test("checkGuards: rm recursive long-flags are caught (Dana's bypass)", () => {
  const g = { rules: guards.DEFAULT_RULES };
  for (const cmd of [
    "rm --recursive --force x",
    "rm --force --recursive x",
    "rm --force -r x",
    "rm -R dir",
    "rm --recursive dir",
  ]) {
    assert.ok(guards.checkGuards(g, "Bash", { command: cmd }), `should block: ${cmd}`);
  }
});

test("checkGuards: single-file rm is NOT blocked (no false positive)", () => {
  const g = { rules: guards.DEFAULT_RULES };
  for (const cmd of ["rm file.txt", "rm -f file.txt", "rm --force file.txt", "rm -i x", "rm -v x"]) {
    assert.strictEqual(guards.checkGuards(g, "Bash", { command: cmd }), null, `should allow: ${cmd}`);
  }
});

test("checkGuards: a hyphen in a FILENAME is not read as a recursive flag", () => {
  const g = { rules: guards.DEFAULT_RULES };
  // The live regression: `-pr` inside the filename matched -[a-z]*r[a-z]* and
  // got the whole `gh pr merge && … && rm -f` line wrongly vetoed.
  for (const cmd of [
    "rm -f /tmp/reins-pr-body.md",
    "rm ./my-recursive-notes.txt",
    "rm -f build-artifacts.tar",
  ]) {
    assert.strictEqual(guards.checkGuards(g, "Bash", { command: cmd }), null, `should allow: ${cmd}`);
  }
  // ...but a genuine recursive rm with a hyphenated path is still blocked.
  assert.ok(guards.checkGuards(g, "Bash", { command: "rm -rf ./reins-pr-body" }), "rm -rf still blocked");
  assert.ok(guards.checkGuards(g, "Bash", { command: "rm dir -r" }), "trailing -r still blocked");
});

test("checkGuards: pattern inside a quoted arg is not falsely blocked", () => {
  const g = { rules: guards.DEFAULT_RULES };
  // The classic ticket-generators — pattern appears only inside a string arg.
  assert.strictEqual(
    guards.checkGuards(g, "Bash", { command: 'git commit -m "removed the rm -rf call"' }),
    null,
  );
  assert.strictEqual(guards.checkGuards(g, "Bash", { command: 'echo "DROP TABLE users"' }), null);
  // But a real recursive rm with a quoted PATH is still blocked.
  assert.ok(guards.checkGuards(g, "Bash", { command: 'rm -rf "my build dir"' }));
});

test("stripQuoted: removes quoted literals, keeps the rest", () => {
  assert.strictEqual(guards.stripQuoted('git commit -m "rm -rf"').includes("rm -rf"), false);
  assert.ok(guards.stripQuoted('rm -rf "a b"').includes("rm -rf"));
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

// ---------- exemptions + command segmentation (policy v2) ----------
//
// These cases are not hypothetical. Every command in ALLOWED below was denied
// by reins in a real repo (nyayakosh-ocr-frontend, 51 sessions / 2,396 tool
// calls, Jun-Jul 2026) and in all 16 firings the guard was wrong — the agent
// simply re-ran the same deletion without the flag, median 11 seconds later.

test("checkGuards: build artifacts and scratch dirs are exempt from rm-rf", () => {
  const g = { rules: guards.DEFAULT_RULES };
  const ALLOWED = [
    "rm -rf .next && npm run build",
    "rm -r .next && npm run build 2>&1 | tail -12",
    "rm -rf /Users/m/proj/.next && sleep 3",
    "cd /Users/m/proj; rm -rf .next/types/app/matters 2>&1 || rm -rf ./.next/types/app/matters",
    "rm -rf node_modules && npm install",
    "rm -rf dist build coverage",
    "rm -rf /private/tmp/claude-501/-Users-m/abc/scratchpad/tessdata",
    "rm -rf target",
    "rm -rf __pycache__",
  ];
  for (const cmd of ALLOWED) {
    assert.strictEqual(guards.checkGuards(g, "Bash", { command: cmd }), null, `should allow: ${cmd}`);
  }
});

test("checkGuards: catastrophic rm targets are blocked and NEVER exempt", () => {
  const g = { rules: guards.DEFAULT_RULES };
  for (const cmd of ["rm -rf /", "rm -rf /*", "rm -rf ~", "rm -rf ~/", "rm -rf $HOME", "rm -rf /etc", "rm -rf /Users", "rm -rf .."]) {
    const m = guards.checkGuards(g, "Bash", { command: cmd });
    assert.ok(m, `should block: ${cmd}`);
    assert.strictEqual(m.rule.id, "rm-catastrophic", `wrong rule for: ${cmd}`);
  }
});

test("checkGuards: an exempt segment does not launder its neighbours", () => {
  // The reason exemptions are judged per segment rather than per command.
  const g = { rules: guards.DEFAULT_RULES };
  assert.strictEqual(
    guards.checkGuards(g, "Bash", { command: "rm -rf .next && rm -rf /" }).rule.id,
    "rm-catastrophic",
  );
  assert.strictEqual(
    guards.checkGuards(g, "Bash", { command: "rm -rf /tmp/x && rm -rf ~" }).rule.id,
    "rm-catastrophic",
  );
  assert.strictEqual(guards.checkGuards(g, "Bash", { command: "rm -rf dist; rm -rf src" }).rule.id, "rm-rf");
});

test("splitCommandSegments: splits on operators but not inside quotes", () => {
  assert.deepStrictEqual(guards.splitCommandSegments("a && b || c ; d | e & f"), ["a ", " b ", " c ", " d ", " e ", " f"]);
  assert.deepStrictEqual(guards.splitCommandSegments('git commit -m "build; then deploy"'), [
    'git commit -m "build; then deploy"',
  ]);
  assert.deepStrictEqual(guards.splitCommandSegments("echo 'a; b'"), ["echo 'a; b'"]);
  assert.deepStrictEqual(guards.splitCommandSegments("solo"), ["solo"]);
});

test("checkGuards: remote branch deletion is blocked (both spellings)", () => {
  const g = { rules: guards.DEFAULT_RULES };
  for (const cmd of ["git push origin --delete feat/foo", "git push origin :feat/foo", "git push -d origin topic"]) {
    assert.ok(guards.checkGuards(g, "Bash", { command: cmd }), `should block: ${cmd}`);
  }
  assert.strictEqual(guards.checkGuards(g, "Bash", { command: "git push -u origin feat/foo" }), null);
});

test("validateRules: a malformed except is an error, a trivial one a warning", () => {
  const bad = guards.validateRules([
    { id: "r1", type: "bash", pattern: "x", reason: "r", except: ["([unclosed"] },
  ]);
  assert.ok(bad.some((p) => p.severity === "error" && /invalid except/.test(p.message)));
  const trivial = guards.validateRules([{ id: "r2", type: "bash", pattern: "x", reason: "r", except: [".*"] }]);
  assert.ok(trivial.some((p) => p.severity === "warning" && /never fire/.test(p.message)));
  const notArray = guards.validateRules([{ id: "r3", type: "bash", pattern: "x", reason: "r", except: "nope" }]);
  assert.ok(notArray.some((p) => p.severity === "error" && /must be an array/.test(p.message)));
});

test("tokenizeArgs: quotes make a phrase one argument, and vanish", () => {
  assert.deepStrictEqual(guards.tokenizeArgs('rm -rf "my build dir" src'), ["rm", "-rf", "my build dir", "src"]);
  assert.deepStrictEqual(guards.tokenizeArgs("rm -rf '/a b/c'"), ["rm", "-rf", "/a b/c"]);
  assert.deepStrictEqual(guards.tokenizeArgs("rm  -rf   x"), ["rm", "-rf", "x"]);
});

test("checkGuards: an exemption must BE the argument, not appear inside it", () => {
  // The distinction quoting exists to make: `build` as a path component is a
  // build directory; `build` as a word inside a filename is not.
  const g = { rules: guards.DEFAULT_RULES };
  assert.ok(guards.checkGuards(g, "Bash", { command: 'rm -rf "my build dir"' }), "phrase must NOT exempt");
  assert.ok(guards.checkGuards(g, "Bash", { command: "rm -rf build-tools" }), "prefix must NOT exempt");
  assert.strictEqual(guards.checkGuards(g, "Bash", { command: "rm -rf /Users/x/p/build" }), null);
  assert.strictEqual(guards.checkGuards(g, "Bash", { command: 'rm -rf "/Users/x/my proj/dist"' }), null);
});

test("checkGuards: a relative argument is judged from the session's cwd", () => {
  // Found by dogfooding: an agent that has cd'd into its scratchpad writes
  // `rm -rf home proj`, not the absolute path. Every scratch exemption is
  // anchored `^/`, so without cwd the exemption list is unreachable from the
  // one place it was written for.
  const g = { rules: guards.DEFAULT_RULES };
  const scratch = "/private/tmp/claude-501/session/scratchpad";
  const cmd = { command: "rm -rf home proj" };

  assert.ok(guards.checkGuards(g, "Bash", cmd), "no cwd → blocked (fail toward firing)");
  assert.strictEqual(guards.checkGuards(g, "Bash", cmd, scratch), null, "scratch cwd → exempt");
  assert.strictEqual(guards.checkGuards(g, "Bash", cmd, "/tmp/x"), null, "/tmp cwd → exempt");
  assert.ok(guards.checkGuards(g, "Bash", cmd, "/Users/x/realproject"), "real repo cwd → still blocked");
});

test("checkGuards: cwd resolution never widens past what it was for", () => {
  const g = { rules: guards.DEFAULT_RULES };
  const scratch = "/private/tmp/session/scratchpad";

  // A `cd` makes the hook's cwd stale, so resolution is dropped entirely —
  // otherwise `cd / && rm -rf home` would be exempted into deleting /home.
  assert.ok(
    guards.checkGuards(g, "Bash", { command: "cd / && rm -rf home" }, scratch),
    "cd in the command drops relative resolution",
  );
  // An unexpanded variable resolves to a literal, not to where it points.
  assert.ok(
    guards.checkGuards(g, "Bash", { command: "rm -rf $PROJECT_ROOT" }, scratch),
    "unexpanded $VAR must not be resolved into the exemption",
  );
  // Absolute and ~ arguments are judged as written, cwd or not.
  assert.ok(
    guards.checkGuards(g, "Bash", { command: "rm -rf /Users/x/realproject/src" }, scratch),
    "absolute path is not reinterpreted relative to cwd",
  );
  // rm-catastrophic carries no exemptions, so no cwd can ever clear it.
  assert.strictEqual(
    guards.checkGuards(g, "Bash", { command: "rm -rf /" }, scratch).rule.id,
    "rm-catastrophic",
  );
  assert.strictEqual(
    guards.checkGuards(g, "Bash", { command: "rm -rf ~" }, scratch).rule.id,
    "rm-catastrophic",
  );
  // Escaping the scratch dir with .. must not stay exempt.
  assert.ok(
    guards.checkGuards(g, "Bash", { command: "rm -rf ../../../../Users/x/proj" }, scratch),
    "..-escape out of scratch is still blocked",
  );
  // Regression: judging exemptions per-resolved-token would clear the rule via
  // the command word itself (`rm` -> `<scratch>/rm`, which matches the scratch
  // exemption), exempting a deletion aimed anywhere. The exemption asks whether
  // EVERY argument stays inside cwd, so these stay blocked.
  assert.ok(
    guards.checkGuards(g, "Bash", { command: "sudo rm -rf /Users/x/proj" }, scratch),
    "command word must not resolve into an exemption",
  );
  assert.ok(
    guards.checkGuards(g, "Bash", { command: "rm -rf home /Users/x/proj" }, scratch),
    "one confined arg must not exempt an unconfined sibling",
  );
});
