// Render a synthetic `reins watch` frame for the README (no real session data).
//
//   npm run build
//   node assets/watch-frame.cjs 0 132 30 > /tmp/w.txt && node assets/ansi2svg.mjs /tmp/w.txt assets/watch.svg "reins watch"
//   node assets/watch-frame.cjs 0 132 30 '{"kind":"approve","holdId":"9d3c07e2","scroll":0}' > /tmp/a.txt && node assets/ansi2svg.mjs /tmp/a.txt assets/watch-approve.svg "reins watch"
//
// Arguments: cursor row, width, height, optional modal JSON.
const D = require("node:path").join(__dirname, "..", "dist");
const { renderScreen } = require(D + "/tui/render.js");
const { Style } = require(D + "/tui/term.js");
const NOW = Date.parse("2026-09-30T14:32:08");
const t = (s) => NOW - s * 1000;
const call = (tool, summary, ago, kind = "ok", ruleId = null, streak = 1) => ({ tool, summary, kind, ruleId, tsMs: t(ago), streak });
const spark = (pattern) => pattern.split("").map((c) => (c === " " ? 0 : Number(c)));
const agents = [
  { id: "7c1e9a2b-aaaa", name: "auth-refactor", ended: false, outcome: null, calls: 84, startedMs: t(2400), lastTsMs: t(3), streak: 1, steerQueued: null,
    spark: spark("  12 23 34 4 5 36 45 3 42"), holds: 0,
    trajectory: [call("Read","src/auth/session.ts",190), call("Grep","refreshToken",170), call("Edit","src/auth/session.ts",150), call("Edit","src/auth/refresh.ts",120), call("Bash","npm test -- auth",95,"failed"), call("Read","test/auth/refresh.test.ts",80), call("Edit","src/auth/refresh.ts",60), call("Bash","npm test -- auth",40), call("Bash","git diff --stat",20), call("Edit","CHANGELOG.md",3)] },
  { id: "4f02d6c1-bbbb", name: "release-bot", ended: false, outcome: null, calls: 31, startedMs: t(900), lastTsMs: t(64), streak: 1, steerQueued: null,
    spark: spark("     1 2 3 21         "), holds: 1,
    trajectory: [call("Bash","npm version minor",120), call("Bash","npm run build",100), call("Bash","npm publish --access public",64,"held","publish-hold")] },
  { id: "b81d44e0-cccc", name: "flaky-e2e", ended: false, outcome: null, calls: 57, startedMs: t(1300), lastTsMs: t(9), streak: 4, steerQueued: "stop retrying; read playwright.config.ts timeouts first",
    spark: spark("   1 1 1 2 2 2 3 3 3 4 4"), holds: 0,
    trajectory: [call("Bash","npx playwright test checkout.spec.ts",70,"failed",null,1), call("Bash","npx playwright test checkout.spec.ts",45,"failed",null,2), call("Bash","npx playwright test checkout.spec.ts",27,"failed",null,3), call("Bash","npx playwright test checkout.spec.ts",9,"failed",null,4)] },
  { id: "e5a90c77-dddd", name: "docs-sweep", ended: true, outcome: "completed", calls: 22, startedMs: t(7200), lastTsMs: t(3100), streak: 1, steerQueued: null,
    spark: new Array(24).fill(0), holds: 0, trajectory: [call("Write","docs/api/tokens.md",3100)] },
];
const holds = [{
  action: { id: "9d3c07e2", session_id: "4f02d6c1-bbbb", tool: "Bash", input: {}, input_hash: "x", transport: "deny", rule_id: "publish-hold",
    reason: "Publishing to npm waits for a human.", ts: new Date(t(64)).toISOString(), cwd: "/work/app" },
  sessionName: "release-bot", input: "npm publish --access public", where: "", superseded: false,
  match: { start: 0, end: 11, line: 1, lines: 1 }, lastActiveMs: t(64) }];
const events = [{ kind: "bypass", sessionId: "b81d44e0-cccc", ts: new Date(t(1500)).toISOString(), tool: "Bash", summary: "rm -r test-results", ruleId: "rm-rf", detail: "Denied 11s earlier; a 91%-identical call executed." }];
// What each session is about, its claim check verdict and its footprint.
const { footprint } = require(D + "/footprint.js");
const claim = (verdict, text, command) => ({ verdict, text, command, edited: 2, editedSince: 0, shellWritesSince: 0 });
const about = {
  "auth-refactor": { label: "Move token refresh into the session module", branch: "refactor/auth-session", asked: "pull the refresh logic out of the middleware and keep the tests green",
    claim: claim("stale", "1 file edited after the last test run", "npm test -- auth") },
  "release-bot": { label: "Publish the 0.5 release", branch: "release/0.5.0", asked: "cut the release", claim: claim("verified", "the build passed; no test run", "npm run build") },
  "flaky-e2e": { label: "Fix the flaky checkout test", branch: "fix/checkout-e2e", asked: "checkout.spec.ts fails one run in five, find out why",
    claim: claim("failed", "the last test run failed", "npx playwright test checkout.spec.ts") },
  "docs-sweep": { label: "docs-sweep", branch: null, asked: null, claim: claim("none", "", null) },
};
for (const a of agents) {
  Object.assign(a, about[a.name]);
  a.footprint = footprint(a.trajectory.map((c) => ({ tool: c.tool, summary: c.summary, ok: c.kind === "failed" ? 0 : 1 })), "/work/app");
}
// Listed as buildWatchModel orders them: looping, then holding, then newest first.
agents.sort((a, b) => (a.streak >= 3 ? 0 : a.holds ? 1 : 2) - (b.streak >= 3 ? 0 : b.holds ? 1 : 2));
holds[0].sessionLabel = about["release-bot"].label;
holds[0].asked = about["release-bot"].asked;
const model = { repo: "/work/app", nowMs: NOW, threshold: 3, captured: true, holds, events, olderEvents: 0, agents, broadcast: null };
const [,, cursor, w, h, modal] = process.argv;
const ui = { width: +w || 132, height: +h || 30, cursor: +cursor || 0, zoom: false, detailScroll: 0, modal: modal ? JSON.parse(modal) : null, toast: null, flashUntil: 0, intervalSec: 2 };
process.stdout.write(renderScreen(model, ui, new Style("truecolor")).map(l => l.replace(/\s+$/,"")).join("\n") + "\n");
