// Guard-bypass detection.
//
// Every "bypass pair" below is a verbatim transcript excerpt from a real repo
// (nyayakosh-ocr-frontend, Jul 2026). In each, reins denied a command and the
// agent reran the same intent seconds later with a flag removed — five for
// five, median eleven seconds. The guard cost a round trip and prevented
// nothing. These tests are the guarantee that reins now says so out loud.
const { test } = require("node:test");
const assert = require("node:assert");
const os = require("node:os");
const fs = require("node:fs");
const path = require("node:path");

const {
  fingerprint,
  containment,
  recordDenial,
  findBypass,
  markBypassed,
  summarizeSession,
  formatSummary,
  clearSession,
  BYPASS_SIMILARITY,
} = require("../dist/bypass.js");

function tmpProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reins-bypass-"));
  fs.mkdirSync(path.join(dir, ".reins"), { recursive: true });
  return dir;
}

// The five real pairs: [denied, what ran seconds later].
const REAL_BYPASS_PAIRS = [
  [
    "rm -f src/app/pdf-harness/page.tsx && rmdir src/app/pdf-harness && rm -f public/pdfjs/__harness.pdf",
    "rm src/app/pdf-harness/page.tsx && rmdir src/app/pdf-harness && rm public/pdfjs/__harness.pdf",
  ],
  [
    "rm -f .next/types/app/pdf-harness/page.ts && rmdir .next/types/app/pdf-harness",
    "rm .next/types/app/pdf-harness/page.ts && rmdir .next/types/app/pdf-harness && echo removed",
  ],
  ["rm -f package-lock.json", "rm package-lock.json"],
  ["rm -rf .next && npm run build", "rm -r .next && npm run build"],
  ["rm -rf .next", "rm .next"],
];

test("fingerprint: strips the flags an agent edits to slip a veto", () => {
  assert.deepStrictEqual(fingerprint("rm -rf .next"), fingerprint("rm -r .next"));
  assert.deepStrictEqual(fingerprint("rm -f a.txt"), fingerprint("rm a.txt"));
  assert.deepStrictEqual(fingerprint("rm ./a.txt"), fingerprint("rm a.txt"));
  // ...but the target still matters.
  assert.notDeepStrictEqual(fingerprint("rm -rf src"), fingerprint("rm -rf dist"));
});

test("containment: the five real bypass pairs all clear the threshold", () => {
  for (const [denied, ran] of REAL_BYPASS_PAIRS) {
    const score = containment(fingerprint(denied), fingerprint(ran));
    assert.ok(score >= BYPASS_SIMILARITY, `${score.toFixed(2)} too low for: ${denied}`);
  }
});

test("containment: unrelated commands stay well below the threshold", () => {
  const pairs = [
    ["rm -rf src", "npm run build"],
    ["rm -rf src", "rm -rf dist"],
    ["git push --force origin main", "git status"],
    ["rm -rf node_modules", "npx tsc --noEmit"],
  ];
  for (const [a, b] of pairs) {
    const score = containment(fingerprint(a), fingerprint(b));
    assert.ok(score < BYPASS_SIMILARITY, `${score.toFixed(2)} too high for: ${a} vs ${b}`);
  }
});

test("findBypass: detects the retry, once, and only in the same session", () => {
  const dir = tmpProject();
  const [denied, ran] = REAL_BYPASS_PAIRS[0];
  recordDenial(dir, {
    session_id: "s1",
    ts: new Date().toISOString(),
    rule_id: "rm-rf",
    tool: "Bash",
    summary: denied,
    fp: fingerprint(denied),
  });

  // A different session must not be blamed for it.
  assert.strictEqual(findBypass(dir, "s2", ran), null);

  const hit = findBypass(dir, "s1", ran);
  assert.ok(hit, "should detect the bypass");
  assert.strictEqual(hit.denial.rule_id, "rm-rf");
  assert.ok(hit.score >= BYPASS_SIMILARITY);

  // Reported once: after marking, the same call no longer re-triggers.
  markBypassed(dir, hit, ran);
  assert.strictEqual(findBypass(dir, "s1", ran), null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("findBypass: a stale denial falls outside the attribution window", () => {
  const dir = tmpProject();
  const [denied, ran] = REAL_BYPASS_PAIRS[2];
  recordDenial(dir, {
    session_id: "s1",
    ts: new Date(Date.now() - 60 * 60 * 1000).toISOString(), // an hour ago
    rule_id: "rm-rf",
    tool: "Bash",
    summary: denied,
    fp: fingerprint(denied),
  });
  assert.strictEqual(findBypass(dir, "s1", ran), null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("summarizeSession + formatSummary: leads with the bypass, not the fire", () => {
  const dir = tmpProject();
  for (const [denied, ran] of REAL_BYPASS_PAIRS.slice(0, 3)) {
    recordDenial(dir, {
      session_id: "s1",
      ts: new Date().toISOString(),
      rule_id: "rm-rf",
      tool: "Bash",
      summary: denied,
      fp: fingerprint(denied),
    });
    const hit = findBypass(dir, "s1", ran);
    assert.ok(hit, `expected a hit for: ${ran}`);
    markBypassed(dir, hit, ran);
  }
  const summary = summarizeSession(dir, "s1");
  assert.strictEqual(summary.fired, 3);
  assert.strictEqual(summary.bypassed, 3);
  assert.strictEqual(summary.byRule[0].rule_id, "rm-rf");

  const line = formatSummary(summary, 0);
  assert.match(line, /3 guards fired/);
  assert.match(line, /3 of them were worked around/);
  // The honest caveat travels with the number.
  assert.match(line, /form of a command, not its intent/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("formatSummary: silent when there is nothing to report", () => {
  assert.strictEqual(formatSummary({ fired: 0, bypassed: 0, byRule: [], fastestBypassMs: null }, 0), null);
  // ...but pending holds alone are worth a line.
  const held = formatSummary({ fired: 0, bypassed: 0, byRule: [], fastestBypassMs: null }, 2);
  assert.match(held, /2 actions still parked for approval/);
});

test("clearSession: drops one session's rows and leaves the rest", () => {
  const dir = tmpProject();
  for (const sid of ["s1", "s2"]) {
    recordDenial(dir, {
      session_id: sid,
      ts: new Date().toISOString(),
      rule_id: "rm-rf",
      tool: "Bash",
      summary: "rm -rf x",
      fp: fingerprint("rm -rf x"),
    });
  }
  clearSession(dir, "s1");
  assert.strictEqual(summarizeSession(dir, "s1").fired, 0);
  assert.strictEqual(summarizeSession(dir, "s2").fired, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("the ledger never throws into a hook, even on a corrupt file", () => {
  const dir = tmpProject();
  fs.writeFileSync(path.join(dir, ".reins", "denials.jsonl"), "{not json\n{\"session_id\":\"s1\"}\n");
  assert.doesNotThrow(() => findBypass(dir, "s1", "rm -rf x"));
  assert.doesNotThrow(() => summarizeSession(dir, "s1"));
  assert.doesNotThrow(() => recordDenial(dir, { session_id: "s1", ts: new Date().toISOString(), rule_id: "r", tool: "Bash", summary: "x", fp: ["x"] }));
  fs.rmSync(dir, { recursive: true, force: true });
});
