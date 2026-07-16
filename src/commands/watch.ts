import * as readline from "node:readline";
import { openDbReadOnly, hasSessionNameColumn } from "../db";
import { displayName } from "../names";
import { capabilityNote } from "../store";
import { loadConfig } from "../config";
import { resolveProjectDir } from "../paths";
import { peekSteering, writeSteering, clearSteering } from "../steering";
import { c } from "./format";
import { truncate } from "../util";
import * as path from "node:path";

/**
 * `reins watch` — mission control for a fleet of agents in one repo.
 *
 * A live, auto-refreshing cockpit over the same `.reins/runs.db` the other read
 * commands use. Each agent is its own block — status (active / idle / looping
 * now), a short trajectory tail (its last few tool calls), and any queued
 * steering — separated from the next agent by a rule. Plus the one thing a
 * built-in queued message can't do: aim a nudge at ONE of N agents without
 * alt-tabbing into its window. Select a session, press `s`, type.
 *
 * Dependency-free on purpose (raw ANSI + node:readline) — no daemon, no TUI lib,
 * in keeping with the rest of reins. The renderer (`renderFrame`) is a pure
 * function of an immutable model so it can be unit-tested without a terminal.
 */

const ALT_ON = "\x1b[?1049h";
const ALT_OFF = "\x1b[?1049l";
const HIDE_CURSOR = "\x1b[?25l";
const SHOW_CURSOR = "\x1b[?25h";
const HOME = "\x1b[H";
const CLEAR = "\x1b[2J";

/** Activity newer than this counts as "active"; older running sessions are "idle". */
const ACTIVE_WINDOW_MS = 30_000;
const DEFAULT_LIMIT = 12;
/** How many recent tool calls to show under each session block. */
const RECENT_CALLS = 3;

export interface CallLine {
  tool: string;
  summary: string;
  denied: boolean;
  failed: boolean;
  looped: boolean;
}

export interface SessionView {
  id: string;
  /** Human-readable label: custom (reins name) or auto mnemonic. */
  name?: string;
  ended: boolean;
  outcome: string | null;
  calls: number;
  lastTsMs: number | null;
  looping: boolean;
  steerQueued: string | null;
  /** The session's last few tool calls, oldest → newest. */
  recent: CallLine[];
}

export interface WatchModel {
  repo: string;
  sessions: SessionView[];
  broadcast: string | null;
  threshold: number;
}

export interface UiState {
  selectedId: string | null;
  nowMs: number;
  intervalSec: number;
  message: string;
  width: number;
}

export async function cmdWatch(args: string[]): Promise<number> {
  const intervalSec = parseInterval(args) ?? 2;
  const once = args.includes("--once");

  const db = openDbReadOnly();
  if (!db) {
    console.log(c.dim(capabilityNote() || "Nothing to watch yet — no .reins/runs.db. Run an agent first."));
    return 0;
  }
  const threshold = loadConfig().loopThreshold;
  const repo = resolveProjectDir();

  const interactive = !!(process.stdin.isTTY && process.stdout.isTTY) && !once;

  // Non-TTY (piped, CI, or --once): print one snapshot and exit. Keeps `watch`
  // scriptable and prevents a detached process from spinning forever.
  if (!interactive) {
    const model = buildModel(db, repo, threshold);
    const ui: UiState = {
      selectedId: model.sessions[0]?.id ?? null,
      nowMs: Date.now(),
      intervalSec,
      message: "",
      width: process.stdout.columns || 100,
    };
    process.stdout.write(renderFrame(model, ui, false) + "\n");
    return 0;
  }

  return runInteractive(db, repo, threshold, intervalSec);
}

