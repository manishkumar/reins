"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.MIN_H = exports.MIN_W = void 0;
exports.eventKey = eventKey;
exports.listRows = listRows;
exports.selectedRow = selectedRow;
exports.sameRow = sameRow;
exports.findHold = findHold;
exports.steerTarget = steerTarget;
exports.renderScreen = renderScreen;
exports.detailContent = detailContent;
exports.holdDetail = holdDetail;
exports.modalSize = modalSize;
exports.approveBody = approveBody;
exports.approveSeenAll = approveSeenAll;
exports.renderSnapshot = renderSnapshot;
exports.ago = ago;
const path = __importStar(require("node:path"));
const term_1 = require("./term");
const model_1 = require("./model");
exports.MIN_W = 60;
exports.MIN_H = 14;
const WIDE = 104;
/* ------------------------------------------------------------- selection */
function eventKey(e) {
    return `${e.kind}:${e.sessionId}:${e.ts}`;
}
/** The cursor walks one list: holds, then events, then agents. */
function listRows(m) {
    return [
        ...m.holds.map((h) => ({ kind: "hold", id: h.action.id })),
        ...m.events.map((e) => ({ kind: "event", key: eventKey(e) })),
        ...m.agents.map((a) => ({ kind: "agent", id: a.id })),
    ];
}
function selectedRow(m, ui) {
    const rows = listRows(m);
    return rows.length ? rows[Math.max(0, Math.min(rows.length - 1, ui.cursor))] : null;
}
function sameRow(a, b) {
    if (!a || !b || a.kind !== b.kind)
        return false;
    return a.kind === "event" ? a.key === b.key : a.id === b.id;
}
function findHold(m, id) {
    return m.holds.find((h) => h.action.id === id);
}
/** The agent a steer from the current selection would go to. */
function steerTarget(m, row) {
    if (!row)
        return null;
    if (row.kind === "agent")
        return row.id;
    if (row.kind === "hold")
        return findHold(m, row.id)?.action.session_id ?? null;
    return m.events.find((e) => eventKey(e) === row.key)?.sessionId ?? null;
}
/* ---------------------------------------------------------------- screen */
function renderScreen(m, ui, st) {
    const W = ui.width;
    const H = ui.height;
    if (W < exports.MIN_W || H < exports.MIN_H) {
        const msg = `reins watch needs at least ${exports.MIN_W}×${exports.MIN_H} (now ${W}×${H})`;
        const out = new Array(H).fill(" ".repeat(W));
        out[Math.floor(H / 2)] = (0, term_1.fit)(" ".repeat(Math.max(0, Math.floor((W - msg.length) / 2))) + msg, W);
        return out;
    }
    const B = H - 3;
    const row = selectedRow(m, ui);
    let body;
    if (ui.zoom) {
        body = detailBox(m, ui, st, row, W, B, true);
    }
    else if (W >= WIDE) {
        const L = Math.max(48, Math.min(72, Math.floor(W * 0.44)));
        body = (0, term_1.hjoin)(leftColumn(m, ui, st, row, L, B), detailBox(m, ui, st, row, W - L, B, false));
    }
    else {
        body = leftColumn(m, ui, st, row, W, B);
    }
    let screen = [header(m, ui, st, W), ...body, statusLine(ui, st, W), hints(m, ui, st, row, W)];
    if (ui.modal) {
        // Dim everything behind the dialog except the hint bar, which is still live.
        const behind = screen.slice(0, -1).map((l) => (0, term_1.fit)(l, W));
        screen = [...(0, term_1.overlay)(behind, modalBox(m, ui, st), W, (s) => st.fg("faint", s)), screen[screen.length - 1]];
    }
    return screen.map((l) => (0, term_1.fit)(l, W));
}
function header(m, ui, st, W) {
    const repo = path.basename(m.repo) || m.repo;
    const counts = { active: 0, looping: 0, idle: 0, done: 0 };
    for (const a of m.agents)
        counts[(0, model_1.liveness)(a, m.nowMs, m.threshold)]++;
    const needs = m.holds.length + m.events.length;
    const flashing = ui.flashUntil > m.nowMs;
    const needsPill = needs
        ? flashing
            ? st.inverse(st.fg("bad", st.bold(` ◆ ${needs} NEEDS YOU `)))
            : st.pill(m.holds.length ? "warn" : "bad", `◆ ${needs} needs you`)
        : st.fg("good", "✓ all clear");
    const parts = [
        st.fg("accent", st.bold("◆ reins")) + st.dim(" watch ") + st.fg("text", st.bold((0, term_1.clean)(repo))),
        needsPill,
        counts.active ? st.fg("good", `● ${counts.active} active`) : "",
        counts.looping ? st.fg("bad", `⟳ ${counts.looping} looping`) : "",
        counts.idle ? st.dim(`○ ${counts.idle} idle`) : "",
    ].filter(Boolean);
    const left = " " + parts.join(st.fg("faint", "  │  "));
    const right = (m.captured ? "" : st.fg("warn", "capture off") + st.dim(" · ")) +
        st.dim(`every ${ui.intervalSec}s · `) +
        st.fg("text", clock(m.nowMs)) +
        " ";
    return lr(left, right, W);
}
function statusLine(ui, st, W) {
    if (!ui.toast)
        return " ".repeat(W);
    return (0, term_1.fit)(" " + st.fg(ui.toast.tone, ui.toast.text), W);
}
function hints(m, ui, st, row, W) {
    const k = (key, label) => st.fg("accent", st.bold(key)) + " " + st.dim(label);
    let keys;
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
    }
    else {
        keys = [k("↑↓", "move"), k("tab", "section")];
        if (row?.kind === "hold")
            keys.push(k("a", "approve"), k("d", "deny"));
        if (row)
            keys.push(k("s", "steer"));
        keys.push(k("b", "broadcast"));
        if (row?.kind === "agent" && m.agents.find((a) => a.id === row.id)?.steerQueued)
            keys.push(k("c", "clear steer"));
        keys.push(k("⏎", ui.zoom ? "unzoom" : "zoom"), k("?", "help"), k("q", "quit"));
    }
    return (0, term_1.fit)(" " + keys.join("   "), W);
}
/* ----------------------------------------------------------- left column */
function leftColumn(m, ui, st, row, w, h) {
    const needItems = m.holds.length + m.events.length;
    const needsH = needItems === 0 ? 3 : Math.min(needItems * 2 + 2, Math.max(6, Math.floor(h * 0.5)));
    const agentsH = h - needsH;
    const iw = w - 4;
    const needLines = [
        ...m.holds.map((hv) => holdItem(hv, m, st, iw, row?.kind === "hold" && row.id === hv.action.id)),
        ...m.events.map((e) => eventItem(e, m, st, iw, row?.kind === "event" && row.key === eventKey(e))),
    ];
    const selNeed = row && row.kind !== "agent" ? listRows(m).findIndex((r) => sameRow(r, row)) : -1;
    const needsFocused = selNeed >= 0 && !ui.zoom;
    const needsBody = needItems
        ? windowed(needLines, selNeed, needsH - 2)
        : { lines: [st.fg("good", "✓ nothing is waiting on you")], hidden: 0 };
    const olderNote = m.olderEvents ? `${m.olderEvents} older in audit --guards` : undefined;
    const needs = (0, term_1.box)(st, w, needsH, needsBody.lines, {
        title: "NEEDS YOU",
        badge: needItems ? st.fg(m.holds.length ? "warn" : "bad", st.bold(String(needItems))) : undefined,
        focused: needsFocused,
        tone: needsFocused ? "warn" : "faint",
        footer: needsBody.hidden ? `+${needsBody.hidden} more` : olderNote,
    });
    const agentLines = m.agents.map((a) => agentItem(a, m, st, iw, row?.kind === "agent" && row.id === a.id));
    const selAgent = row?.kind === "agent" ? m.agents.findIndex((a) => a.id === row.id) : -1;
    let agentsBody;
    if (!m.captured) {
        agentsBody = {
            lines: [
                st.fg("warn", "capture is off"),
                ...(0, term_1.wrap)("The agent list needs node:sqlite (Node ≥ 22.5). Holds, steering and guards work without it.", iw).map((l) => st.dim(l)),
            ],
            hidden: 0,
        };
    }
    else if (!m.agents.length) {
        agentsBody = { lines: [st.dim("No sessions yet. Start an agent in this repo.")], hidden: 0 };
    }
    else {
        agentsBody = windowed(agentLines, selAgent, agentsH - 2);
    }
    const agents = (0, term_1.box)(st, w, agentsH, agentsBody.lines, {
        title: "AGENTS",
        badge: m.agents.length ? st.dim(String(m.agents.length)) : undefined,
        focused: selAgent >= 0 && !ui.zoom,
        footer: agentsBody.hidden ? `+${agentsBody.hidden} more` : undefined,
    });
    return [...needs, ...agents];
}
/** Keep the selected multi-line item in view; report how many didn't fit. */
function windowed(items, sel, rows) {
    if (!items.length || rows <= 0)
        return { lines: [], hidden: items.length };
    const per = items[0].length;
    const fits = Math.max(1, Math.floor(rows / per));
    let start = 0;
    if (sel >= fits)
        start = sel - fits + 1;
    const shown = items.slice(start, start + fits);
    return { lines: shown.flat(), hidden: items.length - shown.length };
}
function selected(st, lines, on, iw, tone = "accent") {
    return lines.map((l, i) => {
        const bar = on ? st.fg(tone, i === 0 ? "▌" : "▌") : " ";
        const body = (0, term_1.fit)(bar + l, iw);
        return on ? st.bg("selBg", body) : body;
    });
}
function holdItem(h, m, st, iw, on) {
    const p = h.action;
    const age = ago(m.nowMs - Date.parse(p.ts));
    const l1 = lr(st.fg("warn", st.bold("◆ HELD ")) + st.fg("text", st.bold((0, term_1.clean)(p.tool))) + "  " + st.dim((0, term_1.clean)(p.rule_id)), st.dim(`${clip((0, term_1.clean)(h.sessionLabel ?? h.sessionName), Math.floor(iw / 2) - 6)} · `) + st.fg("warn", age), iw - 1);
    const first = (0, term_1.clean)(h.input).replace(/\s+/g, " ").trim();
    const l2 = "  " + st.fg("text", first);
    return selected(st, [l1, l2], on, iw, "warn");
}
function eventItem(e, m, st, iw, on) {
    const breach = e.kind === "breach";
    const tone = breach ? "bad" : "warn";
    const label = breach ? "✖ HOLD BREACHED " : "↪ WORKED AROUND ";
    const l1 = lr(st.fg(tone, st.bold(label)) + st.fg("text", (0, term_1.clean)(e.tool)) + (e.ruleId ? "  " + st.dim((0, term_1.clean)(e.ruleId)) : ""), st.dim(ago(m.nowMs - Date.parse(e.ts)) + " ago"), iw - 1);
    const l2 = "  " + st.dim((0, term_1.clean)(e.summary).replace(/\s+/g, " "));
    return selected(st, [l1, l2], on, iw, tone);
}
const LIVE = {
    active: { glyph: "●", tone: "good", label: "active" },
    looping: { glyph: "⟳", tone: "bad", label: "looping" },
    idle: { glyph: "○", tone: "muted", label: "idle" },
    done: { glyph: "✓", tone: "muted", label: "done" },
};
function agentItem(a, m, st, iw, on) {
    const lv = (0, model_1.liveness)(a, m.nowMs, m.threshold);
    const L = LIVE[lv];
    const since = a.lastTsMs != null ? ago(m.nowMs - a.lastTsMs) : "—";
    const spark = st.fg(lv === "active" || lv === "looping" ? "accent" : "faint", (0, term_1.sparkline)(a.spark.slice(-12)));
    const l1 = lr(st.fg(L.tone, L.glyph) +
        " " +
        st.fg("text", st.bold((0, term_1.clean)(a.label ?? a.name))) +
        "  " +
        st.fg(L.tone, lv === "idle" ? `idle ${since}` : L.label), spark + " " + st.dim(`${a.calls}`.padStart(4)), iw - 1);
    // Who it is and what it was asked: the mnemonic and short id are how you
    // address it, the branch and prompt are how you recognise it.
    const l2 = "  " +
        st.dim((a.label ?? a.name) === a.name ? a.id.slice(0, 8) : `${(0, term_1.clean)(a.name)} ${a.id.slice(0, 8)}`) +
        (a.branch ? st.fg("faint", " · ") + st.fg("accent", "⎇ " + (0, term_1.clean)(a.branch)) : "") +
        (a.asked ? st.fg("faint", " · ") + st.dim("❯ " + (0, term_1.clean)(a.asked)) : "");
    let l3;
    if (a.holds)
        l3 = "  " + st.fg("warn", `◆ ${a.holds} held, waiting on you`);
    else if (a.steerQueued)
        l3 = "  " + st.fg("violet", "✎ steer queued: ") + st.dim((0, term_1.clean)(a.steerQueued).replace(/\s+/g, " "));
    else {
        const last = a.trajectory[a.trajectory.length - 1];
        l3 = last ? "  " + callInline(last, st, m.threshold) : "  " + st.dim("(no calls yet)");
    }
    return selected(st, [l1, l2, l3], on, iw);
}
/** How a session is named in a detail line: its label, then the name and id that address it. */
function sessionLine(label, name, id) {
    const l = (0, term_1.clean)(label ?? name);
    const n = (0, term_1.clean)(name);
    return l === n ? `${n} (${id.slice(0, 8)})` : `${l} · ${n} (${id.slice(0, 8)})`;
}
function clip(s, cols) {
    const max = Math.max(8, cols);
    return (0, term_1.width)(s) <= max ? s : (0, term_1.fit)(s, max - 1).trimEnd() + "…";
}
const KIND = {
    ok: { glyph: "›", tone: "muted" },
    failed: { glyph: "✗", tone: "warn" },
    denied: { glyph: "⊘", tone: "bad" },
    asked: { glyph: "?", tone: "warn" },
    held: { glyph: "◆", tone: "warn" },
    approved: { glyph: "✓", tone: "good" },
    refused: { glyph: "✗", tone: "bad" },
};
function callInline(c, st, threshold) {
    const K = KIND[c.kind];
    const repeat = c.streak > 1 ? " " + st.fg(c.streak >= threshold ? "bad" : "muted", `×${c.streak}`) : "";
    const text = (0, term_1.clean)(c.summary).replace(/\s+/g, " ");
    return (st.fg(K.tone, K.glyph) +
        " " +
        st.dim((0, term_1.clean)(c.tool).padEnd(6)) +
        " " +
        (c.kind === "ok" ? st.fg("text", text) : st.fg(K.tone, text)) +
        repeat);
}
/* ---------------------------------------------------------------- detail */
function detailBox(m, ui, st, row, w, h, focused) {
    const iw = w - 4;
    const { title, tone, lines } = detailContent(m, st, row, iw);
    const view = h - 2;
    const maxScroll = Math.max(0, lines.length - view);
    const scroll = Math.min(ui.detailScroll, maxScroll);
    const shown = lines.slice(scroll, scroll + view);
    const below = lines.length - scroll - shown.length;
    const footer = maxScroll === 0 ? undefined : below > 0 ? `↓ ${below} more · J/K scroll` : scroll > 0 ? `↑ ${scroll} above` : undefined;
    return (0, term_1.box)(st, w, h, shown, { title, focused, tone: focused ? tone : "faint", footer });
}
/** What the detail pane says about the selection. Exported for the approve modal's line count. */
function detailContent(m, st, row, iw) {
    if (!row) {
        return {
            title: "DETAIL",
            tone: "accent",
            lines: [
                st.dim("Nothing selected."),
                "",
                ...(0, term_1.wrap)("Agents appear here once they run in this repo with reins installed. Held actions appear under NEEDS YOU the moment a hold rule parks one.", iw).map((l) => st.dim(l)),
            ],
        };
    }
    if (row.kind === "hold") {
        const h = findHold(m, row.id);
        if (h)
            return { title: `HELD · ${h.action.id}`, tone: "warn", lines: holdDetail(h, m, st, iw) };
    }
    if (row.kind === "event") {
        const e = m.events.find((x) => eventKey(x) === row.key);
        if (e)
            return { title: e.kind === "breach" ? "HOLD BREACHED" : "GUARD WORKED AROUND", tone: e.kind === "breach" ? "bad" : "warn", lines: eventDetail(e, m, st, iw) };
    }
    if (row.kind === "agent") {
        const a = m.agents.find((x) => x.id === row.id);
        if (a)
            return { title: `AGENT · ${clip((0, term_1.clean)(a.label ?? a.name), iw - 12)}`, tone: "accent", lines: agentDetail(a, m, st, iw) };
    }
    return { title: "DETAIL", tone: "accent", lines: [st.dim("(gone)")] };
}
function kv(st, key, value, iw, tone = "text") {
    const pad = 11;
    const wrapped = (0, term_1.wrap)(value, Math.max(10, iw - pad));
    return wrapped.map((l, i) => (i === 0 ? st.dim(key.padEnd(pad)) : " ".repeat(pad)) + st.fg(tone, l));
}
function rule(st, label, iw) {
    const t = ` ${label} `;
    return st.fg("faint", "──") + st.dim(t) + st.fg("faint", "─".repeat(Math.max(0, iw - 2 - (0, term_1.width)(t))));
}
/** The proposed input with a gutter, so its edges are unambiguous. */
function inputBlock(st, input, iw) {
    const lines = (0, term_1.wrap)((0, term_1.clean)(input, true), iw - 2);
    return lines.map((l) => st.fg("warn", "┃ ") + st.fg("text", l));
}
function holdDetail(h, m, st, iw) {
    const p = h.action;
    const waited = ago(m.nowMs - Date.parse(p.ts));
    const out = [
        ...kv(st, "rule", (0, term_1.clean)(p.rule_id), iw, "warn"),
        ...kv(st, "reason", (0, term_1.clean)(p.reason), iw),
        ...kv(st, "session", sessionLine(h.sessionLabel, h.sessionName, p.session_id), iw),
        ...(h.asked ? kv(st, "asked", (0, term_1.clean)(h.asked), iw, "muted") : []),
        ...kv(st, "directory", h.where ? (0, term_1.clean)(h.where) : "project root", iw),
        ...kv(st, "waiting", `${waited} (since ${new Date(p.ts).toLocaleString()})`, iw),
        ...kv(st, "transport", p.transport === "defer"
            ? "defer — the original call is parked in the session; approving runs it when the session resumes"
            : "deny — approving lets the identical retry, from the same directory, through once", iw, "muted"),
    ];
    if (h.superseded) {
        out.push("", ...(0, term_1.wrap)("⚠ superseded: this session deferred a newer call. Only the newest is replayed on resume.", iw).map((l) => st.fg("bad", l)));
    }
    out.push("", rule(st, `proposed ${(0, term_1.clean)(p.tool)} input`, iw), ...inputBlock(st, h.input, iw));
    out.push("", st.fg("accent", st.bold("a")) + st.dim(" approve once   ") + st.fg("accent", st.bold("d")) + st.dim(" deny, optionally with what to do instead"));
    return out;
}
function eventDetail(e, m, st, iw) {
    const breach = e.kind === "breach";
    const out = [
        ...kv(st, "when", `${ago(m.nowMs - Date.parse(e.ts))} ago (${new Date(e.ts).toLocaleString()})`, iw),
        ...kv(st, "session", e.sessionId.slice(0, 8), iw),
        ...(e.ruleId ? kv(st, breach ? "hold" : "rule", (0, term_1.clean)(e.ruleId), iw, "warn") : []),
        ...kv(st, "detail", (0, term_1.clean)(e.detail), iw),
        "",
        rule(st, breach ? "executed while parked" : "ran anyway", iw),
        ...inputBlock(st, e.summary, iw),
        "",
        ...(0, term_1.wrap)(breach
            ? "A call waiting for approval executed. Claude Code ignores defer outside print mode and for parallel tool calls; set holdTransport to \"deny\" in .reins/config.json for the transport that always holds."
            : `A command this rule denied ran again in a near-identical form. Either the rule is too broad for this repo (reins guard remove ${e.ruleId}) or it should be a hold instead of a deny. reins does not widen the guard in response.`, iw).map((l) => st.dim(l)),
    ];
    return out;
}
function agentDetail(a, m, st, iw) {
    const lv = (0, model_1.liveness)(a, m.nowMs, m.threshold);
    const L = LIVE[lv];
    const out = [
        ...kv(st, "status", `${L.glyph} ${L.label}${lv !== "active" && a.lastTsMs != null ? `, last call ${ago(m.nowMs - a.lastTsMs)} ago` : ""}`, iw, L.tone),
        ...kv(st, "session", `${(0, term_1.clean)(a.name)} · ${a.id}`, iw, "muted"),
        ...(a.branch ? kv(st, "branch", (0, term_1.clean)(a.branch), iw, "accent") : []),
        ...(a.asked ? kv(st, "asked", (0, term_1.clean)(a.asked), iw) : []),
        ...kv(st, "calls", String(a.calls) + (a.startedMs != null ? ` since ${new Date(a.startedMs).toLocaleString()}` : ""), iw),
    ];
    if (a.streak > 1) {
        out.push(...kv(st, "repeating", `the last call ×${a.streak} in a row${a.streak >= m.threshold ? " (loop alarm fired)" : ""}`, iw, a.streak >= m.threshold ? "bad" : "warn"));
    }
    if (a.steerQueued)
        out.push(...kv(st, "steer", (0, term_1.clean)(a.steerQueued), iw, "violet"));
    if (a.holds)
        out.push(...kv(st, "held", `${a.holds} action${a.holds === 1 ? "" : "s"} waiting on you`, iw, "warn"));
    const mins = Math.round((model_1.SPARK_BUCKETS * model_1.SPARK_BUCKET_MS) / 60000);
    const bars = a.spark;
    const peak = Math.max(0, ...bars);
    out.push("", rule(st, `activity · last ${mins}m`, iw), st.fg(lv === "active" || lv === "looping" ? "accent" : "muted", stretch((0, term_1.sparkline)(bars), Math.min(iw, model_1.SPARK_BUCKETS * 2))) +
        st.dim(peak ? `  peak ${peak}/${model_1.SPARK_BUCKET_MS / 1000}s` : "  quiet"), "", rule(st, "trajectory · newest first", iw));
    if (!a.trajectory.length)
        out.push(st.dim("(no calls yet)"));
    for (const c of a.trajectory.slice().reverse()) {
        const t = c.tsMs != null ? st.fg("faint", clock(c.tsMs)) + " " : "";
        out.push(t + callInline(c, st, m.threshold) + (c.ruleId ? " " + st.dim(`[${(0, term_1.clean)(c.ruleId)}]`) : ""));
    }
    return out;
}
/** Repeat each sparkline cell so a 24-bucket line fills a wider pane. */
function stretch(s, cols) {
    const chars = [...s];
    if (!chars.length)
        return s;
    const k = Math.max(1, Math.floor(cols / chars.length));
    return chars.map((c) => c.repeat(k)).join("");
}
/* ---------------------------------------------------------------- modals */
function modalSize(ui) {
    return { w: Math.min(ui.width - 4, 100), h: ui.height - 4 };
}
/** Lines of the approve modal's scrollable body, and how many fit. */
function approveBody(m, ui, st, holdId) {
    const { w, h } = modalSize(ui);
    const hv = findHold(m, holdId);
    const iw = w - 4;
    if (!hv)
        return { lines: [st.dim("This action is no longer pending.")], view: 1 };
    const p = hv.action;
    const lines = [
        ...kv(st, "rule", (0, term_1.clean)(p.rule_id), iw, "warn"),
        ...kv(st, "reason", (0, term_1.clean)(p.reason), iw),
        ...kv(st, "session", sessionLine(hv.sessionLabel, hv.sessionName, p.session_id), iw),
        ...kv(st, "directory", hv.where ? (0, term_1.clean)(hv.where) : "project root", iw),
        "",
        rule(st, `${(0, term_1.clean)(p.tool)} · the exact input you are approving`, iw),
        ...inputBlock(st, hv.input, iw),
    ];
    // Around the scrolled lines: two borders, the heading and its gap, a gap and the action line.
    return { lines, view: Math.min(h - 6, lines.length) };
}
function approveSeenAll(m, ui, st, holdId, scroll) {
    const { lines, view } = approveBody(m, ui, st, holdId);
    return scroll + view >= lines.length;
}
function modalBox(m, ui, st) {
    const md = ui.modal;
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
        while (body.length < boxH - 3)
            body.push("");
        body.push(seen
            ? st.fg("good", st.bold("y")) + st.dim(" approve once    ") + st.fg("accent", st.bold("esc")) + st.dim(" cancel")
            : st.fg("warn", `↓ ${lines.length - scroll - view} more lines — read to the end to enable approve (j / space)`));
        return (0, term_1.box)(st, w, boxH, body, { title: "APPROVE", focused: true, tone: "warn" });
    }
    if (md.kind === "deny") {
        const hv = findHold(m, md.holdId);
        const preview = hv ? (0, term_1.wrap)((0, term_1.clean)(hv.input, true), iw - 2).slice(0, 6) : [];
        const body = [
            st.fg("bad", st.bold("Refuse this action.")) + st.dim(" The agent is told at its next attempt."),
            "",
            ...preview.map((l) => st.fg("faint", "┃ ") + st.dim(l)),
            ...(hv && (0, term_1.wrap)((0, term_1.clean)(hv.input, true), iw - 2).length > 6 ? [st.dim("  …")] : []),
            "",
            st.fg("text", "What should it do instead? ") + st.dim("(optional — sent as steering)"),
            ...field(st, md.text, iw),
        ];
        return (0, term_1.box)(st, w, Math.min(h, body.length + 3), [...body, ""], { title: "DENY", focused: true, tone: "bad" });
    }
    if (md.kind === "steer") {
        const a = md.target ? m.agents.find((x) => x.id === md.target) : null;
        const who = md.target ? (a ? sessionLine(a.label, a.name, a.id) : md.target.slice(0, 8)) : "every agent (broadcast)";
        const queued = md.target ? a?.steerQueued : m.broadcast;
        const body = [
            st.fg("violet", st.bold("Steer ")) + st.fg("text", st.bold(who)),
            ...(0, term_1.wrap)("A nudge the agent weighs at its next tool call — added spec, not an order. For a hard never, use a guard.", iw).map((l) => st.dim(l)),
            ...(queued ? ["", ...kv(st, "queued", (0, term_1.clean)(queued), iw, "violet"), st.dim("New text is appended; nothing queued is dropped.")] : []),
            "",
            ...field(st, md.text, iw),
        ];
        return (0, term_1.box)(st, w, Math.min(h, body.length + 3), [...body, ""], { title: "STEER", focused: true, tone: "violet" });
    }
    if (md.kind === "help") {
        const k = (key, what) => st.fg("accent", st.bold(key.padEnd(12))) + st.fg("text", what);
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
            ...(0, term_1.wrap)("An approval clears one exact call, once: the deferred call itself, or an identical retry from the same directory. The approve dialog shows the full input and stays locked until you have scrolled through all of it. New holds ring the terminal bell (--quiet to silence).", iw).map((l) => st.dim(l)),
        ];
        return (0, term_1.box)(st, w, Math.min(h, body.length + 3), [...body, ""], { title: "HELP", focused: true });
    }
    const body = [...md.lines.flatMap((l) => (0, term_1.wrap)(l, iw)), "", st.dim("press any key")];
    return (0, term_1.box)(st, w, Math.min(h, body.length + 3), [...body, ""], { title: md.title, focused: true, tone: md.tone });
}
/** A one-line text field with a cursor, scrolled to keep the end visible. */
function field(st, text, iw) {
    const shown = (0, term_1.clean)(text);
    const room = iw - 3;
    const tail = (0, term_1.width)(shown) > room ? "…" + [...shown].slice(-(room - 1)).join("") : shown;
    return [st.fg("accent", "› ") + st.fg("text", tail) + st.inverse(" ")];
}
/* ------------------------------------------------------------- snapshot */
/** Non-interactive `reins watch --once` / piped output: plain, scriptable. */
function renderSnapshot(m, st, W) {
    const out = [];
    const repo = path.basename(m.repo) || m.repo;
    out.push(st.bold("reins watch") + "  " + st.fg("accent", (0, term_1.clean)(repo)) + st.dim(`  ${clock(m.nowMs)}`));
    out.push("");
    const needs = m.holds.length + m.events.length;
    out.push(st.bold(needs ? `NEEDS YOU (${needs})` : "NEEDS YOU — nothing waiting"));
    for (const h of m.holds) {
        const p = h.action;
        out.push(`  ◆ ${p.id}  ${(0, term_1.clean)(p.tool)}  [${(0, term_1.clean)(p.rule_id)}]  ${(0, term_1.clean)(h.sessionLabel ?? h.sessionName)}  waiting ${ago(m.nowMs - Date.parse(p.ts))}`);
        out.push("    " + (0, term_1.fit)((0, term_1.clean)(h.input).replace(/\s+/g, " "), Math.max(20, W - 6)).trimEnd());
        out.push(st.dim(`    reins approve ${p.id}   reins deny ${p.id}`));
    }
    for (const e of m.events) {
        out.push(`  ${e.kind === "breach" ? "✖ breach " : "↪ bypass "} ${(0, term_1.clean)(e.tool)}  [${(0, term_1.clean)(e.ruleId)}]  ${ago(m.nowMs - Date.parse(e.ts))} ago  ${(0, term_1.fit)((0, term_1.clean)(e.summary).replace(/\s+/g, " "), Math.max(20, W - 50)).trimEnd()}`);
    }
    out.push("");
    if (!m.captured)
        out.push(st.dim("AGENTS — capture is off (needs node:sqlite, Node ≥ 22.5)"));
    else if (!m.agents.length)
        out.push(st.dim("AGENTS — none yet"));
    else {
        out.push(st.bold("AGENTS"));
        for (const a of m.agents) {
            const lv = (0, model_1.liveness)(a, m.nowMs, m.threshold);
            const last = a.trajectory[a.trajectory.length - 1];
            const since = a.lastTsMs != null ? ` ${ago(m.nowMs - a.lastTsMs)}` : "";
            out.push(`  ${LIVE[lv].glyph} ${(0, term_1.clean)(a.name).padEnd(16)} ${a.id.slice(0, 8)}  ${(lv + since).padEnd(12)} ${String(a.calls).padStart(4)} calls`);
            const about = [a.label && a.label !== a.name ? (0, term_1.clean)(a.label) : "", a.branch ? "⎇ " + (0, term_1.clean)(a.branch) : "", a.asked ? "❯ " + (0, term_1.clean)(a.asked) : ""].filter(Boolean);
            if (about.length)
                out.push("      " + (0, term_1.fit)(about.join(" · "), Math.max(20, W - 8)).trimEnd());
            if (a.steerQueued)
                out.push(`      ✎ steer queued: ${(0, term_1.fit)((0, term_1.clean)(a.steerQueued), Math.max(20, W - 24)).trimEnd()}`);
            if (last)
                out.push("      " + (0, term_1.fit)(`${last.tool}  ${(0, term_1.clean)(last.summary).replace(/\s+/g, " ")}`, Math.max(20, W - 8)).trimEnd());
        }
    }
    if (m.broadcast)
        out.push("", st.dim("broadcast steer queued: ") + (0, term_1.clean)(m.broadcast));
    return out.join("\n");
}
/* --------------------------------------------------------------- helpers */
/** Left and right text on one line of `w` columns; the left side yields. */
function lr(left, right, w) {
    const rw = (0, term_1.width)(right);
    if (rw >= w)
        return (0, term_1.fit)(right, w);
    return (0, term_1.fit)(left, w - rw) + right;
}
function ago(ms) {
    if (!Number.isFinite(ms))
        return "?";
    const s = Math.max(0, Math.round(ms / 1000));
    if (s < 60)
        return `${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60)
        return `${m}m`;
    const h = Math.floor(m / 60);
    if (h < 48)
        return `${h}h ${m % 60}m`;
    return `${Math.floor(h / 24)}d ${h % 24}h`;
}
function clock(ms) {
    const d = new Date(ms);
    return [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, "0")).join(":");
}
