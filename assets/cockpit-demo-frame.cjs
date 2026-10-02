// A synthetic overnight scenario (six agents on a payments repo) rendered by the
// real cockpit renderer. No real session data. The three README cockpit images
// come from it.
//
//   npm run build
//   node assets/cockpit-demo-frame.cjs 0 172 32 > /tmp/d.txt && node assets/ansi2svg.mjs /tmp/d.txt assets/cockpit-review-queue.svg "reins watch · payments-api"
//   node assets/cockpit-demo-frame.cjs 4 172 46 > /tmp/d.txt && node assets/ansi2svg.mjs /tmp/d.txt assets/cockpit-agent.svg "reins watch · payments-api"
//   node assets/cockpit-demo-frame.cjs 0 172 32 '{"kind":"approve","holdId":"9d3c07e2","scroll":0}' > /tmp/d.txt && node assets/ansi2svg.mjs /tmp/d.txt assets/cockpit-approve.svg "reins watch · payments-api"
//
// Arguments: cursor row, width, height, optional modal JSON.
const D = require("node:path").join(__dirname, "..", "dist");
const { renderScreen } = require(D + "/tui/render.js");
const { Style } = require(D + "/tui/term.js");
const { whyMatched } = require(D + "/tui/why.js");

const NOW = Date.parse("2026-10-02T07:42:16");
const t = (s) => NOW - s * 1000;
const H = 3600;
const call = (tool, summary, ago, kind = "ok", ruleId = null, streak = 1) => ({ tool, summary, kind, ruleId, tsMs: t(ago), streak });
const spark = (p) => p.padStart(24, " ").split("").map((c) => (c === " " ? 0 : Number(c)));
const claim = (verdict, text, command, o = {}) => ({ verdict, text, command, edited: 0, editedSince: 0, shellWritesSince: 0, ...o });
const ROOT = "/work/payments-api";

const deploy = [
  "set -euo pipefail",
  "cd infra/envs/staging",
  "export TF_VAR_outbox_enabled=true",
  "terraform init -input=false",
  "terraform plan -out=outbox.plan -var-file=staging.tfvars",
  "terraform show -no-color outbox.plan | tee /tmp/outbox.plan.txt",
  "terraform apply -input=false outbox.plan",
  "curl -fsS https://staging.internal.example/healthz",
  "./scripts/smoke.sh ledger-outbox --env staging",
].join("\n");
const backfill = "psql \"$STAGING_DATABASE_URL\" -v ON_ERROR_STOP=1 -f migrations/0147_backfill_idempotency_keys.sql";

const tfRule = { id: "terraform-apply-hold", type: "bash", pattern: "terraform\\s+apply\\b", reason: "x", action: "hold" };
const dbRule = { id: "staging-db-write-hold", type: "bash", pattern: "psql\\b.*-f\\s+migrations/", reason: "x", action: "hold" };

