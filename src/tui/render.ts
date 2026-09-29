import * as path from "node:path";
import type { AttentionEvent } from "../attention";
import { box, clean, fit, hjoin, overlay, sparkline, Style, width, wrap, type Tone } from "./term";
import {
  liveness,
  SPARK_BUCKETS,
  SPARK_BUCKET_MS,
  type AgentView,
  type CallKind,
  type CallView,
  type HoldView,
  type Liveness,
  type WatchModel,
} from "./model";

/**
 * The `reins watch` screen as a pure function: model + UI state in, exactly
 * `height` lines of exactly `width` columns out. The controller in
 * commands/watch.ts owns the terminal; nothing here touches it.
 */

export type Row = { kind: "hold"; id: string } | { kind: "event"; key: string } | { kind: "agent"; id: string };

export type Modal =
  | { kind: "approve"; holdId: string; scroll: number }
  | { kind: "deny"; holdId: string; text: string }
  | { kind: "steer"; target: string | null; text: string }
  | { kind: "help" }
  | { kind: "result"; title: string; lines: string[]; tone: Tone };

export interface Toast {
  text: string;
  tone: Tone;
}

export interface UiState {
  width: number;
  height: number;
  cursor: number;
  zoom: boolean;
  detailScroll: number;
  modal: Modal | null;
  toast: Toast | null;
  /** Until this time the header's "needs you" pill is highlighted (a new hold arrived). */
  flashUntil: number;
  intervalSec: number;
}

export const MIN_W = 60;
export const MIN_H = 14;
const WIDE = 104;

/* ------------------------------------------------------------- selection */

export function eventKey(e: AttentionEvent): string {
  return `${e.kind}:${e.sessionId}:${e.ts}`;
}

/** The cursor walks one list: holds, then events, then agents. */
export function listRows(m: WatchModel): Row[] {
  return [
    ...m.holds.map((h) => ({ kind: "hold" as const, id: h.action.id })),
    ...m.events.map((e) => ({ kind: "event" as const, key: eventKey(e) })),
    ...m.agents.map((a) => ({ kind: "agent" as const, id: a.id })),
  ];
}

export function selectedRow(m: WatchModel, ui: UiState): Row | null {
  const rows = listRows(m);
  return rows.length ? rows[Math.max(0, Math.min(rows.length - 1, ui.cursor))] : null;
}

export function sameRow(a: Row | null, b: Row | null): boolean {
  if (!a || !b || a.kind !== b.kind) return false;
  return a.kind === "event" ? a.key === (b as typeof a).key : a.id === (b as { id: string }).id;
}

export function findHold(m: WatchModel, id: string): HoldView | undefined {
  return m.holds.find((h) => h.action.id === id);
}

/** The agent a steer from the current selection would go to. */
export function steerTarget(m: WatchModel, row: Row | null): string | null {
  if (!row) return null;
  if (row.kind === "agent") return row.id;
  if (row.kind === "hold") return findHold(m, row.id)?.action.session_id ?? null;
  return m.events.find((e) => eventKey(e) === row.key)?.sessionId ?? null;
}

/* ---------------------------------------------------------------- screen */

export function renderScreen(m: WatchModel, ui: UiState, st: Style): string[] {
  const W = ui.width;
  const H = ui.height;
  if (W < MIN_W || H < MIN_H) {
    const msg = `reins watch needs at least ${MIN_W}×${MIN_H} (now ${W}×${H})`;
    const out = new Array<string>(H).fill(" ".repeat(W));
    out[Math.floor(H / 2)] = fit(" ".repeat(Math.max(0, Math.floor((W - msg.length) / 2))) + msg, W);
    return out;
  }

  const B = H - 3;
  const row = selectedRow(m, ui);
  let body: string[];
  if (ui.zoom) {
    body = detailBox(m, ui, st, row, W, B, true);
  } else if (W >= WIDE) {
    const L = Math.max(48, Math.min(72, Math.floor(W * 0.44)));
    body = hjoin(leftColumn(m, ui, st, row, L, B), detailBox(m, ui, st, row, W - L, B, false));
  } else {
    body = leftColumn(m, ui, st, row, W, B);
  }

  let screen = [header(m, ui, st, W), ...body, statusLine(ui, st, W), hints(m, ui, st, row, W)];
  if (ui.modal) {
    // Dim everything behind the dialog except the hint bar, which is still live.
    const behind = screen.slice(0, -1).map((l) => fit(l, W));
    screen = [...overlay(behind, modalBox(m, ui, st), W, (s) => st.fg("faint", s)), screen[screen.length - 1]];
  }
  return screen.map((l) => fit(l, W));
}

