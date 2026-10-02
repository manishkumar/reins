// Run with: npm run build && npm test
const { test } = require("node:test");
const assert = require("node:assert");

const { renderReportHtml } = require("../dist/commands/report.js");

function call(over) {
  return {
    tool: "Bash",
    summary: "npm test",
    denied: false,
    asked: false,
    failed: false,
    looped: false,
    ruleId: null,
    ...over,
  };
}

function data(over) {
  return {
    repo: "/Users/me/reins",
    generatedIso: "2026-06-19T09:00:00.000Z",
    threshold: 3,
    totals: { sessions: 1, calls: 2, blocked: 0, failed: 0, loops: 0, tokens: null, cost: null },
    tools: [{ tool: "Bash", calls: 2, denied: 0, failed: 0 }],
    guardFires: [],
    sessions: [
      {
        id: "3b9f2a1c-1111-2222-3333-444455556666",
        started: "2026-06-19T08:00:00.000Z",
        ended: "2026-06-19T08:05:00.000Z",
        outcome: "completed",
        calls: 2,
        blocked: 0,
        loops: 0,
        durationMs: 5 * 60 * 1000,
        tokens: null,
        cost: null,
        trajectory: [call({ tool: "Read", summary: "src/auth.ts" }), call()],
      },
    ],
    ...over,
  };
}

test("renderReportHtml: self-contained doc with repo, totals, and short id", () => {
  const html = renderReportHtml(data());
  assert.match(html, /^<!doctype html>/);
  assert.match(html, /<style>/); // inline CSS, no external assets
  assert.ok(!html.includes("http://") && !html.includes("https://"), "no network references");
  assert.match(html, /reins report/);
  assert.match(html, /3b9f2a1c/); // short id
  assert.ok(!html.includes("444455556666"), "full uuid not shown");
  assert.match(html, /src\/auth\.ts/);
});

test("renderReportHtml: escapes HTML in tool summaries (XSS-safe)", () => {
  const html = renderReportHtml(
    data({
      sessions: [
        {
          id: "evil0000-0000-0000-0000-000000000000",
          started: null,
          ended: null,
          outcome: null,
          calls: 1,
          blocked: 0,
          loops: 0,
          durationMs: null,
          trajectory: [call({ summary: `<script>alert('x')</script> && echo "hi"` })],
        },
      ],
    }),
  );
  assert.ok(!html.includes("<script>alert"), "raw script tag must not appear");
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /&quot;hi&quot;/);
});

test("renderReportHtml: blocked/looped calls get their markers", () => {
  const html = renderReportHtml(
    data({
      totals: { sessions: 1, calls: 2, blocked: 1, failed: 0, loops: 1 },
      sessions: [
        {
          id: "aaaaaaaa-0000-0000-0000-000000000000",
          started: "2026-06-19T08:00:00.000Z",
          ended: null,
          outcome: null,
          calls: 2,
          blocked: 1,
          loops: 1,
          durationMs: null,
          trajectory: [
            call({ denied: true, summary: "rm -rf build" }),
            call({ looped: true, summary: "npm run build" }),
          ],
        },
      ],
    }),
  );
  assert.match(html, /⛔/);
  assert.match(html, /class="loop"/);
  assert.match(html, /badge running/); // not-ended session badge
});

test("renderReportHtml: empty project renders without throwing", () => {
  const html = renderReportHtml(
    data({
      totals: { sessions: 0, calls: 0, blocked: 0, failed: 0, loops: 0, tokens: null, cost: null },
      tools: [],
      guardFires: [],
      sessions: [],
    }),
  );
  assert.match(html, /No sessions recorded yet/);
  assert.ok(!html.includes("By tool"), "empty tool breakdown is omitted");
  assert.ok(!html.includes("Guard fires"), "empty guard heatmap is omitted");
});

test("renderReportHtml: per-tool breakdown renders bars sized to the busiest tool", () => {
  const html = renderReportHtml(
    data({
      tools: [
        { tool: "Bash", calls: 10, denied: 1, failed: 2 },
        { tool: "Edit", calls: 5, denied: 0, failed: 0 },
      ],
    }),
  );
  assert.match(html, /By tool/);
  assert.match(html, /width:100%/); // Bash, the max
  assert.match(html, /width:50%/); // Edit, half of it
  assert.match(html, /1 blocked/);
  assert.match(html, /2 failed/);
});

test("renderReportHtml: guard-fire heatmap shows denied and asked counts per rule", () => {
  const html = renderReportHtml(
    data({
      guardFires: [
        { ruleId: "rm-rf", denied: 4, asked: 0 },
        { ruleId: "git-push", denied: 0, asked: 2 },
      ],
    }),
  );
  assert.match(html, /Guard fires/);
  assert.match(html, /rm-rf/);
  assert.match(html, /4 denied/);
  assert.match(html, /git-push/);
  assert.match(html, /2 asked/);
});

test("renderReportHtml: token/cost rollups appear when captured, hidden when null", () => {
  const withCost = renderReportHtml(
    data({
      totals: { sessions: 1, calls: 2, blocked: 0, failed: 0, loops: 0, tokens: 128540, cost: 1.234 },
      sessions: [
        {
          ...data().sessions[0],
          tokens: 128540,
          cost: 1.234,
        },
      ],
    }),
  );
  assert.match(withCost, /128,540/); // totals card
  assert.match(withCost, /\$1\.23/);
  assert.match(withCost, /128,540 tok/); // session meta line

  const withoutCost = renderReportHtml(data());
  assert.ok(!withoutCost.includes("est. cost"), "cost card hidden when never captured");
  assert.ok(!withoutCost.includes("tokens</div>"), "tokens card hidden when never captured");
});

