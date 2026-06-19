"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.cmdReport = cmdReport;
exports.renderReportHtml = renderReportHtml;
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const db_1 = require("../db");
const store_1 = require("../store");
const config_1 = require("../config");
const paths_1 = require("../paths");
const format_1 = require("./format");
function cmdReport(args) {
    const db = (0, db_1.openDbReadOnly)();
    if (!db) {
        console.log(format_1.c.dim((0, store_1.capabilityNote)() || "Nothing to report yet — no .reins/runs.db. Run an agent first."));
        return 0;
    }
    const repo = (0, paths_1.resolveProjectDir)();
    const threshold = (0, config_1.loadConfig)().loopThreshold;
    const data = collect(db, repo, threshold);
    const out = outPath(args, repo);
    fs.writeFileSync(out, renderReportHtml(data));
    console.log(format_1.c.green("✓ wrote ") +
        out +
        format_1.c.dim(`  (${data.totals.sessions} sessions · ${data.totals.calls} calls)`));
    if (args.includes("--open"))
        tryOpen(out);
    else
        console.log(format_1.c.dim("  open it in a browser, or re-run with --open"));
    return 0;
}
function collect(db, repo, threshold) {
    const sessionRows = db
        .prepare(`SELECT s.id, s.started, s.ended, s.final_outcome,
              COUNT(t.seq) AS calls, MAX(t.ts) AS last_ts
         FROM sessions s
         LEFT JOIN tool_calls t ON t.session_id = s.id
        GROUP BY s.id
        ORDER BY COALESCE(MAX(t.ts), s.started) DESC`)
        .all();
    const sessions = [];
    const totals = { sessions: 0, calls: 0, blocked: 0, failed: 0, loops: 0 };
    for (const s of sessionRows) {
        const callRows = db
            .prepare(`SELECT tool, input_summary, input_hash, ok FROM tool_calls WHERE session_id = ? ORDER BY seq ASC`)
            .all(s.id);
        const counts = new Map();
        for (const cr of callRows)
            counts.set(cr.input_hash, (counts.get(cr.input_hash) ?? 0) + 1);
        const loopHashes = new Set([...counts].filter(([, n]) => n >= threshold).map(([h]) => h));
        let blocked = 0;
        let failed = 0;
        const trajectory = callRows.map((cr) => {
            const denied = cr.input_summary.startsWith("DENIED: ");
            if (denied)
                blocked++;
            else if (cr.ok === 0)
                failed++;
            return {
                tool: cr.tool,
                summary: denied ? cr.input_summary.slice(8) : cr.input_summary,
                denied,
                failed: !denied && cr.ok === 0,
                looped: loopHashes.has(cr.input_hash),
            };
        });
        const durationMs = s.started && (s.ended || s.last_ts)
            ? Math.max(0, Date.parse((s.ended || s.last_ts)) - Date.parse(s.started))
            : null;
        sessions.push({
            id: s.id,
            started: s.started,
            ended: s.ended,
            outcome: s.final_outcome,
            calls: s.calls,
            blocked,
            loops: loopHashes.size,
            durationMs: Number.isFinite(durationMs) ? durationMs : null,
            trajectory,
        });
        totals.sessions++;
        totals.calls += s.calls;
        totals.blocked += blocked;
        totals.failed += failed;
        totals.loops += loopHashes.size;
    }
    return { repo, generatedIso: new Date().toISOString(), threshold, totals, sessions };
}
/** Pure: structured report data → a single self-contained HTML document. */
function renderReportHtml(d) {
    const repoName = path.basename(d.repo) || d.repo;
    const cards = [
        card("sessions", d.totals.sessions),
        card("tool calls", d.totals.calls),
        card("blocked", d.totals.blocked, d.totals.blocked > 0 ? "bad" : ""),
        card("failed", d.totals.failed, d.totals.failed > 0 ? "warn" : ""),
        card("loops", d.totals.loops, d.totals.loops > 0 ? "warn" : ""),
    ].join("");
    const sessions = d.sessions.length
        ? d.sessions.map(sessionSection).join("\n")
        : `<p class="empty">No sessions recorded yet.</p>`;
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>reins report · ${esc(repoName)}</title>
<style>
:root { color-scheme: dark; }
* { box-sizing: border-box; }
body { margin: 0; background: #0e1116; color: #d7dde5;
  font: 14px/1.55 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
.wrap { max-width: 980px; margin: 0 auto; padding: 32px 20px 64px; }
h1 { font-size: 20px; margin: 0 0 2px; }
h1 .repo { color: #58a6ff; }
.sub { color: #7d8590; margin: 0 0 24px; font-size: 12.5px; }
.cards { display: flex; flex-wrap: wrap; gap: 12px; margin-bottom: 28px; }
.card { background: #161b22; border: 1px solid #232b35; border-radius: 10px;
  padding: 12px 16px; min-width: 110px; }
.card .n { font-size: 24px; font-weight: 700; }
.card .l { color: #7d8590; font-size: 11px; text-transform: uppercase; letter-spacing: .06em; }
.card.bad .n { color: #ff7b72; } .card.warn .n { color: #e3b341; }
details.session { background: #161b22; border: 1px solid #232b35; border-radius: 10px;
  margin-bottom: 12px; overflow: hidden; }
details.session > summary { cursor: pointer; padding: 12px 16px; list-style: none;
  display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
details.session > summary::-webkit-details-marker { display: none; }
.sid { color: #58a6ff; font-weight: 700; }
.badge { font-size: 11px; padding: 2px 8px; border-radius: 20px; border: 1px solid #232b35; color: #7d8590; }
.badge.completed { color: #3fb950; border-color: #1f3d28; }
.badge.running { color: #e3b341; border-color: #3d3417; }
.meta { color: #7d8590; font-size: 12px; margin-left: auto; }
.traj { border-top: 1px solid #232b35; margin: 0; padding: 6px 0; }
.row { display: grid; grid-template-columns: 22px 84px 1fr; gap: 8px; align-items: baseline;
  padding: 3px 16px; }
.row:hover { background: #1b2230; }
.row .tool { color: #7d8590; }
.row .sum { white-space: pre-wrap; word-break: break-word; }
.g { text-align: center; }
.g.ok { color: #3fb950; } .g.deny { color: #ff7b72; } .g.fail { color: #e3b341; }
.row.deny .sum { color: #ff7b72; } .row.fail .sum { color: #e3b341; }
.loop { color: #e3b341; }
.empty { color: #7d8590; }
footer { margin-top: 28px; color: #586069; font-size: 11.5px; }
</style>
</head>
<body>
<div class="wrap">
<h1>reins report · <span class="repo">${esc(repoName)}</span></h1>
<p class="sub">${esc(d.repo)} · generated ${esc(d.generatedIso)} · loop threshold ${d.threshold}× · 100% local, no data left this machine</p>
<div class="cards">${cards}</div>
${sessions}
<footer>Generated by <strong>reins report</strong> from .reins/runs.db — a self-contained file you own. Re-run to refresh.</footer>
</div>
</body>
</html>`;
}
function sessionSection(s) {
    const status = s.ended ? s.outcome || "ended" : "running";
    const badgeClass = s.ended ? "completed" : "running";
    const bits = [`${s.calls} calls`];
    if (s.durationMs != null)
        bits.push(humanDuration(s.durationMs));
    if (s.blocked)
        bits.push(`${s.blocked} blocked`);
    if (s.loops)
        bits.push(`${s.loops} loops`);
    const when = s.started ? esc(s.started.replace("T", " ").replace(/\..*/, "")) : "?";
    const rows = s.trajectory.length
        ? s.trajectory.map(trajRow).join("")
        : `<div class="row"><span></span><span></span><span class="sum empty">(no tool calls)</span></div>`;
    return `<details class="session" open>
<summary>
  <span class="sid">${esc(shortId(s.id))}</span>
  <span class="badge ${badgeClass}">${esc(status)}</span>
  <span class="meta">${esc(when)} · ${bits.map(esc).join(" · ")}</span>
</summary>
<div class="traj">${rows}</div>
</details>`;
}
function trajRow(call) {
    const kind = call.denied ? "deny" : call.failed ? "fail" : "ok";
    const glyph = call.denied ? "⛔" : call.failed ? "✗" : "•";
    const loop = call.looped ? ` <span class="loop">⟳</span>` : "";
    return `<div class="row ${kind}"><span class="g ${kind}">${glyph}</span><span class="tool">${esc(call.tool)}</span><span class="sum">${esc(call.summary)}${loop}</span></div>`;
}
function card(label, n, cls = "") {
    return `<div class="card ${cls}"><div class="n">${n}</div><div class="l">${esc(label)}</div></div>`;
}
function esc(s) {
    return s
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}
function shortId(id) {
    return id.length > 8 ? id.slice(0, 8) : id;
}
function humanDuration(ms) {
    const s = Math.round(ms / 1000);
    if (s < 60)
        return `${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60)
        return `${m}m ${s % 60}s`;
    const h = Math.floor(m / 60);
    return `${h}h ${m % 60}m`;
}
function outPath(args, repo) {
    const i = args.findIndex((a) => a === "-o" || a === "--out");
    if (i >= 0 && args[i + 1])
        return path.resolve(args[i + 1]);
    return path.join((0, paths_1.reinsDir)(repo), "report.html");
}
function tryOpen(file) {
    const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
    try {
        const { spawn } = require("node:child_process");
        spawn(cmd, [file], { stdio: "ignore", detached: true, shell: process.platform === "win32" }).unref();
    }
    catch {
        /* opening is best-effort; the path was already printed */
    }
}
