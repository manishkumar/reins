import { openDbReadOnly } from "../db";
import { c } from "./format";
import { truncate } from "../util";
import { loadConfig } from "../config";

interface SessionRow {
  id: string;
  repo: string | null;
  started: string | null;
  ended: string | null;
  total_tokens: number | null;
  total_cost: number | null;
  final_outcome: string | null;
}
interface CallRow {
  seq: number;
  tool: string;
  input_summary: string;
  input_hash: string;
  ok: number | null;
  ts: string;
}

export function cmdLastrun(args: string[]): number {
  const db = openDbReadOnly();
  if (!db) {
    console.log(c.dim("No runs recorded yet (.reins/runs.db doesn't exist)."));
    return 0;
  }

  // Allow `reins lastrun <session_id_prefix>` to inspect an older run.
  const wanted = args[0];
  let session: SessionRow | undefined;
  if (wanted) {
    session = db
      .prepare(`SELECT * FROM sessions WHERE id LIKE ? ORDER BY started DESC LIMIT 1`)
      .get(wanted + "%") as SessionRow | undefined;
  } else {
    session = db
      .prepare(`SELECT * FROM sessions ORDER BY started DESC LIMIT 1`)
      .get() as SessionRow | undefined;
  }
  if (!session) {
    console.log(c.dim("No sessions recorded yet."));
    return 0;
  }

  const calls = db
    .prepare(`SELECT seq, tool, input_summary, input_hash, ok, ts FROM tool_calls WHERE session_id = ? ORDER BY seq ASC`)
    .all(session.id) as CallRow[];

  const threshold = loadConfig().loopThreshold;

  printHeader(session, calls.length);
  console.log("");
  printTrajectory(calls, threshold);
  console.log("");
  printSummary(calls, threshold);
  return 0;
}

function printHeader(s: SessionRow, callCount: number): void {
  const dur = duration(s.started, s.ended);
  console.log(c.bold("reins · last run"));
  console.log(`  ${c.dim("session")}  ${s.id}`);
  if (s.repo) console.log(`  ${c.dim("repo")}     ${s.repo}`);
  console.log(`  ${c.dim("when")}     ${s.started ?? "?"}${dur ? c.dim(`  (${dur})`) : ""}`);
  const outcome = s.final_outcome ?? (s.ended ? "ended" : c.yellow("still running / not stopped"));
  console.log(`  ${c.dim("outcome")}  ${outcome}`);
  const meta: string[] = [`${callCount} tool calls`];
  if (s.total_tokens != null) meta.push(`${s.total_tokens.toLocaleString()} tokens`);
  if (s.total_cost != null) meta.push(`$${s.total_cost.toFixed(4)}`);
  console.log(`  ${c.dim("totals")}   ${meta.join(c.dim(" · "))}`);
}

function printTrajectory(calls: CallRow[], threshold: number): void {
  if (calls.length === 0) {
    console.log(c.dim("  (no tool calls recorded)"));
    return;
  }
  console.log(c.bold("Trajectory"));
  // Precompute repeat counts for loop marking.
  const counts = new Map<string, number>();
  for (const call of calls) counts.set(call.input_hash, (counts.get(call.input_hash) ?? 0) + 1);

  for (const call of calls) {
    const denied = call.input_summary.startsWith("DENIED: ");
    const summary = denied ? call.input_summary.slice("DENIED: ".length) : call.input_summary;
    const looped = (counts.get(call.input_hash) ?? 0) >= threshold;

    let glyph: string;
    if (denied) glyph = c.red("⛔");
    else if (call.ok === 0) glyph = c.yellow("✗");
    else glyph = c.green(toolGlyph(call.tool));

    const tag = c.dim(call.tool.padEnd(10));
    const loopMark = looped ? c.yellow(" ⟳") : "";
    console.log(`  ${glyph} ${tag} ${truncate(summary, 92)}${loopMark}`);
  }
}

function printSummary(calls: CallRow[], threshold: number): void {
  const writes = new Set<string>();
  const commands: string[] = [];
  let denied = 0;
  let failed = 0;
  const counts = new Map<string, { n: number; tool: string; summary: string }>();

  for (const call of calls) {
    const isDenied = call.input_summary.startsWith("DENIED: ");
    const summary = isDenied ? call.input_summary.slice(8) : call.input_summary;
    if (isDenied) denied++;
    else if (call.ok === 0) failed++;
    // Only count calls that actually ran — a denied write touched nothing.
    if (!isDenied && ["Write", "Edit", "MultiEdit", "NotebookEdit"].includes(call.tool)) {
      writes.add(summary);
    }
    if (call.tool === "Bash" && !isDenied) commands.push(summary);
    const prev = counts.get(call.input_hash);
    counts.set(call.input_hash, { n: (prev?.n ?? 0) + 1, tool: call.tool, summary });
  }

  const loops = [...counts.values()].filter((v) => v.n >= threshold);

  console.log(c.bold("Summary"));
  console.log(`  ${c.green("files touched")}  ${writes.size}`);
  if (writes.size > 0) for (const w of writes) console.log(`    ${c.dim("·")} ${truncate(w, 88)}`);
  console.log(`  ${c.magenta("commands run")}   ${commands.length}`);
  if (denied > 0) console.log(`  ${c.red("blocked")}        ${denied} ${c.dim("(guard vetoes)")}`);
  if (failed > 0) console.log(`  ${c.yellow("failed calls")}   ${failed}`);
  if (loops.length > 0) {
    console.log(`  ${c.yellow("loops")}          ${loops.length} ${c.dim("(repeated ≥ " + threshold + "×)")}`);
    for (const l of loops) console.log(`    ${c.yellow("⟳")} ${l.tool} ×${l.n}: ${c.dim(truncate(l.summary, 70))}`);
  }
}

function toolGlyph(tool: string): string {
  switch (tool) {
    case "Write":
      return "✎";
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit":
      return "✏";
    case "Bash":
      return "▶";
    case "Read":
    case "NotebookRead":
      return "👁";
    case "Glob":
    case "Grep":
      return "🔍";
    default:
      return "•";
  }
}

function duration(start: string | null, end: string | null): string {
  if (!start || !end) return "";
  const ms = new Date(end).getTime() - new Date(start).getTime();
  if (!isFinite(ms) || ms < 0) return "";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${s % 60}s`;
}
