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
exports.footprint = footprint;
exports.commandHeads = commandHeads;
exports.footprintLines = footprintLines;
const path = __importStar(require("node:path"));
const shell_1 = require("./shell");
const GATE_ROW = /^(DENIED|ASKED|HELD|APPROVED|REFUSED): /;
const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
/** Tools whose second word is the command that matters. */
const TWO_WORDS = new Set([
    "git", "npm", "pnpm", "yarn", "bun", "cargo", "go", "docker", "kubectl", "make", "gh", "pip", "pip3",
    "brew", "terraform", "dotnet", "deno", "mvn", "gradle", "rails", "rake", "poetry", "uv", "reins",
]);
/** Moving around and printing say nothing about what a session did. */
const SKIP = new Set(["cd", "echo", "true", "export", "set", "pushd", "popd"]);
function footprint(calls, root) {
    const fileEdits = new Map();
    const heads = new Map();
    const outsideFiles = new Set();
    let shellWrites = 0;
    for (const c of calls) {
        if (GATE_ROW.test(c.summary))
            continue; // a gate row never executed
        if (EDIT_TOOLS.has(c.tool)) {
            if (c.ok === 0)
                continue;
            const rel = relativeTo(root, c.summary);
            if (rel.outside)
                outsideFiles.add(rel.path);
            fileEdits.set(rel.path, (fileEdits.get(rel.path) ?? 0) + 1);
        }
        else if (c.tool === "Bash") {
            for (const head of commandHeads(c.summary))
                heads.set(head, (heads.get(head) ?? 0) + 1);
            if (c.ok !== 0 && (0, shell_1.mayWriteFiles)(c.summary))
                shellWrites++;
        }
    }
    const files = [...fileEdits].map(([p, edits]) => ({ path: p, edits })).sort((a, b) => b.edits - a.edits || a.path.localeCompare(b.path));
    const byDir = new Map();
    for (const f of files) {
        const d = dirOf(f.path);
        const e = byDir.get(d) ?? { dir: d, files: 0, edits: 0 };
        e.files++;
        e.edits += f.edits;
        byDir.set(d, e);
    }
    return {
        files,
        dirs: [...byDir.values()].sort((a, b) => b.edits - a.edits || a.dir.localeCompare(b.dir)),
        outside: outsideFiles.size,
        shellWrites,
        commands: [...heads].map(([head, runs]) => ({ head, runs })).sort((a, b) => b.runs - a.runs || a.head.localeCompare(b.head)),
    };
}
/** The leading words of every command in a shell line: `cd a && git status | head` gives `git status`. */
function commandHeads(command) {
    const out = [];
    for (const { words } of (0, shell_1.shellCommands)(command)) {
        const first = path.basename(words[0]);
        // Not a command name: a flag left over from a subshell, a redirect, a fragment.
        if (!/^[A-Za-z_][A-Za-z0-9_.+-]*$/.test(first) || SKIP.has(first))
            continue;
        const second = words[1];
        const sub = TWO_WORDS.has(first) && second && /^[a-z][\w:-]*$/.test(second);
        out.push(sub ? `${first} ${second === "run" && words[2] ? `run ${words[2]}` : second}` : first);
    }
    return out;
}
function relativeTo(root, file) {
    if (!path.isAbsolute(file))
        return { path: file, outside: false };
    const rel = path.relative(root, file);
    if (rel.startsWith("..") || path.isAbsolute(rel))
        return { path: file, outside: true };
    return { path: rel, outside: false };
}
function dirOf(p) {
    const d = path.dirname(p);
    return d === "." ? "./" : d.endsWith(path.sep) ? d : d + path.sep;
}
/**
 * The footprint as plain lines, the same on every surface. Empty when the
 * session edited nothing and ran nothing.
 */
function footprintLines(fp, max = 5) {
    const out = [];
    if (fp.files.length) {
        const edits = fp.files.reduce((n, f) => n + f.edits, 0);
        out.push(`edited ${count(fp.files.length, "file")} in ${count(fp.dirs.length, "directory", "directories")}, ${count(edits, "edit")}` +
            (fp.outside ? ` (${fp.outside} outside the project)` : ""));
        for (const d of fp.dirs.slice(0, max))
            out.push(`  ${d.dir}  ${count(d.files, "file")} · ${count(d.edits, "edit")}`);
        if (fp.dirs.length > max)
            out.push(`  +${fp.dirs.length - max} more`);
        out.push("most edited: " + fp.files.slice(0, max).map((f) => `${f.path} ×${f.edits}`).join(", ") + (fp.files.length > max ? `, +${fp.files.length - max} more` : ""));
    }
    if (fp.shellWrites) {
        out.push(`${count(fp.shellWrites, "shell command")} may have changed files too (redirects, sed -i, inline scripts); those files are not listed`);
    }
    if (fp.commands.length) {
        out.push("ran: " + fp.commands.slice(0, max + 3).map((c) => `${c.head} ×${c.runs}`).join(" · ") + (fp.commands.length > max + 3 ? ` · +${fp.commands.length - max - 3} more` : ""));
    }
    return out;
}
function count(n, one, many = one + "s") {
    return `${n} ${n === 1 ? one : many}`;
}
