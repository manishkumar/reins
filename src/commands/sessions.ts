import { openDbReadOnly } from "../db";
import { capabilityNote } from "../store";
import { c } from "./format";

interface Row {
  id: string;
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

  const rows = db
    .prepare(
      `SELECT s.id, s.started, s.ended, s.final_outcome,
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

  console.log(c.bold(`Recent sessions `) + c.dim(`(most recent first, max ${limit})`));
  console.log("");
  for (const r of rows) {
    const status = r.ended
      ? c.green(r.final_outcome || "ended")
      : c.yellow("running");
    const when = (r.last_ts || r.started || "").replace("T", " ").replace(/\..*/, "");
    console.log(
      `  ${c.cyan(shortId(r.id))}  ${status.padEnd(20)} ${c.dim(`${r.calls} calls`)}  ${c.dim(when)}`,
    );
  }
  console.log("");
  console.log(c.dim("Full trajectory of one:  reins lastrun <session-id>"));
  return 0;
}

function shortId(id: string): string {
  // First 8 chars are plenty unique within a project and copy cleanly into
  // `reins lastrun <prefix>` (which matches on prefix).
  return id.length > 8 ? id.slice(0, 8) : id;
}

function parseLimit(args: string[]): number | undefined {
  const i = args.findIndex((a) => a === "-n" || a === "--limit");
  if (i >= 0 && args[i + 1]) {
    const n = parseInt(args[i + 1], 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return undefined;
}
