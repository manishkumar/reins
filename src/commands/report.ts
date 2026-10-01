import * as fs from "node:fs";
import * as path from "node:path";
import { openDbReadOnly } from "../db";
import { collectAttention, type Attention } from "../attention";
import { capabilityNote } from "../store";
import { loadConfig } from "../config";
import { resolveProjectDir, reinsDir } from "../paths";
import { aboutOf, faceReader, headOf, shortId, type SessionFace } from "../sessionFace";
import { checkClaim, type Claim } from "../claim";
import { c } from "./format";

/**
 * `reins report` — turn the captured trajectory into a browsable, self-contained
 * HTML page. The live cockpit (`reins watch`) is for steering agents in flight;
 * this is the "what happened across every run" view — richer than a TUI, and
 * still 100% local: one file, inline CSS, zero network, nothing leaves the disk.
 *
 * `renderReportHtml` is a pure function of plain data so it can be unit-tested
 * (and so the HTML generation has no DB/FS entanglement).
 */

export interface ReportCall {
  tool: string;
  summary: string;
  denied: boolean;
  asked: boolean;
  failed: boolean;
  looped: boolean;
  /** Guard rule id when this call was denied/asked (from the [guard:<id>] provenance). */
  ruleId: string | null;
}

export interface ReportSession {
  id: string;
  /** How the session is named everywhere else; absent in data built without it. */
  face?: SessionFace;
  /** What the session's own calls say about its work being done. */
  claim?: Claim;
  started: string | null;
  ended: string | null;
  outcome: string | null;
  calls: number;
  blocked: number;
  loops: number;
  durationMs: number | null;
  tokens: number | null;
  cost: number | null;
  trajectory: ReportCall[];
}

/** Calls per tool across all sessions — the per-tool breakdown. */
export interface ToolStat {
  tool: string;
  calls: number;
  denied: number;
  failed: number;
}

/** How often each guard rule fired — the guard-fire heatmap. */
export interface GuardFire {
  ruleId: string;
  denied: number;
  asked: number;
}

export interface ReportData {
  repo: string;
  /** False when runs.db could not be opened: the page renders from files only. */
  captured?: boolean;
  attention?: Attention;
  generatedIso: string;
  threshold: number;
  totals: {
    sessions: number;
    calls: number;
    blocked: number;
    failed: number;
    loops: number;
    /** Sums over sessions that have the data; null when no session does (best-effort columns). */
    tokens: number | null;
    cost: number | null;
  };
  tools: ToolStat[];
  guardFires: GuardFire[];
  sessions: ReportSession[];
}

/** DENIED/ASKED rows carry the rule that stopped them: "… [guard:<id>]". */
const GUARD_TAG = /\s\[guard:([^\]]+)\]$/;

export function cmdReport(args: string[]): number {
  const repo = resolveProjectDir();
  const threshold = loadConfig().loopThreshold;
  const db = openDbReadOnly();
  const attention = collectAttention(repo, db);
  if (!db && !attention.holds.length && !attention.events.length) {
    console.log(c.dim(capabilityNote() || "Nothing to report yet — no .reins/runs.db. Run an agent first."));
    return 0;
  }
  const data: ReportData = db
    ? { ...collect(db, repo, threshold), captured: true, attention }
    : { ...emptyData(repo, threshold), captured: false, attention };

  const out = outPath(args, repo);
  writePrivate(out, renderReportHtml(data));
  const needs = attention.holds.length + attention.events.length;
  console.log(
    c.green("✓ wrote ") +
      out +
      c.dim(`  (${data.totals.sessions} sessions · ${data.totals.calls} calls)`) +
      (needs ? c.yellow(`  ${needs} need${needs === 1 ? "s" : ""} you`) : ""),
  );
  if (!db) console.log(c.dim("  " + (capabilityNote() || "no runs.db yet") + " — holds and guard reports only"));

  if (args.includes("--open")) tryOpen(out);
  else console.log(c.dim("  open it in a browser, or re-run with --open"));
  return 0;
}

