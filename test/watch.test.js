// Run with: npm run build && npm test
const { test } = require("node:test");
const assert = require("node:assert");

const { renderFrame } = require("../dist/commands/watch.js");

function call(over) {
  return { tool: "Bash", summary: "npm test", denied: false, failed: false, looped: false, ...over };
}

function sess(over) {
  return {
    id: "3b9f2a1c-1111-2222-3333-444455556666",
    ended: false,
    outcome: null,
    calls: 4,
    lastTsMs: Date.now(),
    looping: false,
    steerQueued: null,
    recent: [call()],
    ...over,
  };
}

function model(sessions, over) {
  return { repo: "/Users/me/reins", sessions, broadcast: null, threshold: 3, ...over };
}

function ui(over) {
  return { selectedId: null, nowMs: Date.now(), intervalSec: 2, message: "", width: 100, ...over };
}

test("renderFrame: shows the repo basename and short session id", () => {
  const out = renderFrame(model([sess()]), ui(), true);
  assert.match(out, /reins · watch/);
  assert.match(out, /reins\b/); // basename, not the full path
  assert.match(out, /3b9f2a1c/); // 8-char short id
  assert.ok(!out.includes("444455556666")); // full uuid is not shown
});

test("renderFrame: active vs idle vs looping vs ended status", () => {
  const now = Date.now();
  const active = renderFrame(model([sess({ lastTsMs: now })]), ui({ nowMs: now }), true);
  assert.match(active, /active/);

  const idle = renderFrame(model([sess({ lastTsMs: now - 120_000 })]), ui({ nowMs: now }), true);
  assert.match(idle, /idle 2m/);

  const looping = renderFrame(model([sess({ looping: true })]), ui(), true);
  assert.match(looping, /looping/);

  // "completed" only shows once the session has gone quiet (no recent activity).
  const ended = renderFrame(
    model([sess({ ended: true, outcome: "completed", lastTsMs: now - 120_000 })]),
    ui({ nowMs: now }),
    true,
  );
  assert.match(ended, /completed/);
});

test("renderFrame: ended-but-recently-active reads as active (Stop fires per turn)", () => {
  // Claude Code fires Stop at every turn boundary, so an interactive session is
  // flagged ended between turns. Recent tool activity must still read as active.
  const now = Date.now();
  const out = renderFrame(
    model([sess({ ended: true, outcome: "completed", lastTsMs: now - 2_000 })]),
    ui({ nowMs: now }),
    true,
  );
  assert.match(out, /active/);
  assert.ok(!out.includes("completed"), "a live between-turns session is not 'completed'");
});

test("renderFrame: selection caret marks the selected session only", () => {
  const a = sess({ id: "aaaaaaaa-0000-0000-0000-000000000000" });
  const b = sess({ id: "bbbbbbbb-0000-0000-0000-000000000000" });
  const out = renderFrame(model([a, b]), ui({ selectedId: b.id }), true);
  const lines = out.split("\n").filter((l) => /aaaaaaaa|bbbbbbbb/.test(l));
  const aLine = lines.find((l) => l.includes("aaaaaaaa"));
  const bLine = lines.find((l) => l.includes("bbbbbbbb"));
  assert.ok(bLine.includes("›"), "selected row has the caret");
  assert.ok(!aLine.includes("›"), "unselected row has no caret");
});

test("renderFrame: surfaces queued targeted and broadcast steering", () => {
  const out = renderFrame(
    model([sess({ steerQueued: "stay on payments" })], { broadcast: "keep it minimal" }),
    ui(),
    true,
  );
  assert.match(out, /steer queued/); // per-session flag
  assert.match(out, /broadcast steer queued/);
  assert.match(out, /keep it minimal/);
});

test("renderFrame: denied call in the trajectory renders the block glyph", () => {
  const out = renderFrame(
    model([sess({ recent: [call({ denied: true, summary: "rm -rf build" })] })]),
    ui(),
    true,
  );
  assert.match(out, /⛔/);
  assert.match(out, /rm -rf build/);
});

test("renderFrame: shows a multi-call trajectory tail per session", () => {
  const out = renderFrame(
    model([
      sess({
        recent: [
          call({ tool: "Read", summary: "src/auth/index.ts" }),
          call({ tool: "Edit", summary: "src/auth/refresh.ts" }),
          call({ tool: "Bash", summary: "npm test" }),
        ],
      }),
    ]),
    ui(),
    true,
  );
  assert.match(out, /src\/auth\/index\.ts/);
  assert.match(out, /src\/auth\/refresh\.ts/);
  assert.match(out, /npm test/);
});

test("renderFrame: separates distinct sessions with a rule", () => {
  const a = sess({ id: "aaaaaaaa-0000-0000-0000-000000000000" });
  const b = sess({ id: "bbbbbbbb-0000-0000-0000-000000000000" });
  const one = renderFrame(model([a]), ui(), true);
  const two = renderFrame(model([a, b]), ui(), true);
  assert.ok(!one.includes("─"), "a single session needs no separator");
  assert.ok(two.includes("─"), "two sessions are divided by a rule");
});

test("renderFrame: keybinding footer only in interactive mode", () => {
  const on = renderFrame(model([sess()]), ui(), true);
  assert.match(on, /steer one/);
  const off = renderFrame(model([sess()]), ui(), false);
  assert.ok(!off.includes("steer one"));
});

test("renderFrame: empty fleet shows a friendly hint", () => {
  const out = renderFrame(model([]), ui(), true);
  assert.match(out, /No sessions yet/);
});