function header(m: WatchModel, ui: UiState, st: Style, W: number): string {
  const repo = path.basename(m.repo) || m.repo;
  const counts: Record<Liveness, number> = { active: 0, looping: 0, idle: 0, done: 0 };
  for (const a of m.agents) counts[liveness(a, m.nowMs, m.threshold)]++;

  const needs = m.holds.length + m.events.length;
  const flashing = ui.flashUntil > m.nowMs;
  const needsPill = needs
    ? flashing
      ? st.inverse(st.fg("bad", st.bold(` ◆ ${needs} NEEDS YOU `)))
      : st.pill(m.holds.length ? "warn" : "bad", `◆ ${needs} needs you`)
    : st.fg("good", "✓ all clear");

  const parts = [
    st.fg("accent", st.bold("◆ reins")) + st.dim(" watch ") + st.fg("text", st.bold(clean(repo))),
    needsPill,
    counts.active ? st.fg("good", `● ${counts.active} active`) : "",
    counts.looping ? st.fg("bad", `⟳ ${counts.looping} looping`) : "",
    counts.idle ? st.dim(`○ ${counts.idle} idle`) : "",
  ].filter(Boolean);
  const left = " " + parts.join(st.fg("faint", "  │  "));
  const right =
    (m.captured ? "" : st.fg("warn", "capture off") + st.dim(" · ")) +
    st.dim(`every ${ui.intervalSec}s · `) +
    st.fg("text", clock(m.nowMs)) +
    " ";
  return lr(left, right, W);
}

function statusLine(ui: UiState, st: Style, W: number): string {
  if (!ui.toast) return " ".repeat(W);
  return fit(" " + st.fg(ui.toast.tone, ui.toast.text), W);
}

function hints(m: WatchModel, ui: UiState, st: Style, row: Row | null, W: number): string {
  const k = (key: string, label: string) => st.fg("accent", st.bold(key)) + " " + st.dim(label);
  let keys: string[];
  if (ui.modal) {
    switch (ui.modal.kind) {
      case "approve":
        keys = approveSeenAll(m, ui, st, ui.modal.holdId, ui.modal.scroll)
          ? [k("j/k", "scroll"), k("y", "approve once"), k("esc", "cancel")]
          : [k("j/space", "keep reading"), st.dim("y unlocks at the end"), k("esc", "cancel")];
        break;
      case "deny":
      case "steer":
        keys = [k("⏎", "submit"), k("esc", "cancel"), k("^U", "clear")];
        break;
      default:
        keys = [k("any key", "close")];
    }
  } else {
    keys = [k("↑↓", "move"), k("tab", "section")];
    if (row?.kind === "hold") keys.push(k("a", "approve"), k("d", "deny"));
    if (row) keys.push(k("s", "steer"));
    keys.push(k("b", "broadcast"));
    if (row?.kind === "agent" && m.agents.find((a) => a.id === row.id)?.steerQueued) keys.push(k("c", "clear steer"));
    keys.push(k("⏎", ui.zoom ? "unzoom" : "zoom"), k("?", "help"), k("q", "quit"));
  }
  return fit(" " + keys.join("   "), W);
}

/* ----------------------------------------------------------- left column */

