"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.c = void 0;
const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
function wrap(code, s) {
    return useColor ? `\x1b[${code}m${s}\x1b[0m` : s;
}
exports.c = {
    bold: (s) => wrap("1", s),
    dim: (s) => wrap("2", s),
    red: (s) => wrap("31", s),
    green: (s) => wrap("32", s),
    yellow: (s) => wrap("33", s),
    blue: (s) => wrap("34", s),
    magenta: (s) => wrap("35", s),
    cyan: (s) => wrap("36", s),
};
