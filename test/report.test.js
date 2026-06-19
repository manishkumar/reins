// Run with: npm run build && npm test
const { test } = require("node:test");
const assert = require("node:assert");

const { renderReportHtml } = require("../dist/commands/report.js");

function call(over) {
  return { tool: "Bash", summary: "npm test", denied: false, failed: false, looped: false, ...over };
}

function data(over) {
  return {
    repo: "/Users/me/reins",
    generatedIso: "2026-06-19T09:00:00.000Z",
    threshold: 3,
    totals: { sessions: 1, calls: 2, blocked: 0, failed: 0, loops: 0 },
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
    data({ totals: { sessions: 0, calls: 0, blocked: 0, failed: 0, loops: 0 }, sessions: [] }),
  );
  assert.match(html, /No sessions recorded yet/);
});
