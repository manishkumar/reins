const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { findProjectDir, resolveProjectDir } = require("../dist/paths.js");
const steering = require("../dist/steering.js");

/** resolveProjectDir reads CLAUDE_PROJECT_DIR at call time, and the suite may
 *  itself be running inside a Claude Code session that sets it. Pin it. */
function withProjectDir(value, fn) {
  const had = Object.prototype.hasOwnProperty.call(process.env, "CLAUDE_PROJECT_DIR");
  const prev = process.env.CLAUDE_PROJECT_DIR;
  if (value === undefined) delete process.env.CLAUDE_PROJECT_DIR;
  else process.env.CLAUDE_PROJECT_DIR = value;
  try {
    return fn();
  } finally {
    if (had) process.env.CLAUDE_PROJECT_DIR = prev;
    else delete process.env.CLAUDE_PROJECT_DIR;
  }
}

function tmp() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "reins-paths-")));
}

test("findProjectDir: walks up to the dir containing .reins", () => {
  const root = tmp();
  fs.mkdirSync(path.join(root, ".reins"));
  const deep = path.join(root, "src", "auth", "deep");
  fs.mkdirSync(deep, { recursive: true });
  assert.strictEqual(findProjectDir(deep), root);
  assert.strictEqual(findProjectDir(root), root);
  fs.rmSync(root, { recursive: true, force: true });
});

test("findProjectDir: falls back to start when no .reins anywhere", () => {
  const root = tmp();
  const sub = path.join(root, "a", "b");
  fs.mkdirSync(sub, { recursive: true });
  assert.strictEqual(findProjectDir(sub), sub);
  fs.rmSync(root, { recursive: true, force: true });
});

test("findProjectDir: stopAt bounds the walk and is itself checked", () => {
  const root = tmp();
  fs.mkdirSync(path.join(root, ".reins"));
  const mid = path.join(root, "packages");
  const deep = path.join(mid, "api", "src");
  fs.mkdirSync(deep, { recursive: true });

  // Bound at the root: the root's own .reins is still found.
  assert.strictEqual(findProjectDir(deep, root), root);
  // Bound below the root: the walk stops before reaching it, so the caller's
  // own directory is used rather than state filed outside the bound.
  assert.strictEqual(findProjectDir(deep, mid), deep);
  // A bound that isn't an ancestor of `start` can't describe the same project,
  // so it's ignored rather than obeyed.
  assert.strictEqual(findProjectDir(deep, tmp()), root);
  fs.rmSync(root, { recursive: true, force: true });
});

test("findProjectDir: nearest ancestor wins when .reins dirs are nested", () => {
  const root = tmp();
  fs.mkdirSync(path.join(root, ".reins"));
  const nested = path.join(root, "packages", "api");
  fs.mkdirSync(path.join(nested, ".reins"), { recursive: true });
  const deep = path.join(nested, "src", "routes");
  fs.mkdirSync(deep, { recursive: true });
  assert.strictEqual(findProjectDir(deep), nested);
  fs.rmSync(root, { recursive: true, force: true });
});

test("resolveProjectDir: a subdirectory payload cwd resolves to the project root", () => {
  // The bug: the event cwd is the TOOL CALL's directory, so one `cd` into a
  // subdirectory used to make the hooks read a .reins that isn't there — and
  // silently behave as if the project had never been configured.
  const root = tmp();
  fs.mkdirSync(path.join(root, ".reins"));
  const deep = path.join(root, "packages", "api", "src");
  fs.mkdirSync(deep, { recursive: true });
  withProjectDir(undefined, () => {
    assert.strictEqual(resolveProjectDir(deep), root);
  });
  withProjectDir(root, () => {
    assert.strictEqual(resolveProjectDir(deep), root);
  });
  fs.rmSync(root, { recursive: true, force: true });
});

test("resolveProjectDir: never climbs above CLAUDE_PROJECT_DIR", () => {
  // An uninitialized project must not adopt an ancestor's .reins and start
  // filing steering/approvals somewhere the user will never look.
  const outer = tmp();
  fs.mkdirSync(path.join(outer, ".reins")); // a stray ancestor, e.g. ~/.reins
  const project = path.join(outer, "project");
  const deep = path.join(project, "src");
  fs.mkdirSync(deep, { recursive: true });
  withProjectDir(project, () => {
    assert.strictEqual(resolveProjectDir(deep), deep);
  });
  fs.rmSync(outer, { recursive: true, force: true });
});

test("appendSteering: keeps both nudges; consume returns combined", () => {
  const dir = tmp();
  assert.strictEqual(steering.appendSteering("use the logger", dir), 1);
  assert.strictEqual(steering.appendSteering("one function only", dir), 2);
  const consumed = steering.consumeSteering(dir);
  assert.match(consumed, /use the logger/);
  assert.match(consumed, /one function only/);
  assert.strictEqual(steering.consumeSteering(dir), null); // one-shot
  fs.rmSync(dir, { recursive: true, force: true });
});

test("consumeSteering: targeted nudge only reaches its session; broadcast is shared", () => {
  const dir = tmp();
  steering.writeSteering("for A only", dir, "sessA");
  steering.writeSteering("broadcast", dir); // global

  // Session B (no targeted file) gets the broadcast.
  assert.strictEqual(steering.consumeSteering(dir, "sessB"), "broadcast");
  // Session A still has its targeted nudge waiting; it prefers that.
  assert.strictEqual(steering.consumeSteering(dir, "sessA"), "for A only");
  // Both consumed now.
  assert.strictEqual(steering.consumeSteering(dir, "sessA"), null);
  fs.rmSync(dir, { recursive: true, force: true });
});
