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
exports.cmdWatch = cmdWatch;
const readline = __importStar(require("node:readline"));
const path = __importStar(require("node:path"));
const db_1 = require("../db");
const config_1 = require("../config");
const paths_1 = require("../paths");
const steering_1 = require("../steering");
const holdActions_1 = require("../holdActions");
const model_1 = require("../tui/model");
const term_1 = require("../tui/term");
const render_1 = require("../tui/render");
/**
 * `reins watch` — the cockpit. Every agent in the repo, everything waiting on
 * you, and the controls to answer it: approve or deny a held action, steer one
 * agent or all of them.
 *
 * Approving here is the same act as `reins approve`, through the same code
 * (src/holdActions.ts), with two extra guards a keypress needs and a typed
 * command doesn't: the dialog shows the full input and stays locked until it
 * has been scrolled through, and the action is re-read at the moment of `y`
 * so a stale screen can't approve something nobody reviewed.
 *
 * Nothing listens on a port. The only way in is the keyboard of the person
 * who started it, which is the reason approving lives here and not in the
 * HTML report.
 */
const ESC = "\x1b[";
const ALT_ON = `${ESC}?1049h`;
const ALT_OFF = `${ESC}?1049l`;
const HIDE_CURSOR = `${ESC}?25l`;
const SHOW_CURSOR = `${ESC}?25h`;
const WRAP_OFF = `${ESC}?7l`;
const WRAP_ON = `${ESC}?7h`;
const TITLE_PUSH = `${ESC}22;0t`;
const TITLE_POP = `${ESC}23;0t`;
const TOAST_MS = 6000;
const FLASH_MS = 4000;
async function cmdWatch(args) {
    const intervalSec = parseInterval(args) ?? 2;
    const once = args.includes("--once");
    const quiet = args.includes("--quiet");
    const repo = (0, paths_1.resolveProjectDir)();
    const threshold = (0, config_1.loadConfig)().loopThreshold;
    const interactive = !!(process.stdin.isTTY && process.stdout.isTTY) && !once;
    if (!interactive) {
        // Piped, CI, or --once: one snapshot and exit, so a detached process never spins.
        const st = new term_1.Style((0, term_1.detectColorMode)(!!process.stdout.isTTY));
        const model = (0, model_1.buildWatchModel)((0, db_1.openDbReadOnly)(), repo, threshold);
        process.stdout.write((0, render_1.renderSnapshot)(model, st, process.stdout.columns || 100) + "\n");
        return 0;
    }
    return runCockpit(repo, threshold, intervalSec, quiet);
}
function runCockpit(repo, threshold, intervalSec, quiet) {
    return new Promise((resolve) => {
        const out = process.stdout;
        const stdin = process.stdin;
        const st = new term_1.Style((0, term_1.detectColorMode)(true));
        let db = (0, db_1.openDbReadOnly)();
        let model = (0, model_1.buildWatchModel)(db, repo, threshold);
        const ui = {
            width: out.columns || 100,
            height: out.rows || 30,
            cursor: 0,
            zoom: false,
            detailScroll: 0,
            modal: null,
            toast: null,
            flashUntil: 0,
            intervalSec,
        };
        let toastAt = 0;
        let anchor = (0, render_1.selectedRow)(model, ui);
        let knownHolds = new Set(model.holds.map((h) => h.action.id));
        // The action as it stood when its dialog opened. The model refreshes under
        // an open dialog, so "what was reviewed" has to be kept from that moment.
        let reviewing = null;
        let prevFrame = [];
        let timer = null;
        let closed = false;
        /* ------------------------------------------------------------ data */
        function focusAgentId() {
            const row = (0, render_1.selectedRow)(model, ui);
            return row?.kind === "agent" ? row.id : null;
        }
        function refresh() {
            // runs.db may appear after the cockpit started (first run in a new repo).
            if (!db)
                db = (0, db_1.openDbReadOnly)();
            model = (0, model_1.buildWatchModel)(db, repo, threshold, { focusId: focusAgentId() });
            reanchor();
            const ids = new Set(model.holds.map((h) => h.action.id));
            const fresh = [...ids].filter((id) => !knownHolds.has(id));
            knownHolds = ids;
            if (fresh.length)
                announce(fresh);
            setTitle();
        }
        /** Keep the cursor on the same item across refreshes; clamp if it went away. */
        function reanchor() {
            const rows = (0, render_1.listRows)(model);
            const i = anchor ? rows.findIndex((r) => (0, render_1.sameRow)(r, anchor)) : -1;
            ui.cursor = i >= 0 ? i : Math.max(0, Math.min(ui.cursor, rows.length - 1));
            anchor = rows[ui.cursor] ?? null;
        }
        /**
         * A new hold arrived. Flash the header, ring the bell, and post a desktop
         * notification where the terminal supports one. The selection does NOT
         * move: a list that shifts under the cursor is how the wrong thing gets
         * approved.
         */
        function announce(ids) {
            ui.flashUntil = Date.now() + FLASH_MS;
            const h = (0, render_1.findHold)(model, ids[0]);
            const what = h ? `${h.action.tool}: ${(0, term_1.clean)(h.input).replace(/\s+/g, " ").slice(0, 80)}` : ids[0];
            toast(`◆ new hold ${ids[0]} — ${what}`, "warn");
            if (quiet)
                return;
            out.write("\x07");
            if (supportsOsc9())
                out.write(`\x1b]9;reins: ${ids.length === 1 ? "an action is" : `${ids.length} actions are`} waiting for approval\x07`);
        }
        function setTitle() {
            const n = model.holds.length + model.events.length;
            const name = (0, term_1.clean)(path.basename(repo)).replace(/[\x07\x1b]/g, "");
            out.write(`\x1b]2;${n ? `◆ ${n} · ` : ""}reins watch · ${name}\x07`);
        }
        function toast(text, tone) {
            ui.toast = { text, tone };
            toastAt = Date.now();
        }
        /* ---------------------------------------------------------- output */
        function draw() {
            if (closed)
                return;
            ui.width = out.columns || ui.width;
            ui.height = out.rows || ui.height;
            if (ui.toast && Date.now() - toastAt > TOAST_MS)
                ui.toast = null;
            model.nowMs = Date.now();
            const frame = (0, render_1.renderScreen)(model, ui, st);
            let buf = "";
            for (let i = 0; i < frame.length; i++) {
                if (frame[i] !== prevFrame[i])
                    buf += `${ESC}${i + 1};1H${ESC}0m${frame[i]}${ESC}0m`;
            }
            prevFrame = frame;
            if (buf)
                out.write(buf);
        }
        function tick() {
            if (ui.modal?.kind !== "deny" && ui.modal?.kind !== "steer")
                refresh();
            draw();
        }
        function cleanup() {
            if (closed)
                return;
            closed = true;
            if (timer)
                clearInterval(timer);
            stdin.off("keypress", onKey);
            out.off("resize", onResize);
            try {
                stdin.setRawMode?.(false);
            }
            catch {
                /* not a raw-capable tty */
            }
            stdin.pause();
            out.write(`${ESC}0m` + WRAP_ON + SHOW_CURSOR + ALT_OFF + TITLE_POP);
        }
        function quit() {
            cleanup();
            resolve(0);
        }
        function onResize() {
            prevFrame = [];
            out.write(`${ESC}2J`);
            draw();
        }
        /* --------------------------------------------------------- actions */
        function move(to) {
            const rows = (0, render_1.listRows)(model);
            if (!rows.length)
                return;
            ui.cursor = Math.max(0, Math.min(rows.length - 1, to));
            anchor = rows[ui.cursor];
            ui.detailScroll = 0;
            // The detail pane shows a deep trajectory only for the focused agent.
            if (anchor.kind === "agent")
                model = (0, model_1.buildWatchModel)(db, repo, threshold, { focusId: anchor.id });
        }
        function jumpSection(dir) {
            const rows = (0, render_1.listRows)(model);
            if (!rows.length)
                return;
            const kind = rows[ui.cursor]?.kind;
            const starts = rows.map((r, i) => (i === 0 || rows[i - 1].kind !== r.kind ? i : -1)).filter((i) => i >= 0);
            const cur = starts.filter((i) => rows[i].kind === kind)[0] ?? 0;
            const idx = starts.indexOf(cur);
            move(starts[(idx + dir + starts.length) % starts.length]);
        }
        function openFor(kind) {
            const row = (0, render_1.selectedRow)(model, ui);
            if (row?.kind !== "hold") {
                toast(`select a held action (◆) under NEEDS YOU to ${kind} it`, "muted");
                return;
            }
            reviewing = (0, render_1.findHold)(model, row.id)?.action ?? null;
            ui.modal = kind === "approve" ? { kind, holdId: row.id, scroll: 0 } : { kind, holdId: row.id, text: "" };
        }
        function decide(kind, holdId, text = "") {
            const reviewed = reviewing?.id === holdId ? reviewing : null;
            reviewing = null;
            ui.modal = null;
            if (!reviewed) {
                toast(`${holdId} is no longer pending`, "muted");
                return;
            }
            const check = (0, holdActions_1.reloadForDecision)(holdId, reviewed);
            if (!check.ok) {
                toast(check.reason === "gone"
                    ? `${holdId} was already resolved elsewhere — nothing changed`
                    : `${holdId} changed since you opened it — nothing approved; review it again`, "warn");
                refresh();
                return;
            }
            try {
                if (kind === "approve") {
                    const r = (0, holdActions_1.approveHold)(check.action, "human-tui");
                    if (r.resume) {
                        ui.modal = {
                            kind: "result",
                            title: "APPROVED",
                            tone: "good",
                            lines: [
                                st.fg("good", st.bold(`✓ ${r.id} approved, once.`)),
                                "",
                                "The original call is parked inside the session. Nothing runs until it resumes:",
                                "",
                                st.fg("accent", r.resume),
                            ],
                        };
                    }
                    else {
                        toast(`✓ approved ${r.id} once · the session was steered to retry that exact call`, "good");
                    }
                }
                else {
                    const r = (0, holdActions_1.denyHold)(check.action, text, "human-tui");
                    toast(`✗ refused ${r.id}` + (r.steered ? " · steered the session to your alternative" : ""), "bad");
                }
            }
            catch (e) {
                toast(`could not ${kind} ${holdId}: ${String(e)}`, "bad");
            }
            refresh();
        }
        function submitSteer(target, text) {
            ui.modal = null;
            const msg = text.trim();
            if (!msg) {
                toast("steer cancelled", "muted");
                return;
            }
            try {
                (0, steering_1.appendSteering)(msg, undefined, target ?? undefined);
                toast(target ? `✎ queued for ${target.slice(0, 8)} · lands at its next tool call` : "✎ broadcast queued · the next agent to move gets it", "violet");
            }
            catch (e) {
                toast(`could not queue steering: ${String(e)}`, "bad");
            }
            refresh();
        }
        /* ------------------------------------------------------------ keys */
        function onKey(str, key) {
            if (key?.ctrl && key.name === "c")
                return quit();
            const md = ui.modal;
            if (md)
                onModalKey(md, str, key);
            else
                onMainKey(str, key);
            draw();
        }
        function onMainKey(str, key) {
            const name = key?.name;
            const rows = (0, render_1.listRows)(model);
            const half = Math.max(3, Math.floor(ui.height / 2));
            if (key?.ctrl && name === "d")
                return void (ui.detailScroll += half);
            if (key?.ctrl && name === "u")
                return void (ui.detailScroll = Math.max(0, ui.detailScroll - half));
            if (name === "tab")
                return jumpSection(key.shift ? -1 : 1);
            switch (str === "J" || str === "K" || str === "G" ? str : name ?? str) {
                case "q":
                    return quit();
                case "up":
                case "k":
                    return move(ui.cursor - 1);
                case "down":
                case "j":
                    return move(ui.cursor + 1);
                case "home":
                case "g":
                    return move(0);
                case "end":
                case "G":
                    return move(rows.length - 1);
                case "J":
                case "pagedown":
                    ui.detailScroll += half;
                    return;
                case "K":
                case "pageup":
                    ui.detailScroll = Math.max(0, ui.detailScroll - half);
                    return;
                case "return":
                    ui.zoom = !ui.zoom;
                    ui.detailScroll = 0;
                    return;
                case "escape":
                    ui.zoom = false;
                    ui.toast = null;
                    return;
                case "a":
                    return openFor("approve");
                case "d":
                    return openFor("deny");
                case "s": {
                    const target = (0, render_1.steerTarget)(model, (0, render_1.selectedRow)(model, ui));
                    if (!target)
                        return toast("select an agent to steer, or press b to broadcast", "muted");
                    ui.modal = { kind: "steer", target, text: "" };
                    return;
                }
                case "b":
                    ui.modal = { kind: "steer", target: null, text: "" };
                    return;
                case "c": {
                    const row = (0, render_1.selectedRow)(model, ui);
                    if (row?.kind !== "agent")
                        return;
                    (0, steering_1.clearSteering)(undefined, row.id);
                    toast(`cleared queued steering for ${row.id.slice(0, 8)}`, "muted");
                    return refresh();
                }
                case "r":
                    toast("refreshed", "muted");
                    return refresh();
                default:
                    if (str === "?")
                        ui.modal = { kind: "help" };
            }
        }
        function onModalKey(md, str, key) {
            const name = key?.name;
            if (md.kind === "help" || md.kind === "result") {
                ui.modal = null;
                return;
            }
            if (md.kind === "approve") {
                const { lines, view } = (0, render_1.approveBody)(model, ui, st, md.holdId);
                const max = Math.max(0, lines.length - view);
                switch (name ?? str) {
                    case "escape":
                    case "q":
                    case "n":
                        ui.modal = null;
                        return;
                    case "down":
                    case "j":
                        md.scroll = Math.min(max, md.scroll + 1);
                        return;
                    case "up":
                    case "k":
                        md.scroll = Math.max(0, md.scroll - 1);
                        return;
                    case "space":
                    case "pagedown":
                        md.scroll = Math.min(max, md.scroll + view);
                        return;
                    case "pageup":
                        md.scroll = Math.max(0, md.scroll - view);
                        return;
                    case "y":
                        if (!(0, render_1.approveSeenAll)(model, ui, st, md.holdId, md.scroll)) {
                            toast("read the whole input first — scroll to the end, then y", "warn");
                            return;
                        }
                        return decide("approve", md.holdId);
                    default:
                        return;
                }
            }
            // Text entry: deny's alternative, or a steer.
            if (name === "escape") {
                ui.modal = null;
                toast(md.kind === "deny" ? "deny cancelled — still held" : "steer cancelled", "muted");
                return;
            }
            if (name === "return" || name === "enter") {
                if (md.kind === "deny")
                    return decide("deny", md.holdId, md.text);
                return submitSteer(md.target, md.text);
            }
            if (name === "backspace") {
                md.text = [...md.text].slice(0, -1).join("");
                return;
            }
            if (key?.ctrl && name === "u") {
                md.text = "";
                return;
            }
            if (key?.ctrl && name === "w") {
                md.text = md.text.replace(/\s*\S+\s*$/, "");
                return;
            }
            if (str && !key?.ctrl && !key?.meta && !/[\x00-\x1f\x7f]/.test(str))
                md.text += str;
        }
        /* ----------------------------------------------------------- start */
        out.write(TITLE_PUSH + ALT_ON + HIDE_CURSOR + WRAP_OFF + `${ESC}2J`);
        readline.emitKeypressEvents(stdin);
        try {
            stdin.setRawMode?.(true);
        }
        catch {
            /* best-effort */
        }
        stdin.resume();
        stdin.on("keypress", onKey);
        out.on("resize", onResize);
        process.on("exit", cleanup);
        for (const sig of ["SIGTERM", "SIGHUP"])
            process.once(sig, quit);
        setTitle();
        draw();
        timer = setInterval(tick, Math.max(500, intervalSec * 1000));
    });
}
/** Terminals known to show OSC 9 as a desktop notification. Elsewhere, the bell. */
function supportsOsc9(env = process.env) {
    const tp = env.TERM_PROGRAM || "";
    return tp === "iTerm.app" || tp === "WezTerm" || tp === "ghostty";
}
function parseInterval(args) {
    const i = args.findIndex((a) => a === "-n" || a === "--interval");
    if (i >= 0 && args[i + 1]) {
        const n = parseFloat(args[i + 1]);
        if (Number.isFinite(n) && n > 0)
            return n;
    }
    return undefined;
}
