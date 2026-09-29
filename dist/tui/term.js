"use strict";
/**
 * Terminal primitives for `reins watch`: display width, sanitizing, styling,
 * fitting, wrapping, and boxes. No dependencies — this is the part a TUI
 * library would normally provide, cut down to what the cockpit uses.
 *
 * Everything the cockpit shows from an agent run (commands, paths, steering)
 * is untrusted text. It goes through `clean()` before it reaches the screen,
 * because a command containing escape sequences would otherwise be executed
 * by the user's terminal: set the clipboard (OSC 52), retitle the window, or
 * paint over the approval prompt.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.Style = void 0;
exports.clean = clean;
exports.charWidth = charWidth;
exports.width = width;
exports.fit = fit;
exports.wrap = wrap;
exports.detectColorMode = detectColorMode;
exports.box = box;
exports.hjoin = hjoin;
exports.columns = columns;
exports.overlay = overlay;
exports.sparkline = sparkline;
const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
/** Strip control characters from untrusted text. Tabs become spaces; newlines
 *  are kept only when `keepNewlines` (for wrapped multi-line views). */
function clean(s, keepNewlines = false) {
    let out = "";
    for (const ch of s) {
        const cp = ch.codePointAt(0);
        if (ch === "\r")
            continue;
        if (ch === "\n" && keepNewlines)
            out += "\n";
        else if (ch === "\t")
            out += "  ";
        else if (cp < 0x20 || cp === 0x7f || (cp >= 0x80 && cp < 0xa0))
            out += cp === 0x1b ? "␛" : keepNewlines || ch !== "\n" ? "·" : " ";
        else
            out += ch;
    }
    return out;
}
/** Columns a code point occupies in a typical modern terminal. */
function charWidth(cp) {
    if (cp === 0)
        return 0;
    // Combining marks, zero-width joiners/spaces, variation selectors.
    if ((cp >= 0x0300 && cp <= 0x036f) ||
        (cp >= 0x200b && cp <= 0x200f) ||
        (cp >= 0xfe00 && cp <= 0xfe0f) ||
        (cp >= 0x1ab0 && cp <= 0x1aff) ||
        (cp >= 0x20d0 && cp <= 0x20ff)) {
        return 0;
    }
    if ((cp >= 0x1100 && cp <= 0x115f) ||
        (cp >= 0x2e80 && cp <= 0x303e) ||
        (cp >= 0x3041 && cp <= 0x33ff) ||
        (cp >= 0x3400 && cp <= 0x4dbf) ||
        (cp >= 0x4e00 && cp <= 0x9fff) ||
        (cp >= 0xa000 && cp <= 0xa4cf) ||
        (cp >= 0xac00 && cp <= 0xd7a3) ||
        (cp >= 0xf900 && cp <= 0xfaff) ||
        (cp >= 0xfe30 && cp <= 0xfe4f) ||
        (cp >= 0xff00 && cp <= 0xff60) ||
        (cp >= 0xffe0 && cp <= 0xffe6) ||
        (cp >= 0x1f300 && cp <= 0x1f64f) ||
        (cp >= 0x1f900 && cp <= 0x1f9ff) ||
        (cp >= 0x1fa70 && cp <= 0x1faff) ||
        (cp >= 0x20000 && cp <= 0x3fffd)) {
        return 2;
    }
    return 1;
}
/** Display width of a string that may contain our own ANSI styling. */
function width(s) {
    let w = 0;
    for (const ch of s.replace(ANSI_RE, ""))
        w += charWidth(ch.codePointAt(0));
    return w;
}
/**
 * Cut or pad a (possibly styled) string to exactly `cols` display columns.
 * Styling survives the cut; a truncated line ends in "…".
 */
