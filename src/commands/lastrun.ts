import { openDbReadOnly } from "../db";
import { capabilityNote } from "../store";
import { c } from "./format";
import { truncate, summarizeToolInput } from "../util";
import { loadConfig } from "../config";
import { pendingForSession } from "../holds";

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
    const note = capabilityNote();
    console.log(c.dim(note || "No runs recorded yet (.reins/runs.db doesn't exist)."));
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
  printAwaiting(session.id);
  return 0;
}

/**
 * Actions from this session still parked in the hold queue — read live from
 * .reins/pending (not the DB) so an approve/deny done a minute ago is already
 * reflected. This is the line the overnight-run user came for.
 */
function printAwaiting(sessionId: string): void {
  let pending: ReturnType<typeof pendingForSession>;
  try {
    pending = pendingForSession(undefined, sessionId);
  } catch {
    return;
  }
  if (pending.length === 0) return;
  console.log("");
  console.log(
    c.cyan(`⏳ ${pending.length} action${pending.length === 1 ? "" : "s"} awaiting your approval`) +
      c.dim("   reins approve <id> · reins deny <id>"),
  );
  for (const p of pending) {
    console.log(`    ${c.cyan(p.id)}  ${p.tool}  ${truncate(summarizeToolInput(p.tool, p.input), 70)}`);
  }
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
  if (s.total_tokens != null) meta.push(`${groupThousands(s.total_tokens)} tokens`);
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
    const gate = gateDecision(call.input_summary);
    const summary = gate ? call.input_summary.slice(gate.length + 2) : call.input_summary;
    const looped = (counts.get(call.input_hash) ?? 0) >= threshold;

    let glyph: string;
    if (gate === "DENIED") glyph = c.red("⛔");
    else if (gate === "ASKED") glyph = c.yellow("✋");
    else if (gate === "HELD") glyph = c.cyan("⏳");
    else if (gate === "APPROVED") glyph = c.green("✓");
    else if (gate === "REFUSED") glyph = c.red("✋");
    else if (call.ok === 0) glyph = c.yellow("✗");
    else glyph = c.green(toolGlyph(call.tool));

    const tag = c.dim(call.tool.padEnd(10));
    const loopMark = looped ? c.yellow(" ⟳") : "";
    console.log(`  ${glyph} ${tag} ${truncate(summary, 92)}${loopMark}`);
  }
}

/** The gate-decision prefix of a recorded row, if any ("DENIED", "HELD", …). */
function gateDecision(summary: string): string | null {
  const m = /^(DENIED|ASKED|HELD|APPROVED|REFUSED): /.exec(summary);
  return m ? m[1] : null;
}

function printSummary(calls: CallRow[], threshold: number): void {
  const writes = new Set<string>();
  const commands: string[] = [];
  let denied = 0;
  let held = 0;
  let failed = 0;
  const counts = new Map<string, { n: number; tool: string; summary: string }>();

  for (const call of calls) {
    const gate = gateDecision(call.input_summary);
    const summary = gate ? call.input_summary.slice(gate.length + 2) : call.input_summary;
    if (gate === "DENIED") denied++;
    else if (gate === "HELD") held++;
    else if (!gate && call.ok === 0) failed++;
    // Only count calls that actually ran — a gated write touched nothing.
    if (!gate && ["Write", "Edit", "MultiEdit", "NotebookEdit"].includes(call.tool)) {
      writes.add(summary);
    }
    if (call.tool === "Bash" && !gate) commands.push(summary);
    const prev = counts.get(call.input_hash);
    counts.set(call.input_hash, { n: (prev?.n ?? 0) + 1, tool: call.tool, summary });
  }

  const loops = [...counts.values()].filter((v) => v.n >= threshold);

  console.log(c.bold("Summary"));
  console.log(`  ${c.green("files touched")}  ${writes.size}`);
  if (writes.size > 0) for (const w of writes) console.log(`    ${c.dim("·")} ${truncate(w, 88)}`);
  console.log(`  ${c.magenta("commands run")}   ${commands.length}`);
  if (denied > 0) console.log(`  ${c.red("blocked")}        ${denied} ${c.dim("(guard vetoes)")}`);
  if (held > 0) console.log(`  ${c.cyan("parked")}         ${held} ${c.dim("(hold rules)")}`);
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

/** Stable thousands grouping (avoids locale-specific output like "1,83,007"). */
function groupThousands(n: number): string {
  return n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
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