function leftColumn(m: WatchModel, ui: UiState, st: Style, row: Row | null, w: number, h: number): string[] {
  const needItems = m.holds.length + m.events.length;
  const needsH = needItems === 0 ? 3 : Math.min(needItems * 2 + 2, Math.max(6, Math.floor(h * 0.5)));
  const agentsH = h - needsH;
  const iw = w - 4;

  const needLines: string[][] = [
    ...m.holds.map((hv) => holdItem(hv, m, st, iw, row?.kind === "hold" && row.id === hv.action.id)),
    ...m.events.map((e) => eventItem(e, m, st, iw, row?.kind === "event" && row.key === eventKey(e))),
  ];
  const selNeed = row && row.kind !== "agent" ? listRows(m).findIndex((r) => sameRow(r, row)) : -1;
  const needsFocused = selNeed >= 0 && !ui.zoom;

  const needsBody = needItems
    ? windowed(needLines, selNeed, needsH - 2)
    : { lines: [st.fg("good", "✓ nothing is waiting on you")], hidden: 0 };
  const olderNote = m.olderEvents ? `${m.olderEvents} older in audit --guards` : undefined;
  const needs = box(st, w, needsH, needsBody.lines, {
    title: "NEEDS YOU",
    badge: needItems ? st.fg(m.holds.length ? "warn" : "bad", st.bold(String(needItems))) : undefined,
    focused: needsFocused,
    tone: needsFocused ? "warn" : "faint",
    footer: needsBody.hidden ? `+${needsBody.hidden} more` : olderNote,
  });

  const agentLines = m.agents.map((a) => agentItem(a, m, st, iw, row?.kind === "agent" && row.id === a.id));
  const selAgent = row?.kind === "agent" ? m.agents.findIndex((a) => a.id === row.id) : -1;
  let agentsBody: { lines: string[]; hidden: number };
  if (!m.captured) {
    agentsBody = {
      lines: [
        st.fg("warn", "capture is off"),
        ...wrap("The agent list needs node:sqlite (Node ≥ 22.5). Holds, steering and guards work without it.", iw).map((l) =>
          st.dim(l),
        ),
      ],
      hidden: 0,
    };
  } else if (!m.agents.length) {
    agentsBody = { lines: [st.dim("No sessions yet. Start an agent in this repo.")], hidden: 0 };
  } else {
    agentsBody = windowed(agentLines, selAgent, agentsH - 2);
  }
  const agents = box(st, w, agentsH, agentsBody.lines, {
    title: "AGENTS",
    badge: m.agents.length ? st.dim(String(m.agents.length)) : undefined,
    focused: selAgent >= 0 && !ui.zoom,
    footer: agentsBody.hidden ? `+${agentsBody.hidden} more` : undefined,
  });
  return [...needs, ...agents];
}

/** Keep the selected multi-line item in view; report how many didn't fit. */
function windowed(items: string[][], sel: number, rows: number): { lines: string[]; hidden: number } {
  if (!items.length || rows <= 0) return { lines: [], hidden: items.length };
  const per = items[0].length;
  const fits = Math.max(1, Math.floor(rows / per));
  let start = 0;
  if (sel >= fits) start = sel - fits + 1;
  const shown = items.slice(start, start + fits);
  return { lines: shown.flat(), hidden: items.length - shown.length };
}

function selected(st: Style, lines: string[], on: boolean, iw: number, tone: Tone = "accent"): string[] {
  return lines.map((l, i) => {
    const bar = on ? st.fg(tone, i === 0 ? "▌" : "▌") : " ";
    const body = fit(bar + l, iw);
    return on ? st.bg("selBg", body) : body;
  });
}

function holdItem(h: HoldView, m: WatchModel, st: Style, iw: number, on: boolean): string[] {
  const p = h.action;
  const age = ago(m.nowMs - Date.parse(p.ts));
  const l1 = lr(
    st.fg("warn", st.bold("◆ HELD ")) + st.fg("text", st.bold(clean(p.tool))) + "  " + st.dim(clean(p.rule_id)),
    st.dim(`${clean(h.sessionName)} · `) + st.fg("warn", age),
    iw - 1,
  );
  const first = clean(h.input).replace(/\s+/g, " ").trim();
  const l2 = "  " + st.fg("text", first);
  return selected(st, [l1, l2], on, iw, "warn");
}

function eventItem(e: AttentionEvent, m: WatchModel, st: Style, iw: number, on: boolean): string[] {
  const breach = e.kind === "breach";
  const tone: Tone = breach ? "bad" : "warn";
  const label = breach ? "✖ HOLD BREACHED " : "↪ WORKED AROUND ";
  const l1 = lr(
    st.fg(tone, st.bold(label)) + st.fg("text", clean(e.tool)) + (e.ruleId ? "  " + st.dim(clean(e.ruleId)) : ""),
    st.dim(ago(m.nowMs - Date.parse(e.ts)) + " ago"),
    iw - 1,
  );
  const l2 = "  " + st.dim(clean(e.summary).replace(/\s+/g, " "));
  return selected(st, [l1, l2], on, iw, tone);
}

