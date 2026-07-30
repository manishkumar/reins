// `reins scan` — deterministic, manifest-driven rule proposals.
//
// Motivated by a measured miss: in a Next.js + Prisma + Supabase repo, the
// shipped denylist fired sixteen times (wrongly, every time) on build
// artifacts, while `prisma`, `.env` reads and remote branch deletion — the
// things that repo could actually lose data to — ran unguarded for six weeks.
const { test } = require("node:test");
const assert = require("node:assert");
const os = require("node:os");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const CLI = path.join(__dirname, "..", "dist", "cli.js");
const { scanRepo } = require("../dist/scan.js");
const { checkGuards } = require("../dist/guards.js");

function tmpRepo(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reins-scan-"));
  fs.mkdirSync(path.join(dir, ".reins"), { recursive: true });
  for (const [rel, contents] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, contents);
  }
  return dir;
}

const PRISMA_SUPABASE_PKG = JSON.stringify({
  name: "app",
  dependencies: { prisma: "^5", "@prisma/client": "^5", "@supabase/supabase-js": "^2" },
});

test("scanRepo: detects the stack from manifests alone", () => {
  const dir = tmpRepo({ "package.json": PRISMA_SUPABASE_PKG, ".env": "SECRET=x" });
  const result = scanRepo(dir, []);
  const ids = result.detections.map((d) => d.id).sort();
  assert.deepStrictEqual(ids, ["dotenv", "npm-publish", "prisma", "supabase"]);
  // Every detection carries the evidence that justifies it.
  assert.ok(result.detections.every((d) => d.evidence && d.evidence.length > 0));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("scanRepo: an empty repo proposes nothing", () => {
  const dir = tmpRepo({ "README.md": "# hi" });
  const result = scanRepo(dir, []);
  assert.deepStrictEqual(result.detections, []);
  assert.deepStrictEqual(result.newRules, []);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("scanRepo: no proposed rule is a deny", () => {
  // A hand-written deny is a considered veto; a generated one is a guess.
  const dir = tmpRepo({
    "package.json": PRISMA_SUPABASE_PKG,
    ".env": "x",
    "main.tf": "",
    "alembic.ini": "",
    "manage.py": "",
    "k8s/deploy.yaml": "",
  });
  const result = scanRepo(dir, []);
  assert.ok(result.newRules.length > 0);
  for (const r of result.newRules) {
    assert.ok(r.action === "hold" || r.action === "ask", `${r.id} must not be a deny`);
    assert.strictEqual(r.origin, "suggested", `${r.id} must carry its provenance`);
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

test("scanRepo: proposals catch the real gaps and leave routine work alone", () => {
  const dir = tmpRepo({ "package.json": PRISMA_SUPABASE_PKG, ".env": "x" });
  const g = { rules: scanRepo(dir, []).newRules };
  const fires = (cmd) => {
    const m = checkGuards(g, "Bash", { command: cmd });
    return m ? m.rule.action : null;
  };

  // The command from the incident that motivated all of this.
  assert.strictEqual(fires("npx prisma migrate diff --shadow-database-url $DATABASE_URL_UNPOOLED"), "hold");
  assert.strictEqual(fires("npx prisma migrate reset"), "hold");
  assert.strictEqual(fires("supabase db reset"), "hold");
  // A real .env read from the captured transcript — secrets leave by being READ.
  assert.strictEqual(fires('grep -i "test|seed|demo" .env'), "ask");

  // ...and the routine work in that same repo stays untouched.
  for (const ok of ["npx prisma generate", "npm run build", "git status", "npx tsc --noEmit"]) {
    assert.strictEqual(fires(ok), null, `should not fire on: ${ok}`);
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

test("scanRepo: rules already in the policy are not re-proposed", () => {
  const dir = tmpRepo({ "package.json": PRISMA_SUPABASE_PKG });
  const existing = [{ id: "prisma-shadow-db", type: "bash", pattern: "x", reason: "mine" }];
  const result = scanRepo(dir, existing);
  assert.ok(result.alreadyPresent.includes("prisma-shadow-db"));
  assert.ok(!result.newRules.some((r) => r.id === "prisma-shadow-db"));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("scanRepo: a private package is not proposed a publish guard", () => {
  const dir = tmpRepo({ "package.json": JSON.stringify({ name: "app", private: true }) });
  assert.ok(!scanRepo(dir, []).detections.some((d) => d.id === "npm-publish"));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("scanRepo: malformed package.json degrades quietly", () => {
  const dir = tmpRepo({ "package.json": "{ not json" });
  assert.doesNotThrow(() => scanRepo(dir, []));
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------- CLI ----------

test("reins scan: proposes without enforcing, and stages to suggested.json", () => {
  const dir = tmpRepo({ "package.json": PRISMA_SUPABASE_PKG });
  execFileSync(process.execPath, [CLI, "init", "--local"], { cwd: dir, encoding: "utf8" });
  const before = fs.readFileSync(path.join(dir, ".reins", "policy.json"), "utf8");

  const out = execFileSync(process.execPath, [CLI, "scan"], { cwd: dir, encoding: "utf8" });
  assert.match(out, /prisma/);
  assert.match(out, /Nothing is enforced until you accept/);

  // The active policy is untouched; proposals are staged separately.
  assert.strictEqual(fs.readFileSync(path.join(dir, ".reins", "policy.json"), "utf8"), before);
  const staged = JSON.parse(fs.readFileSync(path.join(dir, ".reins", "suggested.json"), "utf8"));
  assert.ok(staged.rules.length > 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("reins scan --accept: moves proposals into the policy, keeping provenance", () => {
  const dir = tmpRepo({ "package.json": PRISMA_SUPABASE_PKG });
  execFileSync(process.execPath, [CLI, "init", "--local"], { cwd: dir, encoding: "utf8" });
  execFileSync(process.execPath, [CLI, "scan", "--accept"], { cwd: dir, encoding: "utf8" });

  const policy = JSON.parse(fs.readFileSync(path.join(dir, ".reins", "policy.json"), "utf8"));
  const added = policy.rules.filter((r) => r.origin === "suggested");
  assert.ok(added.length > 0, "accepted rules should be in the policy");
  assert.ok(added.every((r) => r.action !== "deny"));
  // The shipped defaults survive alongside them.
  assert.ok(policy.rules.some((r) => r.id === "rm-catastrophic"));
  // Re-scanning now finds nothing new.
  const again = execFileSync(process.execPath, [CLI, "scan"], { cwd: dir, encoding: "utf8" });
  assert.match(again, /already in your policy/);
  fs.rmSync(dir, { recursive: true, force: true });
});
