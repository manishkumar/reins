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
exports.cmdDoctor = cmdDoctor;
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const paths_1 = require("../paths");
const store_1 = require("../store");
const guards_1 = require("../guards");
const config_1 = require("../config");
const steering_1 = require("../steering");
const format_1 = require("./format");
const OK = format_1.c.green("✓");
const WARN = format_1.c.yellow("!");
const BAD = format_1.c.red("✗");
/** Diagnose a reins setup. The first thing to run when something seems off. */
function cmdDoctor() {
    let problems = 0;
    const line = (sym, label, detail) => console.log(`  ${sym} ${label.padEnd(22)} ${format_1.c.dim(detail)}`);
    console.log(format_1.c.bold("reins doctor") + format_1.c.dim("  (cwd: " + process.cwd() + ")"));
    console.log("");
    // Runtime
    console.log(format_1.c.bold("Runtime"));
    line(OK, "reins version", reinsVersion());
    const driver = (0, store_1.getDriver)();
    if (driver) {
        line(OK, "node", process.version + ` — capture via ${driver.name}`);
    }
    else {
        problems++;
        line(WARN, "node", process.version);
        line(WARN, "capture", (0, store_1.capabilityNote)());
    }
    // Project state
    console.log("");
    console.log(format_1.c.bold("Project (.reins)"));
    const dir = (0, paths_1.reinsDir)();
    if (fs.existsSync(dir)) {
        line(OK, ".reins dir", dir);
        if (isWritable(dir))
            line(OK, "writable", "yes");
        else {
            problems++;
            line(BAD, "writable", "NO — guards/steering/capture cannot persist state");
        }
        const guards = (0, guards_1.loadGuards)();
        line(OK, "guard rules", `${guards.rules.length} active`);
        line(OK, "loop threshold", String((0, config_1.loadConfig)().loopThreshold));
        const pending = (0, steering_1.peekSteering)();
        line(pending ? WARN : OK, "pending steering", pending ? `"${pending}"` : "none");
    }
    else {
        problems++;
        line(WARN, ".reins dir", "not initialized — run `reins init`");
    }
    // Hook wiring
    console.log("");
    console.log(format_1.c.bold("Hook wiring (.claude)"));
    const wiredAnywhere = checkSettings(path.join(process.cwd(), ".claude", "settings.json"), "settings.json", line) ||
        checkSettings(path.join(process.cwd(), ".claude", "settings.local.json"), "settings.local.json", line);
    if (!wiredAnywhere) {
        problems++;
        line(WARN, "hooks", "not wired — run `reins init` (or `reins init --print`)");
    }
    // PATH
    console.log("");
    console.log(format_1.c.bold("Install"));
    line(OK, "invoked as", process.argv[1] || "?");
    line(OK, "note", "hooks call bare `reins` — it must be on PATH for every shell Claude Code spawns");
    console.log("");
    if (problems === 0) {
        console.log(OK + format_1.c.green(" Everything looks good."));
    }
    else {
        console.log(WARN + format_1.c.yellow(` ${problems} thing${problems === 1 ? "" : "s"} to look at above.`));
    }
    return problems === 0 ? 0 : 1;
}
function checkSettings(file, label, line) {
    if (!fs.existsSync(file))
        return false;
    let parsed;
    try {
        parsed = JSON.parse(fs.readFileSync(file, "utf8") || "{}");
    }
    catch {
        line(BAD, label, "exists but is not valid JSON");
        return false;
    }
    const hooks = (parsed.hooks ?? {});
    const events = ["PreToolUse", "PostToolUse", "Stop"];
    const wired = events.filter((ev) => (hooks[ev] ?? []).some((e) => (e.hooks ?? []).some((h) => (h.command ?? "").includes("reins hook"))));
    if (wired.length === 0)
        return false;
    const sym = wired.length === events.length ? OK : WARN;
    line(sym, label, `${wired.join(", ")} wired`);
    return wired.length === events.length;
}
function reinsVersion() {
    try {
        return require("../../package.json").version;
    }
    catch {
        return "unknown";
    }
}
function isWritable(dir) {
    try {
        const probe = path.join(dir, ".doctor-write-probe");
        fs.writeFileSync(probe, "");
        fs.rmSync(probe);
        return true;
    }
    catch {
        return false;
    }
}
