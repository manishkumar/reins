import { openDbReadOnly, hasSessionNameColumn } from "../db";
import { capabilityNote } from "../store";
import { listPending } from "../holds";
import { displayName } from "../names";
import { c } from "./format";

interface Row {
  id: string;
  name?: string | null;
  started: string | null;
  ended: string | null;
  final_outcome: string | null;
  calls: number;
  last_ts: string | null;
}

/** List recent sessions in this project — useful when several agents have run. */
export function cmdSessions(args: string[]): number {
  const limit = parseLimit(args) ?? 15;
  const db = openDbReadOnly();
  if (!db) {
    console.log(c.dim(capabilityNote() || "No runs recorded yet (.reins/runs.db doesn't exist)."));
    return 0;
  }

  const hasName = hasSessionNameColumn(db);
  const rows = db
    .prepare(
      `SELECT s.id, ${hasName ? "s.name, " : ""}s.started, s.ended, s.final_outcome,
              COUNT(t.seq) AS calls, MAX(t.ts) AS last_ts
         FROM sessions s
         LEFT JOIN tool_calls t ON t.session_id = s.id
        GROUP BY s.id
        ORDER BY COALESCE(MAX(t.ts), s.started) DESC
        LIMIT ?`,
    )
    .all(limit) as Row[];

  if (rows.length === 0) {
    console.log(c.dim("No sessions recorded yet."));
    return 0;
  }

  // Live hold-queue counts per session, so a run that ended with parked
  // actions is visibly waiting on YOU, right in the list.
  const holdCounts = new Map<string, number>();
  try {
    for (const p of listPending()) {
      holdCounts.set(p.session_id, (holdCounts.get(p.session_id) ?? 0) + 1);
    }
  } catch {
    /* queue unreadable — show sessions without chips */
  }

  console.log(c.bold(`Recent sessions `) + c.dim(`(most recent first, max ${limit})`));
  console.log("");
  for (const r of rows) {
    const status = r.ended
      ? c.green(r.final_outcome || "ended")
      : c.yellow("running");
    const when = (r.last_ts || r.started || "").replace("T", " ").replace(/\..*/, "");
    const holds = holdCounts.get(r.id);
    const holdChip = holds ? c.cyan(`  ⏳ ${holds} awaiting approval`) : "";
    // Name first — it's what humans scan by; the short id stays for copying
    // into lastrun/steer (both also accept the name).
    const name = pad(displayName(r.id, r.name), 16);
    console.log(
      `  ${c.cyan(name)} ${c.dim(shortId(r.id))}  ${status.padEnd(20)} ${c.dim(`${r.calls} calls`)}  ${c.dim(when)}${holdChip}`,
    );
  }
  console.log("");
  console.log(c.dim("Full trajectory of one:  reins lastrun <session-id>"));
  console.log(c.dim('Name one for easier aim: reins name <session> "<label>"'));
  if (holdCounts.size > 0) console.log(c.dim("Review parked actions:   reins pending"));
  return 0;
}

function shortId(id: string): string {
  // First 8 chars are plenty unique within a project and copy cleanly into
  // `reins lastrun <prefix>` (which matches on prefix).
  return id.length > 8 ? id.slice(0, 8) : id;
}

/** Pad the PLAIN string before coloring (color codes have zero display width). */
function pad(s: string, width: number): string {
  return s.length >= width ? s : s + " ".repeat(width - s.length);
}

function parseLimit(args: string[]): number | undefined {
  const i = args.findIndex((a) => a === "-n" || a === "--limit");
  if (i >= 0 && args[i + 1]) {
    const n = parseInt(args[i + 1], 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return undefined;
}