function fit(s, cols) {
    if (cols <= 0)
        return "";
    const w = width(s);
    if (w <= cols)
        return s + " ".repeat(cols - w);
    let out = "";
    let used = 0;
    let i = 0;
    while (i < s.length) {
        if (s[i] === "\x1b") {
            ANSI_RE.lastIndex = i;
            const m = ANSI_RE.exec(s);
            if (m && m.index === i) {
                out += m[0];
                i += m[0].length;
                continue;
            }
        }
        const cp = s.codePointAt(i);
        const ch = String.fromCodePoint(cp);
        const cw = charWidth(cp);
        if (used + cw > cols - 1)
            break;
        out += ch;
        used += cw;
        i += ch.length;
    }
    ANSI_RE.lastIndex = 0;
    // Close any fg/weight/inverse the cut left open; bg is the row's to close.
    const reset = s.includes("\x1b") ? "\x1b[22;27;39m" : "";
    return out + reset + "…" + " ".repeat(Math.max(0, cols - used - 1));
}
/** Word-wrap plain text to `cols`, hard-breaking tokens longer than a line. */
function wrap(text, cols) {
    const out = [];
    const max = Math.max(1, cols);
    for (const para of text.split("\n")) {
        if (para === "") {
            out.push("");
            continue;
        }
        let line = "";
        let lw = 0;
        const flush = () => {
            out.push(line);
            line = "";
            lw = 0;
        };
        for (const word of para.split(/(\s+)/)) {
            if (!word)
                continue;
            const ww = width(word);
            if (lw + ww <= max) {
                line += word;
                lw += ww;
                continue;
            }
            if (/^\s+$/.test(word)) {
                flush();
                continue;
            }
            if (lw > 0)
                flush();
            // A token wider than the line: break it by columns.
            for (const ch of word) {
                const cw = charWidth(ch.codePointAt(0));
                if (lw + cw > max)
                    flush();
                line += ch;
                lw += cw;
            }
        }
        out.push(line);
    }
    return out;
}
/** Pick a color mode from the environment, honoring NO_COLOR. */
function detectColorMode(isTTY, env = process.env) {
    if (!isTTY || env.NO_COLOR)
        return "none";
    const ct = (env.COLORTERM || "").toLowerCase();
    if (ct === "truecolor" || ct === "24bit")
        return "truecolor";
    if (/256/.test(env.TERM || "") || env.TERM_PROGRAM)
        return "256";
    return "basic";
}
const sw = (rgb, x256, basic) => ({ rgb, x256, basic });
/** The cockpit palette: one accent, three statuses, and greys. */
const PALETTE = {
    accent: sw([122, 162, 247], 111, 34),
    good: sw([158, 206, 106], 149, 32),
    warn: sw([224, 175, 104], 179, 33),
    bad: sw([247, 118, 142], 204, 31),
    violet: sw([187, 154, 247], 141, 35),
    text: sw([192, 202, 245], 189, 37),
    muted: sw([115, 122, 162], 103, 90),
    faint: sw([65, 72, 104], 60, 90),
    selBg: sw([41, 46, 66], 236, 100),
    warnBg: sw([62, 50, 28], 58, 43),
    badBg: sw([66, 32, 42], 52, 41),
};
/**
 * Styling that closes only what it opened (fg with 39, bg with 49, weight
 * with 22) instead of a full reset, so a row's background survives the
 * colored spans inside it. `mode: "none"` returns text untouched — which is
 * what the tests render with.
 */
