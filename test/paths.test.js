const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { findProjectDir } = require("../dist/paths.js");
const steering = require("../dist/steering.js");

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