const LIVE: Record<Liveness, { glyph: string; tone: Tone; label: string }> = {
  active: { glyph: "●", tone: "good", label: "active" },
  looping: { glyph: "⟳", tone: "bad", label: "looping" },
  idle: { glyph: "○", tone: "muted", label: "idle" },
  done: { glyph: "✓", tone: "muted", label: "done" },
};

function agentItem(a: AgentView, m: WatchModel, st: Style, iw: number, on: boolean): string[] {
  const lv = liveness(a, m.nowMs, m.threshold);
  const L = LIVE[lv];
  const since = a.lastTsMs != null ? ago(m.nowMs - a.lastTsMs) : "—";
  const spark = st.fg(lv === "active" || lv === "looping" ? "accent" : "faint", sparkline(a.spark.slice(-12)));
  const l1 = lr(
    st.fg(L.tone, L.glyph) +
      " " +
      st.fg("text", st.bold(clean(a.name))) +
      " " +
      st.dim(a.id.slice(0, 8)) +
      "  " +
      st.fg(L.tone, lv === "idle" ? `idle ${since}` : L.label),
    spark + " " + st.dim(`${a.calls}`.padStart(4)),
    iw - 1,
  );
  let l2: string;
  if (a.holds) l2 = "  " + st.fg("warn", `◆ ${a.holds} held, waiting on you`);
  else if (a.steerQueued) l2 = "  " + st.fg("violet", "✎ steer queued: ") + st.dim(clean(a.steerQueued).replace(/\s+/g, " "));
  else {
    const last = a.trajectory[a.trajectory.length - 1];
    l2 = last ? "  " + callInline(last, st, m.threshold) : "  " + st.dim("(no calls yet)");
  }
  return selected(st, [l1, l2], on, iw);
}

const KIND: Record<CallKind, { glyph: string; tone: Tone }> = {
  ok: { glyph: "›", tone: "muted" },
  failed: { glyph: "✗", tone: "warn" },
  denied: { glyph: "⊘", tone: "bad" },
  asked: { glyph: "?", tone: "warn" },
  held: { glyph: "◆", tone: "warn" },
  approved: { glyph: "✓", tone: "good" },
  refused: { glyph: "✗", tone: "bad" },
};

function callInline(c: CallView, st: Style, threshold: number): string {
  const K = KIND[c.kind];
  const repeat = c.streak > 1 ? " " + st.fg(c.streak >= threshold ? "bad" : "muted", `×${c.streak}`) : "";
  const text = clean(c.summary).replace(/\s+/g, " ");
  return (
    st.fg(K.tone, K.glyph) +
    " " +
    st.dim(clean(c.tool).padEnd(6)) +
    " " +
    (c.kind === "ok" ? st.fg("text", text) : st.fg(K.tone, text)) +
    repeat
  );
}

/* ---------------------------------------------------------------- detail */

function detailBox(
  m: WatchModel,
  ui: UiState,
  st: Style,
  row: Row | null,
  w: number,
  h: number,
  focused: boolean,
): string[] {
  const iw = w - 4;
  const { title, tone, lines } = detailContent(m, st, row, iw);
  const view = h - 2;
  const maxScroll = Math.max(0, lines.length - view);
  const scroll = Math.min(ui.detailScroll, maxScroll);
  const shown = lines.slice(scroll, scroll + view);
  const below = lines.length - scroll - shown.length;
  const footer =
    maxScroll === 0 ? undefined : below > 0 ? `↓ ${below} more · J/K scroll` : scroll > 0 ? `↑ ${scroll} above` : undefined;
  return box(st, w, h, shown, { title, focused, tone: focused ? tone : "faint", footer });
}

