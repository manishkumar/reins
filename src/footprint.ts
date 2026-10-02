import * as path from "node:path";
import { mayWriteFiles, shellCommands } from "./shell";

/**
 * A session's footprint: which files and directories it edited, and which
 * commands it ran most. Shown next to the prompt the session was given, so the
 * person reading can compare the two.
 *
 * Facts only. It does not say whether the footprint matches the prompt; that
 * is a judgement, and making it would take a model. Display only, like the
 * claim check: nothing here feeds a decision.
 *
 * It sees what capture sees. Edits are Edit, Write, MultiEdit and NotebookEdit
 * calls; a file changed by a shell command is not in the list. Commands are
 * read from the first 160 characters of each Bash call.
 */

export interface Footprint {
  /** Edited files, most edited first. Paths are relative to the project when inside it. */
  files: Array<{ path: string; edits: number }>;
  /** The directories those files are in, most edited first. */
  dirs: Array<{ dir: string; files: number; edits: number }>;
  /** How many of the edited files are outside the project. */
  outside: number;
  /** Commands by their leading words (`git status`, `npm test`), most run first. */
  commands: Array<{ head: string; runs: number }>;
  /** Shell lines that can change files without an edit tool. Their changes are not in `files`. */
  shellWrites: number;
}

export interface FootprintCall {
  tool: string;
  summary: string;
  ok: number | null;
}

const GATE_ROW = /^(DENIED|ASKED|HELD|APPROVED|REFUSED): /;
const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
/** Tools whose second word is the command that matters. */
const TWO_WORDS = new Set([
  "git", "npm", "pnpm", "yarn", "bun", "cargo", "go", "docker", "kubectl", "make", "gh", "pip", "pip3",
  "brew", "terraform", "dotnet", "deno", "mvn", "gradle", "rails", "rake", "poetry", "uv", "reins",
]);
/** Moving around and printing say nothing about what a session did. */
const SKIP = new Set(["cd", "echo", "true", "export", "set", "pushd", "popd"]);

export function footprint(calls: FootprintCall[], root: string): Footprint {
  const fileEdits = new Map<string, number>();
  const heads = new Map<string, number>();
  const outsideFiles = new Set<string>();
  let shellWrites = 0;

  for (const c of calls) {
    if (GATE_ROW.test(c.summary)) continue; // a gate row never executed
    if (EDIT_TOOLS.has(c.tool)) {
      if (c.ok === 0) continue;
      const rel = relativeTo(root, c.summary);
      if (rel.outside) outsideFiles.add(rel.path);
      fileEdits.set(rel.path, (fileEdits.get(rel.path) ?? 0) + 1);
    } else if (c.tool === "Bash") {
      for (const head of commandHeads(c.summary)) heads.set(head, (heads.get(head) ?? 0) + 1);
      if (c.ok !== 0 && mayWriteFiles(c.summary)) shellWrites++;
    }
  }

  const files = [...fileEdits].map(([p, edits]) => ({ path: p, edits })).sort((a, b) => b.edits - a.edits || a.path.localeCompare(b.path));
  const byDir = new Map<string, { dir: string; files: number; edits: number }>();
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
export function commandHeads(command: string): string[] {
  const out: string[] = [];
  for (const { words } of shellCommands(command)) {
    const first = path.basename(words[0]);
    // Not a command name: a flag left over from a subshell, a redirect, a fragment.
    if (!/^[A-Za-z_][A-Za-z0-9_.+-]*$/.test(first) || SKIP.has(first)) continue;
    const second = words[1];
    const sub = TWO_WORDS.has(first) && second && /^[a-z][\w:-]*$/.test(second);
    out.push(sub ? `${first} ${second === "run" && words[2] ? `run ${words[2]}` : second}` : first);
  }
  return out;
}

function relativeTo(root: string, file: string): { path: string; outside: boolean } {
  if (!path.isAbsolute(file)) return { path: slashed(file), outside: false };
  const rel = path.relative(root, file);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return { path: file, outside: true };
  return { path: slashed(rel), outside: false };
}

/** A path inside the project reads the same on every platform: `src/auth/login.ts`. */
function slashed(p: string): string {
  return path.sep === "\\" ? p.split("\\").join("/") : p;
}

function dirOf(p: string): string {
  const d = path.dirname(p);
  if (d === ".") return "./";
  // An outside path stays absolute and native; a project path was slashed above.
  const sep = path.isAbsolute(p) && d.includes("\\") ? "\\" : "/";
  return d.endsWith(sep) ? d : d + sep;
}

/**
 * The footprint as plain lines, the same on every surface. Empty when the
 * session edited nothing and ran nothing.
 */
export function footprintLines(fp: Footprint, max = 5): string[] {
  const out: string[] = [];
  if (fp.files.length) {
    const edits = fp.files.reduce((n, f) => n + f.edits, 0);
    out.push(
      `edited ${count(fp.files.length, "file")} in ${count(fp.dirs.length, "directory", "directories")}, ${count(edits, "edit")}` +
        (fp.outside ? ` (${fp.outside} outside the project)` : ""),
    );
    for (const d of fp.dirs.slice(0, max)) out.push(`  ${d.dir}  ${count(d.files, "file")} · ${count(d.edits, "edit")}`);
    if (fp.dirs.length > max) out.push(`  +${fp.dirs.length - max} more`);
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

function count(n: number, one: string, many = one + "s"): string {
  return `${n} ${n === 1 ? one : many}`;
}
