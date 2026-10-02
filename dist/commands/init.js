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
const policyUpgrade_1 = require("../policyUpgrade");
const config_1 = require("../config");
const settingsBlock_1 = require("../settingsBlock");
const settingsMerge_1 = require("../settingsMerge");
const store_1 = require("../store");
const modInstall_1 = require("../modInstall");
const claudeVersion_1 = require("../claudeVersion");
const heartbeat_1 = require("../heartbeat");
const format_1 = require("./format");
function cmdInit(args) {
    const printOnly = args.includes("--print") || args.includes("-p");
    const useLocal = args.includes("--local");
    const withMod = args.includes("--mod");
    const forceFailureHook = args.includes("--failure-hook");
    // init always targets the CURRENT directory (it's an explicit "set up here"),
    // never a parent project found by walk-up.
    const here = process.cwd();
    const dir = (0, paths_1.ensureReinsDir)(here);
    // Only seed a fresh policy.json when NEITHER file exists — a pre-existing
    // guards.json (older install) is left alone; init isn't the migration
    // trigger, `reins guard add/remove` is (see saveGuards in guards.ts).
    if (!fs.existsSync((0, paths_1.policyPath)(here)) && !fs.existsSync((0, paths_1.guardsPath)(here))) {
        (0, guards_1.saveGuards)({ rules: (0, policyUpgrade_1.seededDefaults)(), version: guards_1.POLICY_VERSION }, here);
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
    // An old Claude Code loads no hooks from a file that names an event it does
    // not know, so the failure hook is left out there.
    // The hook is written only on evidence that every Claude Code seen knows it.
    const claude = (0, claudeVersion_1.claudeCodeVersion)((0, heartbeat_1.readHooksSeen)(dir)?.claude);
    const old = (0, claudeVersion_1.predatesFailureHook)(claude);
    const without = (0, claudeVersion_1.mayWriteFailureHook)(claude) || (forceFailureHook && !old) ? [] : [claudeVersion_1.FAILURE_HOOK];
    if (printOnly) {
        console.log(format_1.c.bold("Add this to ") + format_1.c.cyan(".claude/settings.json") + ":");
        console.log("");
        console.log((0, settingsBlock_1.settingsBlockJson)(without));
        console.log("");
        console.log(format_1.c.dim("(Requires `npm i -g reins`, or replace `reins` with `npx reins`.)"));
    }
    else {
        const settingsFile = path.join(process.cwd(), ".claude", useLocal ? "settings.local.json" : "settings.json");
        // Known old: take our entry out. Unknown: leave what is there alone.
        const result = mergeHooks(settingsFile, without, old);
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
                console.log((0, settingsBlock_1.settingsBlockJson)(without));
                break;
        }
        if (old) {
            console.log(format_1.c.yellow("  ! ") + format_1.c.dim(`Claude Code ${claude} is older than ${claudeVersion_1.FAILURE_HOOK_SINCE} and loads no hooks from a settings file that names ${claudeVersion_1.FAILURE_HOOK}.`));
            console.log(format_1.c.dim(`    That hook is left out, so failed tool calls are not captured. Run reins init again after upgrading Claude Code.`));
            if (forceFailureHook)
                console.log(format_1.c.dim(`    --failure-hook was not applied: on this version it would turn every hook off.`));
        }
        else if (claude === null && without.length > 0) {
            console.log(format_1.c.yellow("  ! ") + format_1.c.dim(`Could not tell which Claude Code is installed, so ${claudeVersion_1.FAILURE_HOOK} is left out. Older versions load no hooks from a file that names it.`));
            console.log(format_1.c.dim(`    Guards, holds and steering work. Failed tool calls are not captured.`));
            console.log(format_1.c.dim(`    Run reins init again from inside a Claude Code session, or after one tool call in this project, and it will know.`));
            console.log(format_1.c.dim(`    If your Claude Code is ${claudeVersion_1.FAILURE_HOOK_SINCE} or newer: reins init --failure-hook`));
        }
        else if (claude === null) {
            console.log(format_1.c.yellow("  ! ") + format_1.c.dim(`${claudeVersion_1.FAILURE_HOOK} written on your word (--failure-hook). Check with reins doctor after one tool call.`));
        }
        if (withMod)
            reportMod(here);
        console.log("");
        console.log(format_1.c.dim("Restart Claude Code in this project so it loads the hooks."));
    }
    console.log("");
    console.log("Then, mid-run:  " + format_1.c.cyan('reins steer "focus the auth work on the token refresh path"'));
    return 0;
}
/**
 * `--mod`: copy the read-only status mod into `.claude/skills/reins-status/`,
 * where Claude Code loads it once the project is trusted. Opt-in, because the
 * mod API is early access.
 */
function reportMod(here) {
    const r = (0, modInstall_1.installMod)(here);
    const where = format_1.c.cyan(rel(r.dir));
    switch (r.status) {
        case "installed":
            console.log(format_1.c.green("✓ Installed the status mod in ") + where);
            console.log(format_1.c.dim("  Shows the hold queue inside Claude Code. Read-only: answer holds with reins approve or reins watch."));
            break;
        case "updated":
            console.log(format_1.c.green("✓ Updated the status mod in ") + where);
            break;
        case "already":
            console.log(format_1.c.green("✓ Status mod already installed in ") + where);
            break;
        case "foreign":
            console.log(format_1.c.red("! ") + where + format_1.c.dim(" exists and is not the reins mod. Left untouched."));
            break;
        case "no-source":
            console.log(format_1.c.red("! ") + format_1.c.dim("This build of reins does not include the status mod."));
            break;
    }
}
/**
 * Idempotently add reins hook entries to a Claude Code settings file. Preserves
 * everything else. Never overwrites a file it can't parse (avoids clobbering a
 * user's settings on a stray syntax error).
 */
function mergeHooks(settingsFile, without, strip) {
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
    const { settings, added, removed } = (0, settingsMerge_1.mergeReinsHooks)(parsed, without, strip);
    if (added === 0 && removed === 0)
        return { status: "already", detail: "" };
    fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2) + "\n");
    const events = ["PreToolUse", "PostToolUse", "PostToolUseFailure", "Stop"].filter((e) => !without.includes(e));
    const took = removed > 0 ? ` ${without.join(", ")} removed.` : "";
    return {
        status: "added",
        detail: `${added} hook${added === 1 ? "" : "s"} added (${events.join(", ")}).${took}`,
    };
}
function rel(p) {
    const r = path.relative(process.cwd(), p);
    return r.startsWith("..") ? p : r;
}