/** What the detail pane says about the selection. Exported for the approve modal's line count. */
export function detailContent(
  m: WatchModel,
  st: Style,
  row: Row | null,
  iw: number,
): { title: string; tone: Tone; lines: string[] } {
  if (!row) {
    return {
      title: "DETAIL",
      tone: "accent",
      lines: [
        st.dim("Nothing selected."),
        "",
        ...wrap(
          "Agents appear here once they run in this repo with reins installed. Held actions appear under NEEDS YOU the moment a hold rule parks one.",
          iw,
        ).map((l) => st.dim(l)),
      ],
    };
  }
  if (row.kind === "hold") {
    const h = findHold(m, row.id);
    if (h) return { title: `HELD · ${h.action.id}`, tone: "warn", lines: holdDetail(h, m, st, iw) };
  }
  if (row.kind === "event") {
    const e = m.events.find((x) => eventKey(x) === row.key);
    if (e) return { title: e.kind === "breach" ? "HOLD BREACHED" : "GUARD WORKED AROUND", tone: e.kind === "breach" ? "bad" : "warn", lines: eventDetail(e, m, st, iw) };
  }
  if (row.kind === "agent") {
    const a = m.agents.find((x) => x.id === row.id);
    if (a) return { title: `AGENT · ${clean(a.name)}`, tone: "accent", lines: agentDetail(a, m, st, iw) };
  }
  return { title: "DETAIL", tone: "accent", lines: [st.dim("(gone)")] };
}

function kv(st: Style, key: string, value: string, iw: number, tone: Tone = "text"): string[] {
  const pad = 11;
  const wrapped = wrap(value, Math.max(10, iw - pad));
  return wrapped.map((l, i) => (i === 0 ? st.dim(key.padEnd(pad)) : " ".repeat(pad)) + st.fg(tone, l));
}

function rule(st: Style, label: string, iw: number): string {
  const t = ` ${label} `;
  return st.fg("faint", "──") + st.dim(t) + st.fg("faint", "─".repeat(Math.max(0, iw - 2 - width(t))));
}

/** The proposed input with a gutter, so its edges are unambiguous. */
function inputBlock(st: Style, input: string, iw: number): string[] {
  const lines = wrap(clean(input, true), iw - 2);
  return lines.map((l) => st.fg("warn", "┃ ") + st.fg("text", l));
}

export function holdDetail(h: HoldView, m: WatchModel, st: Style, iw: number): string[] {
  const p = h.action;
  const waited = ago(m.nowMs - Date.parse(p.ts));
  const out: string[] = [
    ...kv(st, "rule", clean(p.rule_id), iw, "warn"),
    ...kv(st, "reason", clean(p.reason), iw),
    ...kv(st, "session", `${clean(h.sessionName)} (${p.session_id.slice(0, 8)})`, iw),
    ...kv(st, "directory", h.where ? clean(h.where) : "project root", iw),
    ...kv(st, "waiting", `${waited} (since ${new Date(p.ts).toLocaleString()})`, iw),
    ...kv(
      st,
      "transport",
      p.transport === "defer"
        ? "defer — the original call is parked in the session; approving runs it when the session resumes"
        : "deny — approving lets the identical retry, from the same directory, through once",
      iw,
      "muted",
    ),
  ];
  if (h.superseded) {
    out.push("", ...wrap("⚠ superseded: this session deferred a newer call. Only the newest is replayed on resume.", iw).map((l) => st.fg("bad", l)));
  }
  out.push("", rule(st, `proposed ${clean(p.tool)} input`, iw), ...inputBlock(st, h.input, iw));
  out.push("", st.fg("accent", st.bold("a")) + st.dim(" approve once   ") + st.fg("accent", st.bold("d")) + st.dim(" deny, optionally with what to do instead"));
  return out;
}

function eventDetail(e: AttentionEvent, m: WatchModel, st: Style, iw: number): string[] {
  const breach = e.kind === "breach";
  const out: string[] = [
    ...kv(st, "when", `${ago(m.nowMs - Date.parse(e.ts))} ago (${new Date(e.ts).toLocaleString()})`, iw),
    ...kv(st, "session", e.sessionId.slice(0, 8), iw),
    ...(e.ruleId ? kv(st, breach ? "hold" : "rule", clean(e.ruleId), iw, "warn") : []),
    ...kv(st, "detail", clean(e.detail), iw),
    "",
    rule(st, breach ? "executed while parked" : "ran anyway", iw),
    ...inputBlock(st, e.summary, iw),
    "",
    ...wrap(
      breach
        ? "A call waiting for approval executed. Claude Code ignores defer outside print mode and for parallel tool calls; set holdTransport to \"deny\" in .reins/config.json for the transport that always holds."
        : `A command this rule denied ran again in a near-identical form. Either the rule is too broad for this repo (reins guard remove ${e.ruleId}) or it should be a hold instead of a deny. reins does not widen the guard in response.`,
      iw,
    ).map((l) => st.dim(l)),
  ];
  return out;
}

