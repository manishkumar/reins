#!/usr/bin/env node
// ansi2svg — render captured terminal output (with ANSI colors) as a crisp SVG
// "screenshot" for the README. Zero dependencies, like everything else here.
//
//   node assets/ansi2svg.mjs <input.txt> <output.svg> ["window title"]
//
// Why SVG and not a PNG: the terminal output IS the product, so it should stay
// text-sharp at any zoom, diff cleanly in git, and never need a design tool to
// regenerate. Capture real output (force a pty with `script -q /dev/null …` so
// colors survive), then run it through this.
//
// Understands the subset of ANSI that src/commands/format.ts emits — SGR codes
// 0/1/2/31-36 — and silently drops any other escape sequence (cursor moves,
// erases) that a pty capture drags along.

import * as fs from "node:fs";

const [, , inPath, outPath, title = ""] = process.argv;
if (!inPath || !outPath) {
  console.error('Usage: node assets/ansi2svg.mjs <input.txt> <output.svg> ["title"]');
  process.exit(1);
}

// GitHub-dark-adjacent palette; readable on light backgrounds too.
const BG = "#0d1117";
const CHROME = "#161b22";
const FG = "#e6edf3";
const COLORS = {
  31: "#ff7b72", // red
  32: "#3fb950", // green
  33: "#d29922", // yellow
  34: "#58a6ff", // blue
  35: "#bc8cff", // magenta
  36: "#39c5cf", // cyan
};
const DIM = "#8b949e";

const FONT = "ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace";
const FONT_SIZE = 13;
const CHAR_W = 7.85; // measured for 13px SFMono; close enough across the stack
const LINE_H = 20;
const PAD_X = 18;
const PAD_TOP = 14;
const CHROME_H = 36;

const raw = fs
  .readFileSync(inPath, "utf8")
  .replace(/\r/g, "")
  // pty captures leak control bytes (EOT from a closed stdin, BEL); ESC survives
  .replace(/[\x00-\x08\x0B-\x1A\x1C-\x1F]/g, "");
const lines = raw.split("\n");
// Drop trailing blank lines but keep intentional inner ones.
while (lines.length && lines[lines.length - 1].trim() === "") lines.pop();

/** Parse one line into styled spans: [{text, color, bold, dim}] */
function parseLine(line) {
  const spans = [];
  let color = null;
  let bold = false;
  let dim = false;
  let buf = "";
  const flush = () => {
    if (buf) spans.push({ text: buf, color, bold, dim });
    buf = "";
  };
  for (let i = 0; i < line.length; i++) {
    if (line[i] === "\x1b") {
      const m = /^\x1b\[([0-9;]*)([A-Za-z])/.exec(line.slice(i));
      if (m) {
        i += m[0].length - 1;
        if (m[2] === "m") {
          flush();
          for (const code of (m[1] || "0").split(";").map(Number)) {
            if (code === 0) (color = null), (bold = false), (dim = false);
            else if (code === 1) bold = true;
            else if (code === 2) dim = true;
            else if (COLORS[code]) color = COLORS[code];
          }
        }
        continue; // non-m sequences (cursor, erase) are dropped
      }
    }
    buf += line[i];
  }
  flush();
  return spans;
}

const parsed = lines.map(parseLine);
const maxLen = Math.max(40, ...parsed.map((s) => s.reduce((n, x) => n + x.text.length, 0)));
const width = Math.ceil(PAD_X * 2 + maxLen * CHAR_W);
const height = CHROME_H + PAD_TOP + parsed.length * LINE_H + PAD_TOP;

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

let body = "";
parsed.forEach((spans, row) => {
  if (!spans.length) return;
  const y = CHROME_H + PAD_TOP + row * LINE_H + FONT_SIZE;
  let col = 0;
  let tspans = "";
  for (const s of spans) {
    const fill = s.color ?? (s.dim ? DIM : FG);
    const weight = s.bold ? ' font-weight="700"' : "";
    // x is set per-tspan so glyph-width drift can never accumulate.
    tspans += `<tspan x="${(PAD_X + col * CHAR_W).toFixed(1)}" fill="${fill}"${weight}>${esc(s.text)}</tspan>`;
    col += s.text.length;
  }
  body += `<text y="${y}" xml:space="preserve">${tspans}</text>\n`;
});

const titleText = title
  ? `<text x="${width / 2}" y="${CHROME_H / 2 + 4}" text-anchor="middle" fill="${DIM}" font-size="12">${esc(title)}</text>`
  : "";

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="${FONT}" font-size="${FONT_SIZE}">
<rect width="${width}" height="${height}" rx="10" fill="${BG}"/>
<path d="M0 10 a10 10 0 0 1 10 -10 h${width - 20} a10 10 0 0 1 10 10 v${CHROME_H - 10} h-${width} z" fill="${CHROME}"/>
<circle cx="20" cy="${CHROME_H / 2}" r="5.5" fill="#ff5f57"/>
<circle cx="40" cy="${CHROME_H / 2}" r="5.5" fill="#febc2e"/>
<circle cx="60" cy="${CHROME_H / 2}" r="5.5" fill="#28c840"/>
${titleText}
${body}</svg>
`;

fs.writeFileSync(outPath, svg);
console.log(`wrote ${outPath} (${width}×${height}, ${parsed.length} lines)`);
