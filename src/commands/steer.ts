import * as readline from "node:readline";
import {
  writeSteering,
  appendSteering,
  peekSteering,
  clearSteering,
  pendingTargetedSessions,
} from "../steering";
import { openDbReadOnly, matchSessions, recentActiveSessions, ActiveSessionRow } from "../db";
import { displayName, mnemonic } from "../names";
import { c } from "./format";

/**
 * Sessions with activity inside this window are offered by the picker. Wider
 * than watch's 30s "active" chip on purpose: an interactive session waiting on
 * its human idles for minutes and is still very much steerable. The row shows
 * each session's age so the human — not a heuristic — makes the final call.
 */
const PICKER_WINDOW_MS = 15 * 60_000;
/** Same threshold as watch: activity this fresh renders as ● active. */
const ACTIVE_MS = 30_000;

export async function cmdSteer(args: string[]): Promise<number> {
  // --session <id|prefix|name> targets one session; otherwise steering is a
  // broadcast consumed by whichever session hits the next tool boundary first —
  // unless several sessions are live and we're on a TTY, in which case we ask.
  const session = resolveSession(args);
  if (session === false) return 1; // ambiguous/not-found; message printed
  let sid = session || undefined;
  const rest = stripFlag(args, "--session");

  if (rest[0] === "--clear" || rest[0] === "-c") {
    clearSteering(undefined, sid);
    console.log(c.dim(sid ? `Cleared pending steering for ${short(sid)}.` : "Cleared pending global steering."));
    return 0;
  }

  const replace = rest.includes("--replace");
  const broadcast = rest.includes("--broadcast") || rest.includes("--all");
  const message = rest
    .filter((a) => a !== "--replace" && a !== "--broadcast" && a !== "--all")
    .join(" ")
    .trim();

  if (!message) {
    showPending(sid);
    return 0;
  }

  // With several agents alive in one repo, a bare steer silently races: it
  // lands on whichever session moves first, which may not be the one you
  // meant. So when it's interactive and more than one session is plausibly
  // live, list them and ask. Enter keeps the broadcast (old muscle memory);
  // --broadcast skips the question; piped/scripted runs are never prompted.
  if (!sid && !broadcast && process.stdin.isTTY && process.stdout.isTTY) {
    const picked = await pickSession();
    if (picked === "cancelled") {
      console.log(c.dim("Cancelled — nothing queued."));
      return 0;
    }
    if (picked) sid = picked;
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

/**
 * Ask which live session the steer is for. Returns a session id, undefined
 * for broadcast (also the 0-or-1-live-sessions fast path — no question, no
 * behavior change), or "cancelled".
 */
async function pickSession(): Promise<string | undefined | "cancelled"> {
  let rows: ActiveSessionRow[] = [];
  try {
    const db = openDbReadOnly();
    if (!db) return undefined; // no capture — nothing to list, broadcast as ever
    rows = recentActiveSessions(db, Date.now(), PICKER_WINDOW_MS);
  } catch {
    return undefined; // a flaky DB must never block a steer
  }
  if (rows.length < 2) return undefined;

  const nowMs = Date.now();
  console.log(c.bold("Several sessions are live — where should this steer land?"));
  rows.forEach((r, i) => console.log(formatPickerRow(r, i, nowMs)));
  console.log(
    "  " + c.cyan("a") + c.dim(". all — broadcast; whichever session moves next consumes it"),
  );

  for (;;) {
    const answer = await promptLine(c.dim(`Choose [1-${rows.length}, a=all, q=quit] (default a): `));
    const choice = parsePickerChoice(answer, rows.length);
    if (choice.kind === "broadcast") return undefined;
    if (choice.kind === "cancel") return "cancelled";
    if (choice.kind === "session") return rows[choice.index].id;
    console.log(c.yellow(`  ? "${answer.trim()}" — a number 1-${rows.length}, "a", or "q".`));
  }
}

export type PickerChoice =
  | { kind: "session"; index: number }
  | { kind: "broadcast" }
  | { kind: "cancel" }
  | { kind: "invalid" };

/** Pure parser for the picker answer, so the interactive path stays testable. */
export function parsePickerChoice(answer: string, count: number): PickerChoice {
  const a = answer.trim().toLowerCase();
  if (a === "" || a === "a" || a === "all") return { kind: "broadcast" };
  if (a === "q" || a === "quit") return { kind: "cancel" };
  if (/^\d+$/.test(a)) {
    const n = parseInt(a, 10);
    if (n >= 1 && n <= count) return { kind: "session", index: n - 1 };
  }
  return { kind: "invalid" };
}

/** One numbered picker row: name, id, liveness, and the last call as context. */
export function formatPickerRow(r: ActiveSessionRow, index: number, nowMs: number): string {
  const name = displayName(r.id, r.name);
  const age = r.lastTsMs != null ? nowMs - r.lastTsMs : null;
  const live = age != null && age < ACTIVE_MS;
  const status = live ? c.yellow("● active") : c.dim(`○ idle ${age != null ? formatAge(age) : "?"}`);
  const meta = c.dim(`${r.calls} call${r.calls === 1 ? "" : "s"}`);
  const last =
    r.lastTool && r.lastSummary
      ? c.dim(`  ${r.lastTool}: ${truncateFlat(r.lastSummary, 40)}`)
      : "";
  const steer = peekQueued(r.id) ? "  " + c.magenta("✎ steer queued") : "";
  return (
    `  ${c.cyan(String(index + 1))}. ${c.bold(pad(name, 16))} ${c.dim(short(r.id))}  ` +
    `${status}  ${meta}${last}${steer}`
  );
}

function peekQueued(sessionId: string): boolean {
  try {
    return peekSteering(undefined, sessionId) !== null;
  } catch {
    return false;
  }
}

function promptLine(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    let answered = false;
    rl.question(question, (answer) => {
      answered = true;
      rl.close();
      resolve(answer);
    });
    // stdin EOF (ctrl-d, or a pty that closed): fall back to broadcast — the
    // pre-picker behavior — rather than hanging with nothing queued.
    rl.on("close", () => {
      if (!answered) resolve("a");
    });
  });
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
      console.log(c.dim('       reins steer --session <id|name> "..."   (target one agent; see `reins sessions`)'));
    }
  }
}