function runInteractive(
  db: NonNullable<ReturnType<typeof openDbReadOnly>>,
  repo: string,
  threshold: number,
  intervalSec: number,
): Promise<number> {
  return new Promise((resolve) => {
    let selectedId: string | null = null;
    let message = "";
    let prompting = false;
    let timer: NodeJS.Timeout | null = null;
    let closed = false;

    const stdin = process.stdin;

    function render(): void {
      if (prompting || closed) return;
      const model = buildModel(db, repo, threshold);
      // Keep the selection anchored to a session id across reorders; fall back to
      // the top row if the previously selected session scrolled off the list.
      if (!selectedId || !model.sessions.some((s) => s.id === selectedId)) {
        selectedId = model.sessions[0]?.id ?? null;
      }
      const ui: UiState = {
        selectedId,
        nowMs: Date.now(),
        intervalSec,
        message,
        width: process.stdout.columns || 100,
      };
      process.stdout.write(HOME + CLEAR + renderFrame(model, ui, true));
    }

    function currentSessions(): SessionView[] {
      return buildModel(db, repo, threshold).sessions;
    }

    function move(delta: number): void {
      const ids = currentSessions().map((s) => s.id);
      if (ids.length === 0) return;
      const cur = selectedId ? ids.indexOf(selectedId) : -1;
      const next = Math.max(0, Math.min(ids.length - 1, (cur < 0 ? 0 : cur) + delta));
      selectedId = ids[next];
      render();
    }

    function cleanup(): void {
      if (closed) return;
      closed = true;
      if (timer) clearInterval(timer);
      stdin.off("keypress", onKeypress);
      try {
        stdin.setRawMode?.(false);
      } catch {
        /* not a raw-capable tty */
      }
      stdin.pause();
      process.stdout.write(SHOW_CURSOR + ALT_OFF);
    }

    async function steer(target: "selected" | "broadcast"): Promise<void> {
      const sess = currentSessions();
      const sel = sess.find((s) => s.id === selectedId);
      if (target === "selected" && !sel) {
        message = c.yellow("no session selected");
        render();
        return;
      }
      const who =
        target === "broadcast"
          ? "all sessions (broadcast)"
          : `${c.cyan(sel!.name ?? shortId(sel!.id))} ${c.dim("(" + shortId(sel!.id) + ")")}`;
      prompting = true;
      const answer = (await promptLine(`steer ${who} › `)).trim();
      prompting = false;
      if (answer) {
        writeSteering(answer, undefined, target === "broadcast" ? undefined : sel!.id);
        message =
          c.green("✓ queued") +
          (target === "broadcast" ? " broadcast" : ` → ${shortId(sel!.id)}`) +
          c.dim(" (lands at its next tool call)");
      } else {
        message = c.dim("steer cancelled");
      }
      render();
    }

    function clearSelected(): void {
      const sel = currentSessions().find((s) => s.id === selectedId);
      if (!sel) return;
      clearSteering(undefined, sel.id);
      message = c.dim(`cleared queued steering for ${shortId(sel.id)}`);
      render();
    }

    function onKeypress(str: string | undefined, key: readline.Key): void {
      if (prompting) return;
      if (key && key.ctrl && key.name === "c") {
        cleanup();
        resolve(0);
        return;
      }
      const name = key?.name;
      switch (str || name) {
        case "q":
          cleanup();
          resolve(0);
          return;
        case "k":
        case "up":
          move(-1);
          return;
        case "j":
        case "down":
          move(1);
          return;
        case "s":
          void steer("selected");
          return;
        case "b":
          void steer("broadcast");
          return;
        case "c":
          clearSelected();
          return;
        case "r":
          message = "";
          render();
          return;
        default:
          return;
      }
    }

    // Enter the alternate screen so we don't shred the user's scrollback.
    process.stdout.write(ALT_ON + HIDE_CURSOR);
    readline.emitKeypressEvents(stdin);
    try {
      stdin.setRawMode?.(true);
    } catch {
      /* best-effort */
    }
    stdin.resume();
    stdin.on("keypress", onKeypress);
    process.on("exit", cleanup);

    render();
    timer = setInterval(render, Math.max(500, intervalSec * 1000));
  });
}

/** Read one line from the user, temporarily leaving raw mode and showing the cursor. */
function promptLine(question: string): Promise<string> {
  return new Promise((resolve) => {
    const wasRaw = !!process.stdin.isRaw;
    try {
      process.stdin.setRawMode?.(false);
    } catch {
      /* ignore */
    }
    // Drop to the bottom of the screen with the cursor visible for typing.
    process.stdout.write(SHOW_CURSOR + "\n");
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      if (wasRaw) {
        try {
          process.stdin.setRawMode?.(true);
        } catch {
          /* ignore */
        }
      }
      process.stdout.write(HIDE_CURSOR);
      resolve(answer);
    });
  });
}

