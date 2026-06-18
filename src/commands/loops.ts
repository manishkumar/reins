import { openDbReadOnly } from "../db";
import { capabilityNote } from "../store";
import { loadConfig } from "../config";
import { c } from "./format";
import { truncate } from "../util";

interface LoopRow {
  session_id: string;
  tool: string;
  input_summary: string;
  n: number;
  last_ts: string;
}

export function cmdLoops(): number {
  const db = openDbReadOnly();
  if (!db) {
    const note = capabilityNote();
    console.log(c.dim(note || "No runs recorded yet (.reins/runs.db doesn't exist)."));
    return 0;
  }
  const threshold = loadConfig().loopThreshold;

  const rows = db
    .prepare(
      `SELECT session_id, tool, MIN(input_summary) AS input_summary,
              COUNT(*) AS n, MAX(ts) AS last_ts
         FROM tool_calls
        GROUP BY session_id, input_hash
       HAVING n >= ?
        ORDER BY last_ts DESC`,
    )
    .all(threshold) as LoopRow[];

  if (rows.length === 0) {
    console.log(c.green("No loops detected ") + c.dim(`(threshold: ${threshold} identical calls).`));
    return 0;
  }

  console.log(c.bold(`Loops detected `) + c.dim(`(same tool + input ≥ ${threshold}×)`));
  console.log("");
  let lastSession = "";
  for (const r of rows) {
    if (r.session_id !== lastSession) {
      console.log(c.cyan(r.session_id) + c.dim(`  · last ${r.last_ts}`));
      lastSession = r.session_id;
    }
    console.log(`  ${c.yellow("⟳")} ${c.dim(r.tool.padEnd(10))} ×${r.n}  ${truncate(r.input_summary, 80)}`);
  }
  console.log("");
  console.log(c.dim("Inspect a session in full:  reins lastrun <session-id>"));
  return 0;
}