function agentDetail(a: AgentView, m: WatchModel, st: Style, iw: number): string[] {
  const lv = liveness(a, m.nowMs, m.threshold);
  const L = LIVE[lv];
  const out: string[] = [
    ...kv(st, "status", `${L.glyph} ${L.label}${lv !== "active" && a.lastTsMs != null ? `, last call ${ago(m.nowMs - a.lastTsMs)} ago` : ""}`, iw, L.tone),
    ...kv(st, "session", a.id, iw, "muted"),
    ...kv(st, "calls", String(a.calls) + (a.startedMs != null ? ` since ${new Date(a.startedMs).toLocaleString()}` : ""), iw),
  ];
  if (a.streak > 1) {
    out.push(
      ...kv(st, "repeating", `the last call ×${a.streak} in a row${a.streak >= m.threshold ? " (loop alarm fired)" : ""}`, iw, a.streak >= m.threshold ? "bad" : "warn"),
    );
  }
  if (a.steerQueued) out.push(...kv(st, "steer", clean(a.steerQueued), iw, "violet"));
  if (a.holds) out.push(...kv(st, "held", `${a.holds} action${a.holds === 1 ? "" : "s"} waiting on you`, iw, "warn"));

  const mins = Math.round((SPARK_BUCKETS * SPARK_BUCKET_MS) / 60000);
  const bars = a.spark;
  const peak = Math.max(0, ...bars);
  out.push(
    "",
    rule(st, `activity · last ${mins}m`, iw),
    st.fg(lv === "active" || lv === "looping" ? "accent" : "muted", stretch(sparkline(bars), Math.min(iw, SPARK_BUCKETS * 2))) +
      st.dim(peak ? `  peak ${peak}/${SPARK_BUCKET_MS / 1000}s` : "  quiet"),
    "",
    rule(st, "trajectory · newest first", iw),
  );
  if (!a.trajectory.length) out.push(st.dim("(no calls yet)"));
  for (const c of a.trajectory.slice().reverse()) {
    const t = c.tsMs != null ? st.fg("faint", clock(c.tsMs)) + " " : "";
    out.push(t + callInline(c, st, m.threshold) + (c.ruleId ? " " + st.dim(`[${clean(c.ruleId)}]`) : ""));
  }
  return out;
}

/** Repeat each sparkline cell so a 24-bucket line fills a wider pane. */
function stretch(s: string, cols: number): string {
  const chars = [...s];
  if (!chars.length) return s;
  const k = Math.max(1, Math.floor(cols / chars.length));
  return chars.map((c) => c.repeat(k)).join("");
}

/* ---------------------------------------------------------------- modals */

export function modalSize(ui: UiState): { w: number; h: number } {
  return { w: Math.min(ui.width - 4, 100), h: ui.height - 4 };
}

/** Lines of the approve modal's scrollable body, and how many fit. */
export function approveBody(m: WatchModel, ui: UiState, st: Style, holdId: string): { lines: string[]; view: number } {
  const { w, h } = modalSize(ui);
  const hv = findHold(m, holdId);
  const iw = w - 4;
  if (!hv) return { lines: [st.dim("This action is no longer pending.")], view: 1 };
  const p = hv.action;
  const lines = [
    ...kv(st, "rule", clean(p.rule_id), iw, "warn"),
    ...kv(st, "reason", clean(p.reason), iw),
    ...kv(st, "session", `${clean(hv.sessionName)} (${p.session_id.slice(0, 8)})`, iw),
    ...kv(st, "directory", hv.where ? clean(hv.where) : "project root", iw),
    "",
    rule(st, `${clean(p.tool)} · the exact input you are approving`, iw),
    ...inputBlock(st, hv.input, iw),
  ];
  // Around the scrolled lines: two borders, the heading and its gap, a gap and the action line.
  return { lines, view: Math.min(h - 6, lines.length) };
}

