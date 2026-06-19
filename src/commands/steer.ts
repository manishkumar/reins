import {
  writeSteering,
  appendSteering,
  peekSteering,
  clearSteering,
  pendingTargetedSessions,
} from "../steering";
import { openDbReadOnly } from "../db";
import { c } from "./format";

export function cmdSteer(args: string[]): number {
  // --session <id-or-prefix> targets one session; otherwise steering is a
  // broadcast consumed by whichever session hits the next tool boundary first.
  const session = resolveSession(args);
  if (session === false) return 1; // ambiguous/not-found prefix; message printed
  const sid = session || undefined;
  const rest = stripFlag(args, "--session");

  if (rest[0] === "--clear" || rest[0] === "-c") {
    clearSteering(undefined, sid);
    console.log(c.dim(sid ? `Cleared pending steering for ${short(sid)}.` : "Cleared pending global steering."));
    return 0;
  }

  const replace = rest.includes("--replace");
  const message = rest.filter((a) => a !== "--replace").join(" ").trim();

  if (!message) {
    showPending(sid);
    return 0;
  }

  const hadPending = peekSteering(undefined, sid) !== null;
  const target = sid ? ` → session ${c.cyan(short(sid))}` : "";
  if (replace || !hadPending) {
    writeSteering(message, undefined, sid);
    console.log(c.green("✓ Steering queued") + target + ".");
  } else {
    const count = appendSteering(message, undefined, sid);
    console.log(c.green(`✓ Added to pending steering${target} (${count} nudges queued).`));
    console.log(c.dim("  Use --replace to overwrite instead, or `reins steer --clear` to reset."));
  }
  console.log(
    c.dim(
      "It reaches the agent at its next tool call — its next decision point — " +
        "then clears (one-shot). The run keeps going; nothing is interrupted.",
    ),
  );
  return 0;
}

function showPending(sid?: string): void {
  const pending = peekSteering(undefined, sid);
  if (pending) {
    const where = sid ? ` for session ${short(sid)}` : "";
    console.log(c.bold(`Pending steering${where} (delivers at the agent's next tool call):`));
    console.log("  " + pending.replace(/\n/g, "\n  "));
  } else {
    console.log(c.dim(sid ? `No steering queued for ${short(sid)}.` : "No steering queued."));
  }
  // Also surface any session-targeted nudges so they aren't forgotten.
  if (!sid) {
    const targeted = pendingTargetedSessions();
    if (targeted.length) {
      console.log(c.dim("Targeted steering pending for: ") + targeted.map((t) => c.cyan(short(t))).join(", "));
    }
    if (!pending && !targeted.length) {
      console.log("");
      console.log("Usage: " + c.cyan('reins steer "the detail you forgot to put in the prompt"'));
      console.log(c.dim('       reins steer --session <id> "..."   (target one agent; see `reins sessions`)'));
    }
  }
}

/**
 * Resolve a --session value (full id or prefix) to a full session id via the DB.
 * Returns: undefined (no --session), a string (resolved id), or false (error).
 */
function resolveSession(args: string[]): string | undefined | false {
  const i = args.findIndex((a) => a === "--session" || a === "-s");
  if (i < 0) return undefined;
  const val = args[i + 1];
  if (!val) {
    console.error(c.red("--session needs a session id or prefix (see `reins sessions`)."));
    return false;
  }
  const db = openDbReadOnly();
  if (!db) return val; // no DB to resolve against — use the value as given
  const rows = db
    .prepare("SELECT id FROM sessions WHERE id LIKE ? ORDER BY started DESC")
    .all(val + "%") as { id: string }[];
  if (rows.length === 0) return val; // unknown id — allow targeting it pre-emptively
  if (rows.length > 1 && !rows.some((r) => r.id === val)) {
    console.error(c.red(`Ambiguous session prefix "${val}" matches ${rows.length} sessions:`));
    for (const r of rows.slice(0, 5)) console.error("  " + short(r.id));
    return false;
  }
  return rows.find((r) => r.id === val)?.id ?? rows[0].id;
}

function stripFlag(args: string[], flag: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === flag || args[i] === "-s") {
      i++; // skip the flag's value too
      continue;
    }
    out.push(args[i]);
  }
  return out;
}

function short(id: string): string {
  return id.length > 8 ? id.slice(0, 8) : id;
}
