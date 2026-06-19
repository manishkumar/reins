const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const dbPath = path.join(__dirname, "..", "dist", "db.js");

// Each worker is its own process that opens the DB and inserts one row — the
// real-world shape (every hook is a fresh process). Guards the regression where
// the WAL-mode set inside openDb lost the lock race and dropped whole batches.
const worker = (cwd, sid) =>
  `const db=require(${JSON.stringify(dbPath)});` +
  `const h=db.openDb(${JSON.stringify(cwd)});` +
  `db.upsertSessionStart(h,${JSON.stringify(sid)},${JSON.stringify(cwd)},new Date().toISOString());` +
  `db.insertToolCall(h,{session_id:${JSON.stringify(sid)},tool:"Bash",input_summary:"x",input_hash:"h",ok:1,ts:new Date().toISOString()});`;

test("concurrent openDb + insert across processes loses no rows", async () => {
  const { getDriver } = require("../dist/store.js");
  if (!getDriver()) return; // no SQLite backend on this Node — capture disabled, skip

  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "reins-conc-"));
  const N = 24;

  await Promise.all(
    Array.from({ length: N }, (_, i) =>
      new Promise((resolve, reject) => {
        const p = spawn(process.execPath, ["-e", worker(cwd, "s" + (i % 3))], { stdio: "ignore" });
        p.on("exit", (code) => (code === 0 ? resolve() : reject(new Error("worker exit " + code))));
        p.on("error", reject);
      }),
    ),
  );

  const { openDbReadOnly } = require("../dist/db.js");
  const db = openDbReadOnly(cwd);
  const rows = Number(db.prepare("SELECT COUNT(*) AS c FROM tool_calls").get().c);
  fs.rmSync(cwd, { recursive: true, force: true });
  assert.strictEqual(rows, N, `expected ${N} rows, got ${rows}`);
});
