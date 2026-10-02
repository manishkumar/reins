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
exports.MOD_FILES = exports.MOD_NAME = void 0;
exports.modSourceDir = modSourceDir;
exports.modTargetDir = modTargetDir;
exports.installMod = installMod;
exports.removeMod = removeMod;
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
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
exports.MOD_NAME = "reins-status";
/** Every file reins writes, relative to the mod folder. Tests are not shipped into a project. */
exports.MOD_FILES = [".claude-plugin/plugin.json", "hooks/hooks.json", "hooks/register.tsx", "types/index.d.ts"];
/** The mod as shipped in the package, next to `dist/`. */
function modSourceDir() {
    return path.join(__dirname, "..", "mods", exports.MOD_NAME);
}
function modTargetDir(projectDir) {
    return path.join(projectDir, ".claude", "skills", exports.MOD_NAME);
}
function installMod(projectDir, sourceDir = modSourceDir()) {
    const dir = modTargetDir(projectDir);
    if (!exports.MOD_FILES.every((f) => fs.existsSync(path.join(sourceDir, f))))
        return { status: "no-source", dir };
    const existed = fs.existsSync(dir);
    if (existed && !isOurs(dir))
        return { status: "foreign", dir };
    let changed = 0;
    for (const f of exports.MOD_FILES) {
        const next = fs.readFileSync(path.join(sourceDir, f));
        const to = path.join(dir, f);
        if (fs.existsSync(to) && fs.readFileSync(to).equals(next))
            continue;
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
function removeMod(projectDir) {
    const dir = modTargetDir(projectDir);
    if (!fs.existsSync(dir) || !isOurs(dir))
        return 0;
    let removed = 0;
    for (const f of exports.MOD_FILES) {
        const file = path.join(dir, f);
        if (!fs.existsSync(file))
            continue;
        fs.rmSync(file);
        removed++;
    }
    // Deepest first. rmdir refuses a folder that still holds something.
    for (const d of [".claude-plugin", "hooks", "types", "."])
        rmdirIfEmpty(path.join(dir, d));
    rmdirIfEmpty(path.dirname(dir));
    return removed;
}
/** True when the folder's manifest names this mod. A folder holding no files counts: there is nothing in it to clobber. */
function isOurs(dir) {
    try {
        if (!holdsFiles(dir))
            return true;
        const manifest = JSON.parse(fs.readFileSync(path.join(dir, ".claude-plugin", "plugin.json"), "utf8"));
        return manifest?.name === exports.MOD_NAME;
    }
    catch {
        return false;
    }
}
function holdsFiles(dir) {
    return fs.readdirSync(dir, { withFileTypes: true }).some((e) => !e.isDirectory() || holdsFiles(path.join(dir, e.name)));
}
function rmdirIfEmpty(dir) {
    try {
        fs.rmdirSync(dir);
    }
    catch {
        /* not empty, or not there */
    }
}