const agents = [
  {
    id: "b81d44e0-3c1f-4a5e-9d2b-7f6e5d4c3b2a", name: "flaky-heron", label: "Bisect the p99 regression in /charge", branch: "perf/charge-p99",
    asked: "p99 on /charge went from 180ms to 410ms last week, bisect it and fix the cause",
    ended: false, outcome: null, calls: 412, startedMs: t(3 * H + 480), lastTsMs: t(11), streak: 5,
    steerQueued: null, spark: spark("1 1 1 1 1 1 1 1 1 1 1 1"), holds: 0,
    claim: claim("failed", "the last test run failed", "npm test -- bench/charge.bench.ts", { edited: 6 }),
    footprint: { files: [], dirs: [], outside: 0, commands: [], shellWrites: 0 },
    trajectory: [5, 4, 3, 2, 1].map((n, i) => call("Bash", "npm test -- bench/charge.bench.ts", n * 58 - 47, "failed", null, i + 1)),
  },
  {
    id: "7c1e9a2b-55d0-4be1-8a36-0c9f1e2d3a4b", name: "steady-ibis", label: "Migrate ledger writes to the outbox pattern", branch: "feat/ledger-outbox",
    asked: "migrate ledger writes to the outbox table, keep the suite green, do not touch prod config",
    ended: false, outcome: null, calls: 1284, startedMs: t(6 * H + 720), lastTsMs: t(4), streak: 1,
    steerQueued: null, spark: spark("23 34 2 45 3 2 46 53 2 34"), holds: 1,
    claim: claim("verified", "tests passed after the last edit; 2 shell commands after it may have changed files", "npm test -- ledger outbox", { edited: 41, shellWritesSince: 2 }),
    footprint: {
      files: [
        { path: "src/ledger/outbox.ts", edits: 38 }, { path: "src/ledger/writer.ts", edits: 27 }, { path: "test/ledger/outbox.test.ts", edits: 22 },
        { path: "src/ledger/relay.ts", edits: 19 }, { path: "migrations/0146_outbox.sql", edits: 9 },
        ...Array.from({ length: 36 }, (_, i) => ({ path: `src/x${i}.ts`, edits: 2 })),
      ],
      dirs: [
        { dir: "src/ledger/", files: 14, edits: 121 }, { dir: "test/ledger/", files: 11, edits: 58 }, { dir: "src/workers/", files: 7, edits: 19 },
        { dir: "migrations/", files: 3, edits: 12 }, { dir: "infra/envs/staging/", files: 2, edits: 4 }, { dir: "docs/", files: 4, edits: 6 },
      ],
      outside: 0, shellWrites: 7,
      commands: [
        { head: "npm test", runs: 96 }, { head: "git diff", runs: 61 }, { head: "npm run typecheck", runs: 44 }, { head: "git commit", runs: 23 },
        { head: "rg", runs: 118 }, { head: "terraform plan", runs: 3 }, { head: "docker compose", runs: 9 }, { head: "psql", runs: 12 }, { head: "jq", runs: 5 },
      ].sort((a, b) => b.runs - a.runs),
    },
    trajectory: [
      call("Edit", ROOT + "/src/ledger/relay.ts", 2 * H + 1500),
      call("Bash", "npm test -- ledger outbox", 2 * H + 1380, "failed"),
      call("Edit", ROOT + "/src/ledger/relay.ts", 2 * H + 1290),
      call("Bash", "npm test -- ledger outbox", 2 * H + 1170),
      call("Bash", "git commit -m 'relay: drain the outbox in commit order'", 2 * H + 1100),
      call("Bash", "cd infra/envs/staging && terraform plan -var-file=staging.tfvars", 2 * H + 960),
      call("Bash", "set -euo pipefail cd infra/envs/staging export TF_VAR_outbox_enabled=true terraform init …", 2 * H + 840, "held", "terraform-apply-hold"),
      call("Read", ROOT + "/docs/runbooks/outbox-replay.md", 2 * H + 800),
      call("Edit", ROOT + "/src/workers/outbox-drain.ts", 2 * H + 420),
      call("Bash", "rm -rf node_modules/.cache dist", 2 * H + 300, "denied", "rm-rf"),
      call("Bash", "npm run clean", 2 * H + 290),
      call("Edit", ROOT + "/src/ledger/writer.ts", 1 * H + 900),
      call("Bash", "npm run typecheck", 1 * H + 700),
      call("Edit", ROOT + "/test/ledger/outbox.test.ts", 1900),
      call("Bash", "npm test -- ledger outbox", 1500, "failed"),
      call("Edit", ROOT + "/src/ledger/outbox.ts", 900),
      call("Bash", "npm test -- ledger outbox", 240),
      call("Bash", "git diff --stat main...HEAD > /tmp/outbox-diff.txt", 90),
      call("Bash", "sed -i '' 's/OUTBOX_BATCH=50/OUTBOX_BATCH=200/' .env.test", 30),
      call("Edit", ROOT + "/docs/runbooks/outbox-replay.md", 4),
    ],
  },
  {
    id: "4f02d6c1-9a8b-4c7d-b6e5-1a2b3c4d5e6f", name: "quiet-marten", label: "Backfill idempotency keys on charges", branch: "chore/idempotency-backfill",
    asked: "write and run the backfill for charges.idempotency_key on staging, in batches",
    ended: true, outcome: "deferred", calls: 203, startedMs: t(4 * H + 300), lastTsMs: t(47 * 60), streak: 1,
    steerQueued: null, spark: spark(""), holds: 1,
    claim: claim("verified", "tests passed after the last edit", "npm test -- migrations", { edited: 5 }),
    footprint: { files: [], dirs: [], outside: 0, commands: [], shellWrites: 0 },
    trajectory: [call("Bash", backfill, 47 * 60, "held", "staging-db-write-hold")],
  },
  {
    id: "e5a90c77-1b2c-4d3e-8f90-a1b2c3d4e5f6", name: "brisk-otter", label: "Upgrade services to Node 22", branch: "chore/node-22",
    asked: "bump every service to Node 22 and fix what breaks",
    ended: true, outcome: "completed", calls: 356, startedMs: t(5 * H), lastTsMs: t(41 * 60), streak: 1,
    steerQueued: null, spark: spark(""), holds: 0,
    claim: claim("stale", "3 files edited after the last test run", "npm test", { edited: 28, editedSince: 3 }),
    footprint: { files: [], dirs: [], outside: 0, commands: [], shellWrites: 0 },
    trajectory: [call("Edit", ROOT + "/services/webhooks/Dockerfile", 41 * 60)],
  },
  {
    id: "a1c3e5f7-2468-4ace-9bdf-13579bdf2468", name: "amber-wren", label: "Nightly dependency audit", branch: "deps/2026-10-02",
    asked: "apply the non-breaking updates from npm audit and open a PR",
    ended: true, outcome: "completed", calls: 74, startedMs: t(2 * H + 900), lastTsMs: t(2 * H + 200), streak: 1,
    steerQueued: null, spark: spark(""), holds: 0,
    claim: claim("unverified", "2 files edited, no test or build run", null, { edited: 2, editedSince: 2 }),
    footprint: { files: [], dirs: [], outside: 0, commands: [], shellWrites: 0 },
    trajectory: [call("Bash", "gh pr create --fill --draft", 2 * H + 200)],
  },
  {
    id: "c0ffee12-3456-4789-abcd-ef0123456789", name: "calm-raven", label: "Add retry budget to the webhook sender", branch: "feat/webhook-retry-budget",
    asked: "cap webhook retries per endpoint per hour, with tests",
    ended: true, outcome: "completed", calls: 188, startedMs: t(5 * H + 600), lastTsMs: t(3 * H + 100), streak: 1,
    steerQueued: null, spark: spark(""), holds: 0,
    claim: claim("verified", "tests passed after the last edit", "npm test -- webhooks", { edited: 9 }),
    footprint: { files: [], dirs: [], outside: 0, commands: [], shellWrites: 0 },
    trajectory: [call("Bash", "npm test -- webhooks", 3 * H + 100)],
  },
];

