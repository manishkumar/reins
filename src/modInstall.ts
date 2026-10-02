import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Installing the read-only status mod (`mods/reins-status`) into a project.
 *
 * Claude Code loads a plugin it finds in a trusted project's
 * `.claude/skills/<name>/` (as `<name>@skills-dir`). A project's settings
 * cannot name a plugin folder, so pointing at the copy inside the npm package
 * is not an option: the files are copied.
 *
 * Opt-in (`reins init --mod`). The mod API is early access, and this code runs
 * in other people's sessions. Same rules as the hooks (invariant 9): never
 * clobber a folder reins did not write, and remove exactly what was added.
 * Nothing here is reachable from `reins hook *`.
 */

export const MOD_NAME = "reins-status";

/** Every file reins writes, relative to the mod folder. Tests are not shipped into a project. */
export const MOD_FILES = [".claude-plugin/plugin.json", "hooks/hooks.json", "hooks/register.tsx", "types/index.d.ts"];

/** The mod as shipped in the package, next to `dist/`. */
export function modSourceDir(): string {
  return path.join(__dirname, "..", "mods", MOD_NAME);
}

export function modTargetDir(projectDir: string): string {
  return path.join(projectDir, ".claude", "skills", MOD_NAME);
}

export type ModInstall =
  | { status: "installed" | "updated" | "already"; dir: string }
  /** The folder exists and is not this mod. Left untouched. */
  | { status: "foreign"; dir: string }
  /** The package has no mod to copy (a build without `mods/`). */
  | { status: "no-source"; dir: string };

export function installMod(projectDir: string, sourceDir: string = modSourceDir()): ModInstall {
  const dir = modTargetDir(projectDir);
  if (!MOD_FILES.every((f) => fs.existsSync(path.join(sourceDir, f)))) return { status: "no-source", dir };

  const existed = fs.existsSync(dir);
  if (existed && !isOurs(dir)) return { status: "foreign", dir };

  let changed = 0;
  for (const f of MOD_FILES) {
    const next = fs.readFileSync(path.join(sourceDir, f));
    const to = path.join(dir, f);
    if (fs.existsSync(to) && fs.readFileSync(to).equals(next)) continue;
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.writeFileSync(to, next);
    changed++;
  }
  return { status: changed === 0 ? "already" : existed ? "updated" : "installed", dir };
}

/**
 * Remove the files reins wrote and any folder that leaves empty. A file the
 * person added beside them stays, and so does its folder. Returns how many
 * files were removed.
 */
export function removeMod(projectDir: string): number {
  const dir = modTargetDir(projectDir);
  if (!fs.existsSync(dir) || !isOurs(dir)) return 0;
  let removed = 0;
  for (const f of MOD_FILES) {
    const file = path.join(dir, f);
    if (!fs.existsSync(file)) continue;
    fs.rmSync(file);
    removed++;
  }
  // Deepest first. rmdir refuses a folder that still holds something.
  for (const d of [".claude-plugin", "hooks", "types", "."]) rmdirIfEmpty(path.join(dir, d));
  rmdirIfEmpty(path.dirname(dir));
  return removed;
}

/** True when the folder's manifest names this mod. A folder holding no files counts: there is nothing in it to clobber. */
function isOurs(dir: string): boolean {
  try {
    if (!holdsFiles(dir)) return true;
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, ".claude-plugin", "plugin.json"), "utf8"));
    return manifest?.name === MOD_NAME;
  } catch {
    return false;
  }
}

function holdsFiles(dir: string): boolean {
  return fs.readdirSync(dir, { withFileTypes: true }).some((e) => !e.isDirectory() || holdsFiles(path.join(dir, e.name)));
}

function rmdirIfEmpty(dir: string): void {
  try {
    fs.rmdirSync(dir);
  } catch {
    /* not empty, or not there */
  }
}