export function approveSeenAll(m: WatchModel, ui: UiState, st: Style, holdId: string, scroll: number): boolean {
  const { lines, view } = approveBody(m, ui, st, holdId);
  return scroll + view >= lines.length;
}

function modalBox(m: WatchModel, ui: UiState, st: Style): string[] {
  const md = ui.modal!;
  const { w, h } = modalSize(ui);
  const iw = w - 4;

  if (md.kind === "approve") {
    const { lines, view } = approveBody(m, ui, st, md.holdId);
    const scroll = Math.min(md.scroll, Math.max(0, lines.length - view));
    const seen = scroll + view >= lines.length;
    const boxH = view + 6;
    const body = [
      st.fg("warn", st.bold("Approve this exact call, once?")) +
        st.dim("  Any change to it is a new proposal and parks again."),
      "",
      ...lines.slice(scroll, scroll + view),
    ];
    while (body.length < boxH - 3) body.push("");
    body.push(
      seen
        ? st.fg("good", st.bold("y")) + st.dim(" approve once    ") + st.fg("accent", st.bold("esc")) + st.dim(" cancel")
        : st.fg("warn", `↓ ${lines.length - scroll - view} more lines — read to the end to enable approve (j / space)`),
    );
    return box(st, w, boxH, body, { title: "APPROVE", focused: true, tone: "warn" });
  }

  if (md.kind === "deny") {
    const hv = findHold(m, md.holdId);
    const preview = hv ? wrap(clean(hv.input, true), iw - 2).slice(0, 6) : [];
    const body = [
      st.fg("bad", st.bold("Refuse this action.")) + st.dim(" The agent is told at its next attempt."),
      "",
      ...preview.map((l) => st.fg("faint", "┃ ") + st.dim(l)),
      ...(hv && wrap(clean(hv.input, true), iw - 2).length > 6 ? [st.dim("  …")] : []),
      "",
      st.fg("text", "What should it do instead? ") + st.dim("(optional — sent as steering)"),
      ...field(st, md.text, iw),
    ];
    return box(st, w, Math.min(h, body.length + 3), [...body, ""], { title: "DENY", focused: true, tone: "bad" });
  }

  if (md.kind === "steer") {
    const a = md.target ? m.agents.find((x) => x.id === md.target) : null;
    const who = md.target ? `${clean(a?.name ?? md.target.slice(0, 8))} (${md.target.slice(0, 8)})` : "every agent (broadcast)";
    const queued = md.target ? a?.steerQueued : m.broadcast;
    const body = [
      st.fg("violet", st.bold("Steer ")) + st.fg("text", st.bold(who)),
      ...wrap("A nudge the agent weighs at its next tool call — added spec, not an order. For a hard never, use a guard.", iw).map((l) => st.dim(l)),
      ...(queued ? ["", ...kv(st, "queued", clean(queued), iw, "violet"), st.dim("New text is appended; nothing queued is dropped.")] : []),
      "",
      ...field(st, md.text, iw),
    ];
    return box(st, w, Math.min(h, body.length + 3), [...body, ""], { title: "STEER", focused: true, tone: "violet" });
  }

  if (md.kind === "help") {
    const k = (key: string, what: string) => st.fg("accent", st.bold(key.padEnd(12))) + st.fg("text", what);
    const body = [
      k("↑ ↓  j k", "move through needs-you items and agents"),
      k("tab", "jump to the next section"),
      k("⏎", "zoom the detail pane (again to return)"),
      k("J K  pgup/dn", "scroll the detail pane"),
      k("a", "approve the selected held action (review, then y)"),
      k("d", "deny it, optionally steering the agent elsewhere"),
      k("s", "steer the selected agent (or the hold's agent)"),
      k("b", "steer every agent (broadcast)"),
      k("c", "clear the selected agent's queued steer"),
      k("r", "refresh now"),
      k("q  ^C", "quit"),
      "",
      ...wrap(
        "An approval clears one exact call, once: the deferred call itself, or an identical retry from the same directory. The approve dialog shows the full input and stays locked until you have scrolled through all of it. New holds ring the terminal bell (--quiet to silence).",
        iw,
      ).map((l) => st.dim(l)),
    ];
    return box(st, w, Math.min(h, body.length + 3), [...body, ""], { title: "HELP", focused: true });
  }

  const body = [...md.lines.flatMap((l) => wrap(l, iw)), "", st.dim("press any key")];
  return box(st, w, Math.min(h, body.length + 3), [...body, ""], { title: md.title, focused: true, tone: md.tone });
}

