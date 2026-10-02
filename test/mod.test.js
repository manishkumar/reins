// Run with: npm run build && npm test
// `reins init --mod`: the status mod is copied in, never over someone else's folder, and removed exactly.
const { test } = require("node:test");
const assert = require("node:assert");
const os = require("node:os");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const M = require("../dist/modInstall.js");
const CLI = path.join(__dirname, "..", "dist", "cli.js");

const project = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "reins-mod-")));
const files = (dir) => M.MOD_FILES.map((f) => path.join(M.modTargetDir(dir), f));

test("the package ships every file the mod needs", () => {
  for (const f of M.MOD_FILES) assert.ok(fs.existsSync(path.join(M.modSourceDir(), f)), f);
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"));
  assert.ok(pkg.files.includes("mods/reins-status"), "mods/reins-status is in the npm package");
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(M.modSourceDir(), ".claude-plugin", "plugin.json"), "utf8")).name, M.MOD_NAME);
});

test("installMod: copies the mod, is idempotent, and repairs a changed file", () => {
  const dir = project();
  try {
    assert.strictEqual(M.installMod(dir).status, "installed");
    for (const f of files(dir)) assert.ok(fs.existsSync(f), f);
    assert.ok(!fs.existsSync(path.join(M.modTargetDir(dir), "hooks", "status.test.tsx")), "tests are not copied into a project");
    assert.strictEqual(M.installMod(dir).status, "already");

    fs.writeFileSync(files(dir)[2], "// an older version\n");
    assert.strictEqual(M.installMod(dir).status, "updated");
    assert.deepStrictEqual(fs.readFileSync(files(dir)[2]), fs.readFileSync(path.join(M.modSourceDir(), M.MOD_FILES[2])));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("installMod: a folder of the same name that is not this mod is left alone", () => {
  const dir = project();
  try {
    const target = M.modTargetDir(dir);
    fs.mkdirSync(path.join(target, ".claude-plugin"), { recursive: true });
    fs.writeFileSync(path.join(target, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "someone-elses" }));
    fs.writeFileSync(path.join(target, "SKILL.md"), "theirs");
    assert.strictEqual(M.installMod(dir).status, "foreign");
    assert.strictEqual(fs.readFileSync(path.join(target, "SKILL.md"), "utf8"), "theirs");
    assert.ok(!fs.existsSync(path.join(target, "hooks")));
    assert.strictEqual(M.removeMod(dir), 0, "and uninstall does not touch it either");
    assert.ok(fs.existsSync(path.join(target, "SKILL.md")));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("removeMod: removes what was added and keeps what the person put beside it", () => {
  const dir = project();
  try {
    const other = path.join(dir, ".claude", "skills", "deploy", "SKILL.md");
    fs.mkdirSync(path.dirname(other), { recursive: true });
    fs.writeFileSync(other, "theirs");
    M.installMod(dir);
    const note = path.join(M.modTargetDir(dir), "hooks", "notes.txt");
    fs.writeFileSync(note, "mine");

    assert.strictEqual(M.removeMod(dir), M.MOD_FILES.length);
    for (const f of files(dir)) assert.ok(!fs.existsSync(f), f);
    assert.ok(fs.existsSync(note), "a file reins did not write stays");
    assert.ok(!fs.existsSync(path.join(M.modTargetDir(dir), "types")), "an emptied folder goes");
    assert.ok(fs.existsSync(other), "another skill is untouched");

    fs.rmSync(note);
    M.installMod(dir);
    M.removeMod(dir);
    assert.ok(!fs.existsSync(M.modTargetDir(dir)), "with nothing else in it, the mod folder goes");
    assert.ok(fs.existsSync(path.join(dir, ".claude", "skills")), "the skills folder stays while it holds another skill");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("reins init: the mod is opt-in, and reins uninstall takes it out", () => {
  const dir = project();
  const run = (...args) => execFileSync(process.execPath, [CLI, ...args], { cwd: dir, encoding: "utf8", env: { ...process.env, NO_COLOR: "1", CLAUDE_PROJECT_DIR: dir } });
  try {
    run("init");
    assert.ok(!fs.existsSync(M.modTargetDir(dir)), "plain init installs no mod");

    assert.match(run("init", "--mod"), /Installed the status mod in \.claude[\\/]skills[\\/]reins-status/);
    for (const f of files(dir)) assert.ok(fs.existsSync(f), f);
    assert.match(run("init", "--mod"), /Status mod already installed/);

    assert.match(run("uninstall"), /Removed the status mod/);
    assert.ok(!fs.existsSync(path.join(dir, ".claude", "skills")), "nothing of the mod is left");
    assert.ok(fs.existsSync(path.join(dir, ".claude", "settings.json")), "settings.json stays");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
