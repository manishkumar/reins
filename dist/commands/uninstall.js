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
exports.cmdUninstall = cmdUninstall;
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const settingsMerge_1 = require("../settingsMerge");
const paths_1 = require("../paths");
const format_1 = require("./format");
/**
 * Remove reins hooks from the project's Claude Code settings. Leaves the .reins
 * data dir in place by default (your trajectory log is yours); --purge removes
 * it too.
 */
function cmdUninstall(args) {
    const purge = args.includes("--purge");
    let touched = 0;
    for (const name of ["settings.json", "settings.local.json"]) {
        const file = path.join(process.cwd(), ".claude", name);
        if (!fs.existsSync(file))
            continue;
        let parsed;
        try {
            parsed = JSON.parse(fs.readFileSync(file, "utf8") || "{}");
        }
        catch {
            console.log(format_1.c.red("! ") + format_1.c.cyan(name) + format_1.c.dim(" is not valid JSON — left untouched."));
            continue;
        }
        const { settings, removed } = (0, settingsMerge_1.unmergeReinsHooks)(parsed);
        if (removed > 0) {
            fs.writeFileSync(file, JSON.stringify(settings, null, 2) + "\n");
            console.log(format_1.c.green(`✓ Removed ${removed} reins hook${removed === 1 ? "" : "s"} from `) + format_1.c.cyan(name));
            touched += removed;
        }
    }
    if (touched === 0) {
        console.log(format_1.c.dim("No reins hooks found in .claude/settings.json or settings.local.json."));
    }
    const dir = (0, paths_1.reinsDir)();
    if (purge && fs.existsSync(dir)) {
        fs.rmSync(dir, { recursive: true, force: true });
        console.log(format_1.c.green("✓ Removed ") + format_1.c.cyan(".reins/") + format_1.c.dim(" (data + config)"));
    }
    else if (fs.existsSync(dir)) {
        console.log(format_1.c.dim(`Your data is kept in ${dir}. Remove it with: reins uninstall --purge`));
    }
    console.log(format_1.c.dim("Restart Claude Code to unload the hooks."));
    return 0;
}
