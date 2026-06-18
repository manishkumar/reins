const { test } = require("node:test");
const assert = require("node:assert");

// store.js memoizes the driver, so exercise the env-gated path in a child proc.
const { execFileSync } = require("node:child_process");
const path = require("node:path");

const storePath = path.join(__dirname, "..", "dist", "store.js");

function evalInChild(env, expr) {
  return execFileSync(process.execPath, ["-e", expr], {
    env: { ...process.env, ...env },
    encoding: "utf8",
  }).trim();
}

test("getDriver: REINS_NO_SQLITE disables capture, capabilityNote explains", () => {
  const out = evalInChild(
    { REINS_NO_SQLITE: "1" },
    `const s=require(${JSON.stringify(storePath)});` +
      `console.log(JSON.stringify({driver:s.getDriver(),note:s.capabilityNote()}))`,
  );
  const { driver, note } = JSON.parse(out);
  assert.strictEqual(driver, null);
  assert.match(note, /capture is OFF/i);
});

test("getDriver: on Node >=22.5 the built-in node:sqlite driver is found", () => {
  const [major, minor] = process.versions.node.split(".").map(Number);
  const hasBuiltin = major > 22 || (major === 22 && minor >= 5);
  if (!hasBuiltin) {
    // On older Node without better-sqlite3 installed, driver may be null — fine.
    return;
  }
  const out = evalInChild(
    {},
    `const s=require(${JSON.stringify(storePath)});` +
      `const d=s.getDriver();console.log(d?d.name:'null')`,
  );
  assert.strictEqual(out, "node:sqlite");
});