/** Snapshot the project's sessions for one frame. Tolerates a transient lock. */
export function buildModel(
  db: NonNullable<ReturnType<typeof openDbReadOnly>>,
  repo: string,
  threshold: number,
  limit = DEFAULT_LIMIT,
): WatchModel {
  const sessions: SessionView[] = [];
  try {
    const hasName = hasSessionNameColumn(db);
    const rows = db
      .prepare(
        `SELECT s.id, ${hasName ? "s.name, " : ""}s.ended, s.final_outcome, s.started,
                COUNT(t.seq) AS calls, MAX(t.ts) AS last_ts
           FROM sessions s
           LEFT JOIN tool_calls t ON t.session_id = s.id
          GROUP BY s.id
          ORDER BY COALESCE(MAX(t.ts), s.started) DESC
          LIMIT ?`,
      )
      .all(limit) as Array<{
      id: string;
      name?: string | null;
      ended: string | null;
      final_outcome: string | null;
      started: string | null;
      calls: number;
      last_ts: string | null;
    }>;

    for (const r of rows) {
      // Per-hash repeat counts power the loop marks; one grouped query per session.
      const counts = new Map<string, number>();
      const hashRows = db
        .prepare(`SELECT input_hash, COUNT(*) AS n FROM tool_calls WHERE session_id = ? GROUP BY input_hash`)
        .all(r.id) as Array<{ input_hash: string; n: number }>;
      for (const h of hashRows) counts.set(h.input_hash, h.n);

      // Last RECENT_CALLS calls, newest-first from the DB, flipped to chronological.
      const callRows = (
        db
          .prepare(
            `SELECT tool, input_summary, input_hash, ok
               FROM tool_calls WHERE session_id = ? ORDER BY seq DESC LIMIT ?`,
          )
          .all(r.id, RECENT_CALLS) as Array<{
          tool: string;
          input_summary: string;
          input_hash: string;
          ok: number | null;
        }>
      ).reverse();

      const recent: CallLine[] = callRows.map((cr) => {
        const denied = cr.input_summary.startsWith("DENIED: ");
        return {
          tool: cr.tool,
          summary: denied ? cr.input_summary.slice(8) : cr.input_summary,
          denied,
          failed: cr.ok === 0,
          looped: (counts.get(cr.input_hash) ?? 0) >= threshold,
        };
      });

      const lastTsStr = r.last_ts || r.started;
      sessions.push({
        id: r.id,
        name: displayName(r.id, r.name),
        ended: !!r.ended,
        outcome: r.final_outcome,
        calls: r.calls,
        lastTsMs: lastTsStr ? safeParse(lastTsStr) : null,
        // "Looping right now" = the most recent call's exact input has already
        // fired >= threshold times. More useful for a live cockpit than "ever".
        looping: recent.length > 0 ? recent[recent.length - 1].looped : false,
        steerQueued: peekSteering(undefined, r.id),
        recent,
      });
    }
  } catch {
    /* DB momentarily locked by a writer — render whatever we have (often empty). */
  }

  return { repo, sessions, broadcast: peekSteering(undefined), threshold };
}