/** A one-line text field with a cursor, scrolled to keep the end visible. */
function field(st: Style, text: string, iw: number): string[] {
  const shown = clean(text);
  const room = iw - 3;
  const tail = width(shown) > room ? "…" + [...shown].slice(-(room - 1)).join("") : shown;
  return [st.fg("accent", "› ") + st.fg("text", tail) + st.inverse(" ")];
}

/* ------------------------------------------------------------- snapshot */

/** Non-interactive `reins watch --once` / piped output: plain, scriptable. */
export function renderSnapshot(m: WatchModel, st: Style, W: number): string {
  const out: string[] = [];
  const repo = path.basename(m.repo) || m.repo;
  out.push(st.bold("reins watch") + "  " + st.fg("accent", clean(repo)) + st.dim(`  ${clock(m.nowMs)}`));
  out.push("");
  const needs = m.holds.length + m.events.length;
  out.push(st.bold(needs ? `NEEDS YOU (${needs})` : "NEEDS YOU — nothing waiting"));
  for (const h of m.holds) {
    const p = h.action;
    out.push(
      `  ◆ ${p.id}  ${clean(p.tool)}  [${clean(p.rule_id)}]  ${clean(h.sessionName)}  waiting ${ago(m.nowMs - Date.parse(p.ts))}`,
    );
    out.push("    " + fit(clean(h.input).replace(/\s+/g, " "), Math.max(20, W - 6)).trimEnd());
    out.push(st.dim(`    reins approve ${p.id}   reins deny ${p.id}`));
  }
  for (const e of m.events) {
    out.push(
      `  ${e.kind === "breach" ? "✖ breach " : "↪ bypass "} ${clean(e.tool)}  [${clean(e.ruleId)}]  ${ago(m.nowMs - Date.parse(e.ts))} ago  ${fit(clean(e.summary).replace(/\s+/g, " "), Math.max(20, W - 50)).trimEnd()}`,
    );
  }
  out.push("");
  if (!m.captured) out.push(st.dim("AGENTS — capture is off (needs node:sqlite, Node ≥ 22.5)"));
  else if (!m.agents.length) out.push(st.dim("AGENTS — none yet"));
  else {
    out.push(st.bold("AGENTS"));
    for (const a of m.agents) {
      const lv = liveness(a, m.nowMs, m.threshold);
      const last = a.trajectory[a.trajectory.length - 1];
      const since = a.lastTsMs != null ? ` ${ago(m.nowMs - a.lastTsMs)}` : "";
      out.push(`  ${LIVE[lv].glyph} ${clean(a.name).padEnd(16)} ${a.id.slice(0, 8)}  ${(lv + since).padEnd(12)} ${String(a.calls).padStart(4)} calls`);
      if (a.steerQueued) out.push(`      ✎ steer queued: ${fit(clean(a.steerQueued), Math.max(20, W - 24)).trimEnd()}`);
      if (last) out.push("      " + fit(`${last.tool}  ${clean(last.summary).replace(/\s+/g, " ")}`, Math.max(20, W - 8)).trimEnd());
    }
  }
  if (m.broadcast) out.push("", st.dim("broadcast steer queued: ") + clean(m.broadcast));
  return out.join("\n");
}

/* --------------------------------------------------------------- helpers */

/** Left and right text on one line of `w` columns; the left side yields. */
function lr(left: string, right: string, w: number): string {
  const rw = width(right);
  if (rw >= w) return fit(right, w);
  return fit(left, w - rw) + right;
}

export function ago(ms: number): string {
  if (!Number.isFinite(ms)) return "?";
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

function clock(ms: number): string {
  const d = new Date(ms);
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, "0")).join(":");
}
