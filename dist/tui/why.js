"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.whyMatched = whyMatched;
const guards_1 = require("../guards");
function whyMatched(rule, command, cwd) {
    if (!rule || rule.type !== "bash" || !command)
        return null;
    const seg = (0, guards_1.firingSegment)(rule, command, cwd);
    if (seg === null)
        return null;
    // Segments are substrings of the command, in order.
    let at = 0;
    for (const s of (0, guards_1.splitCommandSegments)(command)) {
        at = command.indexOf(s, at);
        if (at < 0)
            return null;
        if (s === seg)
            break;
        at += s.length;
    }
    // Narrow to the matched text. The guard matches with quoted text removed;
    // blanking it in place keeps the offsets. If that reads differently, the
    // whole segment is the answer.
    let start = at + (seg.length - seg.trimStart().length);
    let end = at + seg.trimEnd().length;
    try {
        const blank = (q) => " ".repeat(q.length);
        const m = new RegExp(rule.pattern, "i").exec(seg.replace(/"(?:[^"\\]|\\.)*"/g, blank).replace(/'[^']*'/g, blank));
        if (m && m[0].length) {
            start = at + m.index;
            end = start + m[0].length;
        }
    }
    catch {
        /* keep the segment */
    }
    return { start, end, line: command.slice(0, start).split("\n").length, lines: command.split("\n").length };
}
