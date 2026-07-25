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
exports.cmdInit = cmdInit;
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const paths_1 = require("../paths");
const guards_1 = require("../guards");
const config_1 = require("../config");
const settingsBlock_1 = require("../settingsBlock");
const settingsMerge_1 = require("../settingsMerge");
const store_1 = require("../store");
const format_1 = require("./format");
function cmdInit(args) {
    const printOnly = args.includes("--print") || args.includes("-p");
    const useLocal = args.includes("--local");
    // init always targets the CURRENT directory (it's an explicit "set up here"),
    // never a parent project found by walk-up.
    const here = process.cwd();
    const dir = (0, paths_1.ensureReinsDir)(here);
    // Only seed a fresh policy.json when NEITHER file exists — a pre-existing
    // guards.json (older install) is left alone; init isn't the migration
    // trigger, `reins guard add/remove` is (see saveGuards in guards.ts).
    if (!fs.existsSync((0, paths_1.policyPath)(here)) && !fs.existsSync((0, paths_1.guardsPath)(here))) {
        (0, guards_1.saveGuards)((0, guards_1.loadGuards)(here), here);
    }
    if (!fs.existsSync((0, paths_1.configPath)(here)))
        (0, config_1.saveConfig)((0, config_1.loadConfig)(here), here);
    console.log(format_1.c.green("✓ Initialized ") + format_1.c.dim(dir));
    console.log(format_1.c.dim("  · policy.json   (default denylist — edit or use `reins guard`)"));
    console.log(format_1.c.dim("  · config.json   (loop threshold, etc.)"));
    console.log(format_1.c.dim("  · .gitignore    (the whole .reins dir is git-ignored)"));
    // Surface the capture capability up front — honest about Node compatibility.
    const note = (0, store_1.capabilityNote)();
    if (note)
        console.log(format_1.c.yellow("  ! ") + format_1.c.dim(note));
    else
        console.log(format_1.c.dim(`  · capture       enabled via ${(0, store_1.getDriver)().name}`));
    console.log("");
    if (printOnly) {
        console.log(format_1.c.bold("Add this to ") + format_1.c.cyan(".claude/settings.json") + ":");
        console.log("");
        console.log((0, settingsBlock_1.settingsBlockJson)());
        console.log("");
        console.log(format_1.c.dim("(Requires `npm i -g reins`, or replace `reins` with `npx reins`.)"));
    }
    else {
        const settingsFile = path.join(process.cwd(), ".claude", useLocal ? "settings.local.json" : "settings.json");
        const result = mergeHooks(settingsFile);
        switch (result.status) {
            case "added":
                console.log(format_1.c.green("✓ Wired hooks into ") + format_1.c.cyan(rel(settingsFile)));
                console.log(format_1.c.dim("  " + result.detail));
                break;
            case "already":
                console.log(format_1.c.green("✓ Hooks already wired in ") + format_1.c.cyan(rel(settingsFile)));
                break;
            case "unparseable":
                console.log(format_1.c.red("! Could not parse ") + format_1.c.cyan(rel(settingsFile)));
                console.log(format_1.c.dim("  Left it untouched. Add this block manually:"));
                console.log("");
                console.log((0, settingsBlock_1.settingsBlockJson)());
                break;
        }
        console.log("");
        console.log(format_1.c.dim("Restart Claude Code in this project so it loads the hooks."));
    }
    console.log("");
    console.log("Then, mid-run:  " + format_1.c.cyan('reins steer "focus the auth work on the token refresh path"'));
    return 0;
}
/**
 * Idempotently add reins hook entries to a Claude Code settings file. Preserves
 * everything else. Never overwrites a file it can't parse (avoids clobbering a
 * user's settings on a stray syntax error).
 */
function mergeHooks(settingsFile) {
    let parsed = {};
    if (fs.existsSync(settingsFile)) {
        const raw = fs.readFileSync(settingsFile, "utf8").trim();
        if (raw) {
            try {
                parsed = JSON.parse(raw);
            }
            catch {
                return { status: "unparseable", detail: "" };
            }
        }
    }
    else {
        fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
    }
    const { settings, added } = (0, settingsMerge_1.mergeReinsHooks)(parsed);
    if (added === 0)
        return { status: "already", detail: "" };
    fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2) + "\n");
    return {
        status: "added",
        detail: `${added} hook${added === 1 ? "" : "s"} added (PreToolUse, PostToolUse, Stop).`,
    };
}
function rel(p) {
    const r = path.relative(process.cwd(), p);
    return r.startsWith("..") ? p : r;
}