class Style {
    mode;
    constructor(mode) {
        this.mode = mode;
    }
    code(t, bg) {
        const p = PALETTE[t];
        if (this.mode === "truecolor")
            return `${bg ? 48 : 38};2;${p.rgb.join(";")}`;
        if (this.mode === "256")
            return `${bg ? 48 : 38};5;${bg ? p.x256 : p.x256}`;
        return String(bg ? p.basic + 10 : p.basic);
    }
    fg(t, s) {
        return this.mode === "none" || !s ? s : `\x1b[${this.code(t, false)}m${s}\x1b[39m`;
    }
    bg(t, s) {
        return this.mode === "none" ? s : `\x1b[${this.code(t, true)}m${s.replace(/\x1b\[49m/g, `\x1b[${this.code(t, true)}m`)}\x1b[49m`;
    }
    bold(s) {
        return this.mode === "none" || !s ? s : `\x1b[1m${s}\x1b[22m`;
    }
    dim(s) {
        return this.fg("muted", s);
    }
    inverse(s) {
        return this.mode === "none" ? s : `\x1b[7m${s}\x1b[27m`;
    }
    /** A pill: ` LABEL ` on a tinted background. */
    pill(t, s) {
        if (this.mode === "none")
            return `[${s}]`;
        const bgTone = t === "bad" ? "badBg" : t === "warn" ? "warnBg" : "selBg";
        return this.bg(bgTone, this.fg(t, this.bold(` ${s} `)));
    }
}
exports.Style = Style;
/**
 * Draw a rounded box of exactly `w` × `h` around `body` lines. Body lines are
 * fitted to the inner width; missing lines are blank.
 */
function box(st, w, h, body, o = {}) {
    if (w < 4 || h < 2)
        return [];
    const tone = o.tone ?? (o.focused ? "accent" : "faint");
    const b = (s) => st.fg(tone, s);
    const inner = w - 4;
    const title = o.title ? ` ${o.title} ` : "";
    const badge = o.badge ? ` ${o.badge} ` : "";
    const tw = width(title);
    const bw = width(badge);
    const fill = Math.max(0, w - 3 - tw - bw);
    const top = b("╭─") +
        (o.focused ? st.fg("accent", st.bold(title)) : st.fg("text", st.bold(title))) +
        b("─".repeat(Math.max(0, fill - 1))) +
        badge +
        b("─╮");
    const foot = o.footer ? ` ${o.footer} ` : "";
    const fw = width(foot);
    const bottom = b("╰" + "─".repeat(Math.max(0, w - 3 - fw))) + st.dim(foot) + b("─╯");
    const out = [fit(top, w)];
    for (let i = 0; i < h - 2; i++)
        out.push(b("│") + " " + fit(body[i] ?? "", inner) + " " + b("│"));
    out.push(fit(bottom, w));
    return out;
}
/** Place `cols` side by side, each already exactly its own width. */
function hjoin(...cols) {
    const h = Math.max(...cols.map((c) => c.length));
    const widths = cols.map((c) => (c.length ? width(c[0]) : 0));
    const out = [];
    for (let i = 0; i < h; i++)
        out.push(cols.map((c, j) => c[i] ?? " ".repeat(widths[j])).join(""));
    return out;
}
/** Plain text of `s` between display columns [from, to), styling removed. */
function columns(s, from, to) {
    let out = "";
    let col = 0;
    for (const ch of s.replace(ANSI_RE, "")) {
        const cw = charWidth(ch.codePointAt(0));
        if (col >= from && col + cw <= to)
            out += ch;
        else if (col < to && col + cw > from)
            out += " "; // a wide char split by the edge
        col += cw;
        if (col >= to)
            break;
    }
    return out + " ".repeat(Math.max(0, to - from - width(out)));
}
/**
 * Overlay `top` lines centered on `base`. What shows around the dialog is the
 * screen behind it, unstyled and passed through `dim`, so it reads as
 * background rather than as something still live.
 */
function overlay(base, top, totalW, dim = (s) => s) {
    if (!top.length)
        return base;
    const tw = width(top[0]);
    const row0 = Math.max(0, Math.floor((base.length - top.length) / 2));
    const col0 = Math.max(0, Math.floor((totalW - tw) / 2));
    return base.map((line, i) => {
        const t = top[i - row0];
        if (t === undefined)
            return dim(columns(line, 0, totalW));
        return dim(columns(line, 0, col0)) + t + dim(columns(line, col0 + tw, totalW));
    });
}
/** Eight-level sparkline of `values`, scaled to their own max. */
function sparkline(values) {
    const bars = "▁▂▃▄▅▆▇█";
    const max = Math.max(0, ...values);
    if (max === 0)
        return values.map(() => " ").join("");
    return values.map((v) => (v <= 0 ? " " : bars[Math.min(7, Math.floor((v / max) * 7.999))])).join("");
}