/**
 * Resolve a --session value — id, id prefix, custom name, or auto mnemonic —
 * to a full session id via the DB (see matchSessions for the precedence).
 * Returns: undefined (no --session), a string (resolved id), or false (error).
 */
function resolveSession(args: string[]): string | undefined | false {
  const i = args.findIndex((a) => a === "--session" || a === "-s");
  if (i < 0) return undefined;
  const val = args[i + 1];
  if (!val) {
    console.error(c.red("--session needs a session id, prefix, or name (see `reins sessions`)."));
    return false;
  }
  const db = openDbReadOnly();
  if (!db) return val; // no DB to resolve against — use the value as given
  const ids = matchSessions(db, val);
  if (ids.length === 0) return val; // unknown — allow targeting it pre-emptively
  if (ids.length > 1) {
    console.error(c.red(`Ambiguous "${val}" — it matches ${ids.length} sessions:`));
    for (const id of ids.slice(0, 5)) console.error(`  ${short(id)}  ${c.dim(mnemonic(id))}`);
    return false;
  }
  return ids[0];
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

function truncateFlat(s: string, max: number): string {
  const flat = s.replace(/\s+/g, " ");
  return flat.length <= max ? flat : flat.slice(0, max - 1) + "…";
}

function formatAge(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h`;
}

function pad(s: string, width: number): string {
  return s.length >= width ? s : s + " ".repeat(width - s.length);
}

function short(id: string): string {
  return id.length > 8 ? id.slice(0, 8) : id;
}