test("renderReportHtml: asked calls get the escalation glyph and guard rule chip", () => {
  const html = renderReportHtml(
    data({
      sessions: [
        {
          ...data().sessions[0],
          trajectory: [call({ asked: true, summary: "git push", ruleId: "git-push" })],
        },
      ],
    }),
  );
  assert.match(html, /✋/);
  assert.match(html, /guard:git-push/);
  assert.match(html, /class="row ask"/);
});

// --- "Needs you": what the human has to act on leads the page ---------------

const os = require("node:os");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const CLI = path.join(__dirname, "..", "dist", "cli.js");

function hold(over) {
  return {
    id: "e8e88a97",
    sessionId: "2808668f-0000-0000-0000-000000000000",
    tool: "Bash",
    input: "git push origin main",
    ruleId: "push-hold",
    reason: "Pushing waits for sign-off.",
    ts: "2026-06-16T09:00:00.000Z",
    ...over,
  };
}

test("renderReportHtml: parked holds lead the page with their approve/deny commands", () => {
  const html = renderReportHtml(data({ attention: { holds: [hold()], events: [], olderEvents: 0 } }));
  assert.match(html, /Needs you · 1/);
  assert.match(html, /reins approve e8e88a97/);
  assert.match(html, /reins deny e8e88a97/);
  assert.match(html, /waiting 3d 0h/);
  assert.ok(html.indexOf("Needs you") < html.indexOf('class="cards"'), "attention precedes the totals");
});

test("renderReportHtml: attention items are escaped like everything else", () => {
  const html = renderReportHtml(
    data({
      attention: {
        holds: [hold({ input: `echo "<img src=x onerror=alert(1)>"` })],
        events: [
          {
            kind: "bypass",
            sessionId: "s1",
            ts: "2026-06-19T08:00:00.000Z",
            tool: "Bash",
            summary: "rm -r <b>build</b>",
            ruleId: "rm-rf",
            detail: "Denied 9s earlier",
          },
        ],
        olderEvents: 0,
      },
    }),
  );
  assert.ok(!html.includes("<img src=x"), "proposed input must not render as HTML");
  assert.ok(!html.includes("<b>build</b>"));
  assert.match(html, /guard worked around/);
});

test("renderReportHtml: breaches are listed before bypasses", () => {
  const ev = (kind, ts) => ({ kind, sessionId: "s1", ts, tool: "Bash", summary: kind, ruleId: "r", detail: "" });
  const html = renderReportHtml(
    data({
      attention: {
        holds: [],
        // collectAttention sorts; the renderer keeps the given order.
        events: [ev("breach", "2026-06-19T07:00:00.000Z"), ev("bypass", "2026-06-19T08:00:00.000Z")],
        olderEvents: 0,
      },
    }),
  );
  assert.ok(html.indexOf("hold breached") < html.indexOf("guard worked around"));
});

test("renderReportHtml: a clean page says so, and counts events past the window", () => {
  const html = renderReportHtml(data({ attention: { holds: [], events: [], olderEvents: 4 } }));
  assert.match(html, /Nothing needs you/);
  assert.match(html, /4 older breach\/bypass events not listed/);
  assert.ok(!html.includes("Needs you ·"));
});

test("renderReportHtml: finished sessions collapse unless latest or flagged", () => {
  const base = data().sessions[0];
  const s = (id) => ({ ...base, id, ended: "2026-06-19T08:05:00.000Z" });
  const html = renderReportHtml(
    data({
      sessions: [s("latest00-x"), s("quiet000-x"), s("flagged0-x"), { ...s("running0-x"), ended: null }],
      attention: { holds: [hold({ sessionId: "flagged0-x" })], events: [], olderEvents: 0 },
    }),
  );
  const openFor = (id) => new RegExp(`<details class="session" open>\\s*<summary>\\s*<span class="sid">${id}`).test(html);
  assert.ok(openFor("latest00"), "most recent session opens");
  assert.ok(!openFor("quiet000"), "a finished, unflagged session collapses");
  assert.ok(openFor("flagged0"), "a session with a parked hold opens");
  assert.ok(openFor("running0"), "a running session opens");
});

test("reins report: renders parked holds without SQLite, owner-only", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reins-report-"));
  try {
    fs.mkdirSync(path.join(dir, ".reins", "pending"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, ".reins", "pending", "abcd1234.json"),
      JSON.stringify({
        id: "abcd1234",
        session_id: "sess-1",
        tool: "Bash",
        input: { command: "npm publish" },
        input_hash: "h1",
        transport: "deny",
        rule_id: "publish-hold",
        reason: "Publishing waits for sign-off.",
        ts: new Date().toISOString(),
      }),
    );
    const out = path.join(dir, "r.html");
    fs.writeFileSync(out, "stale", { mode: 0o644 }); // overwrite must tighten the mode
    const stdout = execFileSync(process.execPath, [CLI, "report", "-o", out], {
      cwd: dir,
      encoding: "utf8",
      env: { ...process.env, CLAUDE_PROJECT_DIR: "", REINS_NO_SQLITE: "1" },
    });
    assert.match(stdout, /1 needs you/);
    const html = fs.readFileSync(out, "utf8");
    assert.match(html, /npm publish/);
    assert.match(html, /reins approve abcd1234/);
    assert.match(html, /Session history needs capture/);
    if (process.platform !== "win32") assert.strictEqual(fs.statSync(out).mode & 0o777, 0o600);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