/**
 * The report embeds proposed commands and file paths from agent runs, which can
 * carry secrets. Owner-only, like .reins/ itself — and chmod on overwrite,
 * because writeFileSync's mode only applies when it creates the file.
 */
function writePrivate(file: string, content: string): void {
  fs.writeFileSync(file, content, { mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    /* best-effort on filesystems without POSIX modes */
  }
}

function emptyData(repo: string, threshold: number): ReportData {
  return {
    repo,
    generatedIso: new Date().toISOString(),
    threshold,
    totals: { sessions: 0, calls: 0, blocked: 0, failed: 0, loops: 0, tokens: null, cost: null },
    tools: [],
    guardFires: [],
    sessions: [],
  };
}

function collect(
  db: NonNullable<ReturnType<typeof openDbReadOnly>>,
  repo: string,
  threshold: number,
): ReportData {
  const sessionRows = db
    .prepare(
      `SELECT s.id, s.started, s.ended, s.final_outcome, s.total_tokens, s.total_cost,
              COUNT(t.seq) AS calls, MAX(t.ts) AS last_ts
         FROM sessions s
         LEFT JOIN tool_calls t ON t.session_id = s.id
        GROUP BY s.id
        ORDER BY COALESCE(MAX(t.ts), s.started) DESC`,
    )
    .all() as Array<{
    id: string;
    started: string | null;
    ended: string | null;
    final_outcome: string | null;
    total_tokens: number | null;
    total_cost: number | null;
    calls: number;
    last_ts: string | null;
  }>;

  const faceOf = faceReader(db);
  const sessions: ReportSession[] = [];
  const totals = {
    sessions: 0,
    calls: 0,
    blocked: 0,
    failed: 0,
    loops: 0,
    tokens: null as number | null,
    cost: null as number | null,
  };
  const toolStats = new Map<string, ToolStat>();
  const guardStats = new Map<string, GuardFire>();

  for (const s of sessionRows) {
    const callRows = db
      .prepare(`SELECT tool, input_summary, input_hash, ok FROM tool_calls WHERE session_id = ? ORDER BY seq ASC`)
      .all(s.id) as Array<{ tool: string; input_summary: string; input_hash: string; ok: number | null }>;

    const counts = new Map<string, number>();
    for (const cr of callRows) counts.set(cr.input_hash, (counts.get(cr.input_hash) ?? 0) + 1);
    const loopHashes = new Set([...counts].filter(([, n]) => n >= threshold).map(([h]) => h));

    let blocked = 0;
    let failed = 0;
    const trajectory: ReportCall[] = callRows.map((cr) => {
      const denied = cr.input_summary.startsWith("DENIED: ");
      const asked = cr.input_summary.startsWith("ASKED: ");
      let summary = denied || asked ? cr.input_summary.replace(/^(DENIED|ASKED): /, "") : cr.input_summary;
      let ruleId: string | null = null;
      if (denied || asked) {
        const m = summary.match(GUARD_TAG);
        if (m) {
          ruleId = m[1];
          summary = summary.slice(0, -m[0].length);
        }
        const g = guardStats.get(ruleId ?? "(unknown)") ?? { ruleId: ruleId ?? "(unknown)", denied: 0, asked: 0 };
        if (denied) g.denied++;
        else g.asked++;
        guardStats.set(g.ruleId, g);
      }
      const failedCall = !denied && !asked && cr.ok === 0;
      if (denied) blocked++;
      else if (failedCall) failed++;

      const t = toolStats.get(cr.tool) ?? { tool: cr.tool, calls: 0, denied: 0, failed: 0 };
      t.calls++;
      if (denied) t.denied++;
      if (failedCall) t.failed++;
      toolStats.set(cr.tool, t);

      return {
        tool: cr.tool,
        summary,
        denied,
        asked,
        failed: failedCall,
        looped: loopHashes.has(cr.input_hash),
        ruleId,
      };
    });

    const durationMs =
      s.started && (s.ended || s.last_ts)
        ? Math.max(0, Date.parse((s.ended || s.last_ts)!) - Date.parse(s.started))
        : null;

    sessions.push({
      id: s.id,
      face: faceOf(s.id),
      claim: checkClaim(callRows.map((cr) => ({ tool: cr.tool, summary: cr.input_summary, ok: cr.ok }))),
      started: s.started,
      ended: s.ended,
      outcome: s.final_outcome,
      calls: s.calls,
      blocked,
      loops: loopHashes.size,
      durationMs: Number.isFinite(durationMs as number) ? durationMs : null,
      tokens: s.total_tokens,
      cost: s.total_cost,
      trajectory,
    });

    totals.sessions++;
    totals.calls += s.calls;
    totals.blocked += blocked;
    totals.failed += failed;
    totals.loops += loopHashes.size;
    if (s.total_tokens != null) totals.tokens = (totals.tokens ?? 0) + s.total_tokens;
    if (s.total_cost != null) totals.cost = (totals.cost ?? 0) + s.total_cost;
  }

  const tools = [...toolStats.values()].sort((a, b) => b.calls - a.calls || a.tool.localeCompare(b.tool));
  const guardFires = [...guardStats.values()].sort(
    (a, b) => b.denied + b.asked - (a.denied + a.asked) || a.ruleId.localeCompare(b.ruleId),
  );

  return { repo, generatedIso: new Date().toISOString(), threshold, totals, tools, guardFires, sessions };
}

/** Pure: structured report data → a single self-contained HTML document. */
export function renderReportHtml(d: ReportData): string {
  const repoName = path.basename(d.repo) || d.repo;
  const cards = [
    card("sessions", String(d.totals.sessions)),
    card("tool calls", String(d.totals.calls)),
    card("blocked", String(d.totals.blocked), d.totals.blocked > 0 ? "bad" : ""),
    card("failed", String(d.totals.failed), d.totals.failed > 0 ? "warn" : ""),
    card("loops", String(d.totals.loops), d.totals.loops > 0 ? "warn" : ""),
    d.totals.tokens != null ? card("tokens", fmtTokens(d.totals.tokens)) : "",
    d.totals.cost != null ? card("est. cost", fmtCost(d.totals.cost)) : "",
  ].join("");

  const flagged = new Set([
    ...(d.attention?.holds ?? []).map((h) => h.sessionId),
    ...(d.attention?.events ?? []).map((e) => e.sessionId),
  ]);
  const sessions = d.sessions.length
    ? d.sessions.map((s, i) => sessionSection(s, i === 0 || flagged.has(s.id))).join("\n")
    : d.captured === false
      ? `<p class="empty">Session history needs capture, which is unavailable here (${esc(capabilityNote() || "no runs.db")}).</p>`
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
section.insight { background: #161b22; border: 1px solid #232b35; border-radius: 10px;
  margin-bottom: 28px; padding: 14px 16px; }
section.insight h2 { font-size: 13px; margin: 0 0 10px; color: #7d8590;
  text-transform: uppercase; letter-spacing: .06em; }
.brow { display: grid; grid-template-columns: 140px 1fr 160px; gap: 10px;
  align-items: center; padding: 3px 0; }
.brow .name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.brow .track { background: #0e1116; border-radius: 4px; height: 12px; overflow: hidden; }
.brow .bar { display: block; height: 100%; background: #2f6feb; border-radius: 4px; min-width: 2px; }
.brow.guard .bar { background: #b62324; }
.brow .cnt { color: #7d8590; font-size: 12px; text-align: right; }
.brow .cnt .deny { color: #ff7b72; } .brow .cnt .ask { color: #e3b341; }
.brow .cnt .fail { color: #e3b341; }
details.session { background: #161b22; border: 1px solid #232b35; border-radius: 10px;
  margin-bottom: 12px; overflow: hidden; }
details.session > summary { cursor: pointer; padding: 12px 16px; list-style: none;
  display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
details.session > summary::-webkit-details-marker { display: none; }
.sid { color: #58a6ff; font-weight: 700; }
.about { color: #7d8590; font-size: 12px; padding: 0 14px 8px; }
.claim { font-size: 12px; padding: 0 14px 8px; color: #7d8590; }
.claim.failed { color: #f85149; }
.claim.stale, .claim.unverified { color: #d29922; }
.claim.verified { color: #3fb950; }
.claim code { color: #7d8590; }
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
.g.ask { color: #e3b341; }
.row.deny .sum { color: #ff7b72; } .row.fail .sum { color: #e3b341; }
.row.ask .sum { color: #e3b341; }
.rule { font-size: 11px; color: #7d8590; border: 1px solid #232b35;
  border-radius: 20px; padding: 1px 7px; margin-left: 6px; white-space: nowrap; }
.loop { color: #e3b341; }
.empty { color: #7d8590; }
section.attn { border: 1px solid #5a1e1e; background: #1a1214; border-radius: 10px;
  margin-bottom: 28px; padding: 14px 16px; }
section.attn.clear { border-color: #1f3d28; background: #111a14; color: #3fb950; padding: 10px 16px; }
section.attn h2 { font-size: 13px; margin: 0 0 12px; color: #ff7b72;
  text-transform: uppercase; letter-spacing: .06em; }
.item { border-top: 1px solid #2d2226; padding: 10px 0; }
.item:first-of-type { border-top: 0; padding-top: 0; }
section.attn .cmds:last-child { margin-top: 8px; }
.item .head { display: flex; gap: 10px; flex-wrap: wrap; align-items: baseline; }
.item .kind { font-weight: 700; }
.item .kind.hold { color: #e3b341; } .item .kind.breach, .item .kind.bypass { color: #ff7b72; }
.item .why { color: #7d8590; font-size: 12.5px; margin: 4px 0; }
.item pre { margin: 6px 0; padding: 8px 10px; background: #0e1116; border-radius: 6px;
  max-height: 9.5em; overflow: auto; white-space: pre-wrap; word-break: break-word; font: inherit; font-size: 12.5px; }
.item .cmds { font-size: 12.5px; color: #7d8590; }
.item code { user-select: all; color: #d7dde5; background: #0e1116; padding: 1px 6px; border-radius: 4px; }
footer { margin-top: 28px; color: #586069; font-size: 11.5px; }
</style>
</head>
<body>
<div class="wrap">
<h1>reins report · <span class="repo">${esc(repoName)}</span></h1>
<p class="sub">${esc(d.repo)} · generated ${esc(d.generatedIso)} · loop threshold ${d.threshold}× · 100% local, no data left this machine</p>
${attentionSection(d)}
<div class="cards">${cards}</div>
${toolBreakdownSection(d.tools ?? [])}
${guardHeatmapSection(d.guardFires ?? [])}
${sessions}
<footer>Generated by <strong>reins report</strong> from .reins/runs.db — a self-contained file you own. Re-run to refresh.</footer>
</div>
</body>
</html>`;
}

/**
 * The top of the page: everything that is waiting on, or was hidden from, the
 * human. Led by what they can act on now (a parked hold), then what already
 * went wrong (a hold that didn't hold, a denial worked around). Empty says so,
 * so a clean page reads as clean rather than as missing.
 */
function attentionSection(d: ReportData): string {
  const a = d.attention;
  if (!a) return "";
  const faces = new Map(d.sessions.map((s) => [s.id, s.face]));
  const who = (id: string): string => {
    const f = faces.get(id);
    return f ? `${headOf(f, id)}${f.label === f.name ? "" : ` (${shortId(id)})`}` : `session ${shortId(id)}`;
  };
  const older = a.olderEvents
    ? `<div class="cmds">${a.olderEvents} older breach/bypass event${a.olderEvents === 1 ? "" : "s"} not listed: <code>reins audit --guards</code></div>`
    : "";
  if (!a.holds.length && !a.events.length) {
    return `<section class="attn clear">✓ Nothing needs you: no parked holds, and no breaches or worked-around guards this week.${older}</section>`;
  }
  const now = Date.parse(d.generatedIso);
  const holds = a.holds.map((h) => {
    const waited = Number.isFinite(now - Date.parse(h.ts)) ? ` · waiting ${humanDuration(Math.max(0, now - Date.parse(h.ts)))}` : "";
    return `<div class="item">
<div class="head"><span class="kind hold">✋ held</span><span class="tool">${esc(h.tool)}</span><span class="rule">${esc(h.ruleId)}</span><span class="meta">${esc(who(h.sessionId))}${esc(waited)}</span></div>
<div class="why">${esc(h.reason)}</div>
<pre>${esc(h.input)}</pre>
<div class="cmds"><code>reins approve ${esc(h.id)}</code> or <code>reins deny ${esc(h.id)}</code></div>
</div>`;
  });
  const events = a.events.map((e) => {
    const label = e.kind === "breach" ? "⚠ hold breached" : "↪ guard worked around";
    const rule = e.ruleId ? `<span class="rule">${esc(e.ruleId)}</span>` : "";
    return `<div class="item">
<div class="head"><span class="kind ${e.kind}">${label}</span><span class="tool">${esc(e.tool)}</span>${rule}<span class="meta">${esc(who(e.sessionId))} · ${esc(e.ts.replace("T", " ").replace(/\..*/, ""))}</span></div>
<div class="why">${esc(e.detail)}</div>
<pre>${esc(e.summary)}</pre>
</div>`;
  });
  const n = a.holds.length + a.events.length;
  return `<section class="attn"><h2>Needs you · ${n}</h2>${holds.join("")}${events.join("")}${older}</section>`;
}

/** Per-tool breakdown: one bar per tool, width relative to the busiest tool. */
function toolBreakdownSection(tools: ToolStat[]): string {
  if (!tools.length) return "";
  const max = Math.max(...tools.map((t) => t.calls));
  const rows = tools
    .map((t) => {
      const pct = Math.max(1, Math.round((t.calls / max) * 100));
      const extras: string[] = [];
      if (t.denied) extras.push(`<span class="deny">${t.denied} blocked</span>`);
      if (t.failed) extras.push(`<span class="fail">${t.failed} failed</span>`);
      const cnt = `${t.calls}${extras.length ? " · " + extras.join(" · ") : ""}`;
      return `<div class="brow"><span class="name">${esc(t.tool)}</span><span class="track"><span class="bar" style="width:${pct}%"></span></span><span class="cnt">${cnt}</span></div>`;
    })
    .join("");
  return `<section class="insight"><h2>By tool</h2>${rows}</section>`;
}

/** Guard-fire heatmap: which rules are actually earning their keep. */
function guardHeatmapSection(fires: GuardFire[]): string {
  if (!fires.length) return "";
  const max = Math.max(...fires.map((f) => f.denied + f.asked));
  const rows = fires
    .map((f) => {
      const total = f.denied + f.asked;
      const pct = Math.max(1, Math.round((total / max) * 100));
      const parts: string[] = [];
      if (f.denied) parts.push(`<span class="deny">⛔ ${f.denied} denied</span>`);
      if (f.asked) parts.push(`<span class="ask">✋ ${f.asked} asked</span>`);
      return `<div class="brow guard"><span class="name">${esc(f.ruleId)}</span><span class="track"><span class="bar" style="width:${pct}%"></span></span><span class="cnt">${parts.join(" · ")}</span></div>`;
    })
    .join("");
  return `<section class="insight"><h2>Guard fires</h2>${rows}</section>`;
}

function sessionSection(s: ReportSession, flagged = true): string {
  const status = s.ended ? s.outcome || "ended" : "running";
  const badgeClass = s.ended ? "completed" : "running";
  const bits: string[] = [`${s.calls} calls`];
  if (s.durationMs != null) bits.push(humanDuration(s.durationMs));
  if (s.tokens != null) bits.push(`${fmtTokens(s.tokens)} tok`);
  if (s.cost != null) bits.push(fmtCost(s.cost));
  if (s.blocked) bits.push(`${s.blocked} blocked`);
  if (s.loops) bits.push(`${s.loops} loops`);
  const when = s.started ? esc(s.started.replace("T", " ").replace(/\..*/, "")) : "?";

  const rows = s.trajectory.length
    ? s.trajectory.map(trajRow).join("")
    : `<div class="row"><span></span><span></span><span class="sum empty">(no tool calls)</span></div>`;

  // Only what the reader came for starts open: a running session, the latest
  // one, or one with a "needs you" item. The rest collapse to their summary
  // line, which already carries the blocked/loop counts.
  const open = !s.ended || flagged;
  const about = s.face ? aboutOf(s.face, s.id, 200) : "";
  return `<details class="session"${open ? " open" : ""}>
<summary>
  <span class="sid">${esc(s.face ? headOf(s.face, s.id) : shortId(s.id))}</span>
  <span class="badge ${badgeClass}">${esc(status)}</span>
  <span class="meta">${esc(when)} · ${bits.map(esc).join(" · ")}</span>
</summary>
${about ? `<div class="about">${esc(about)}</div>` : ""}${claimLine(s.claim)}
<div class="traj">${rows}</div>
</details>`;
}

function claimLine(claim: Claim | undefined): string {
  if (!claim || claim.verdict === "none") return "";
  const cmd = claim.command ? ` <code>${esc(claim.command)}</code>` : "";
  return `\n<div class="claim ${claim.verdict}">Claim check: ${esc(claim.text)}.${cmd}</div>`;
}

function trajRow(call: ReportCall): string {
  const kind = call.denied ? "deny" : call.asked ? "ask" : call.failed ? "fail" : "ok";
  const glyph = call.denied ? "⛔" : call.asked ? "✋" : call.failed ? "✗" : "•";
  const loop = call.looped ? ` <span class="loop">⟳</span>` : "";
  const rule = call.ruleId ? ` <span class="rule">guard:${esc(call.ruleId)}</span>` : "";
  return `<div class="row ${kind}"><span class="g ${kind}">${glyph}</span><span class="tool">${esc(call.tool)}</span><span class="sum">${esc(call.summary)}${rule}${loop}</span></div>`;
}

function card(label: string, n: string, cls = ""): string {
  return `<div class="card ${cls}"><div class="n">${esc(n)}</div><div class="l">${esc(label)}</div></div>`;
}

/** 128540 → "128,540"; 3200000 → "3.2M". Locale-independent (report is a stable artifact). */
function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** Costs are small; keep cents visible but don't pretend at sub-cent precision. */
function fmtCost(n: number): string {
  return n < 0.01 && n > 0 ? "<$0.01" : `$${n.toFixed(2)}`;
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}


function humanDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

function outPath(args: string[], repo: string): string {
  const i = args.findIndex((a) => a === "-o" || a === "--out");
  if (i >= 0 && args[i + 1]) return path.resolve(args[i + 1]);
  return path.join(reinsDir(repo), "report.html");
}

function tryOpen(file: string): void {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  try {
    const { spawn } = require("node:child_process") as typeof import("node:child_process");
    spawn(cmd, [file], { stdio: "ignore", detached: true, shell: process.platform === "win32" }).unref();
  } catch {
    /* opening is best-effort; the path was already printed */
  }
}