/** Pure renderer: a model + UI state in, the full frame (string) out. Testable. */
export function renderFrame(model: WatchModel, ui: UiState, interactive: boolean): string {
  const lines: string[] = [];
  const repoName = path.basename(model.repo) || model.repo;
  const clock = new Date(ui.nowMs).toISOString().slice(11, 19);
  const width = ui.width || 100;

  lines.push(
    c.bold("reins · watch") +
      "  " +
      c.cyan(repoName) +
      c.dim(`   ${clock} · every ${ui.intervalSec}s · loop≥${model.threshold}`),
  );

  if (model.broadcast) {
    lines.push(c.dim("  broadcast steer queued: ") + c.cyan('"' + truncate(model.broadcast.replace(/\n/g, " "), 60) + '"'));
  }
  lines.push("");

  if (model.sessions.length === 0) {
    lines.push(c.dim("  No sessions yet. Start an agent in this repo and they'll appear here."));
  } else {
    const sep = "  " + c.dim("─".repeat(Math.min(width - 2, 64)));
    model.sessions.forEach((s, i) => {
      if (i > 0) lines.push(sep);
      lines.push(headerLine(s, s.id === ui.selectedId, ui.nowMs));
      if (s.recent.length === 0) {
        lines.push("      " + c.dim("(no calls yet)"));
      } else {
        for (const call of s.recent) lines.push("      " + callLine(call, width));
      }
    });
  }

  lines.push("");
  if (ui.message) lines.push("  " + ui.message);
  if (interactive) {
    lines.push(
      c.dim("  ↑/↓ jk select · ") +
        c.bold("s") +
        c.dim(" steer one · ") +
        c.bold("b") +
        c.dim(" broadcast · ") +
        c.bold("c") +
        c.dim(" clear · ") +
        c.bold("r") +
        c.dim(" refresh · ") +
        c.bold("q") +
        c.dim(" quit"),
    );
  }
  return lines.join("\n");
}

/** The session's header line: caret, name, id, status, call count + age, steer flag. */
function headerLine(s: SessionView, selected: boolean, nowMs: number): string {
  const caret = selected ? c.cyan(c.bold("›")) : " ";
  const label = pad(s.name ?? displayName(s.id), 14);
  const name = selected ? c.bold(label) : c.cyan(label);
  const id = c.dim(pad(shortId(s.id), 8));
  const status = statusCell(s, nowMs);
  const age = s.lastTsMs != null ? nowMs - s.lastTsMs : null;
  const meta = c.dim(`${s.calls} call${s.calls === 1 ? "" : "s"}` + (age != null ? ` · ${formatAge(age)} ago` : ""));
  const steer = s.steerQueued ? "   " + c.magenta("✎ steer queued") : "";
  return `  ${caret} ${name} ${id}  ${status}  ${meta}${steer}`;
}

function statusCell(s: SessionView, nowMs: number): string {
  const age = s.lastTsMs != null ? nowMs - s.lastTsMs : null;
  const recent = age != null && age < ACTIVE_WINDOW_MS;
  // Liveness is driven by recent tool activity, NOT the `ended` flag. Claude
  // Code fires the Stop hook at every *turn* boundary, so an interactive session
  // gets marked "ended" between turns while it's very much still alive and
  // steerable. If it called a tool within ACTIVE_WINDOW it's active, full stop —
  // otherwise fall back to its recorded outcome / loop / idle age.
  if (recent) return s.looping ? c.red(pad("⟳ looping", 11)) : c.yellow(pad("● active", 11));
  if (s.ended) return c.green(pad(s.outcome || "ended", 11));
  if (s.looping) return c.red(pad("⟳ looping", 11));
  return c.dim(pad("○ idle " + (age != null ? formatAge(age) : "?"), 11));
}

/** One indented tool-call line under a session block. */
function callLine(call: CallLine, width: number): string {
  let glyph: string;
  if (call.denied) glyph = c.red("⛔");
  else if (call.failed) glyph = c.yellow("✗");
  else glyph = c.green(toolGlyph(call.tool));
  const tool = c.dim(pad(call.tool, 8));
  const summary = truncate((call.summary || "").replace(/\s+/g, " "), Math.max(24, width - 22));
  const loopMark = call.looped ? c.yellow(" ⟳") : "";
  return `${glyph} ${tool} ${summary}${loopMark}`;
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
      return "·";
    case "Glob":
    case "Grep":
      return "?";
    default:
      return "•";
  }
}

/** Pad a PLAIN string to width before coloring (color codes have zero display width). */
function pad(s: string, width: number): string {
  return s.length >= width ? s : s + " ".repeat(width - s.length);
}

function formatAge(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h`;
}

function safeParse(iso: string): number | null {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

function shortId(id: string): string {
  return id.length > 8 ? id.slice(0, 8) : id;
}

function parseInterval(args: string[]): number | undefined {
  const i = args.findIndex((a) => a === "-n" || a === "--interval");
  if (i >= 0 && args[i + 1]) {
    const n = parseFloat(args[i + 1]);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return undefined;
}