const holdOf = (id, agent, rule, reason, input, ago, transport, cwd, where) => ({
  action: { id, session_id: agent.id, tool: "Bash", input: { command: input }, input_hash: id, transport, rule_id: rule.id, reason,
    ts: new Date(t(ago)).toISOString(), cwd, ...(transport === "defer" ? { tool_use_id: "toolu_01" + id } : {}) },
  sessionName: agent.name, sessionLabel: agent.label, asked: agent.asked, input, where, superseded: false,
  match: whyMatched(rule, input), lastActiveMs: agent.lastTsMs,
});
const holds = [
  holdOf("9d3c07e2", agents[1], tfRule, "Applying infrastructure changes waits for a human, in every environment.", deploy, 2 * H + 840, "deny", ROOT, ""),
  holdOf("51ab8e90", agents[2], dbRule, "Writes to a shared database wait for a human.", backfill, 47 * 60, "defer", ROOT, ""),
];
const events = [{
  kind: "bypass", sessionId: agents[1].id, ts: new Date(t(2 * H + 290)).toISOString(), tool: "Bash", summary: "npm run clean", ruleId: "rm-rf",
  detail: "Denied 10s earlier: rm -rf node_modules/.cache dist. A script that does the same ran.",
}];

const model = { repo: ROOT, nowMs: NOW, threshold: 3, captured: true, holds, events, olderEvents: 3, agents, quietAgents: 14, broadcast: null };
const [, , cursor, w, h, modal] = process.argv;
const ui = { width: +w || 172, height: +h || 46, cursor: +cursor || 0, zoom: false, detailScroll: 0, modal: modal ? JSON.parse(modal) : null, toast: null, flashUntil: 0, intervalSec: 2 };
process.stdout.write(renderScreen(model, ui, new Style("truecolor")).map((l) => l.replace(/\s+$/, "")).join("\n") + "\n");
