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
const policyUpgrade_1 = require("../policyUpgrade");
const config_1 = require("../config");
const steering_1 = require("../steering");
const holds_1 = require("../holds");
const format_1 = require("./format");
const OK = format_1.c.green("✓");
const WARN = format_1.c.yellow("!");
const BAD = format_1.c.red("✗");
/** Diagnose a reins setup. The first thing to run when something seems off. */
function cmdDoctor() {
    let problems = 0;
    // Things worth showing that are not faults: an expired rule doing exactly
    // what it was told to, a broad pattern, holds waiting for you. They print a
    // "!" like problems do, so the summary counts them separately rather than
    // showing a "!" line the total silently ignores.
    let notes = 0;
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
        line(OK, "loop threshold", String((0, config_1.loadConfig)().loopThreshold));
        const pending = (0, steering_1.peekSteering)();
        if (pending)
            notes++;
        line(pending ? WARN : OK, "pending steering", pending ? `"${pending}"` : "none");
        const holds = (0, holds_1.listPending)().length;
        if (holds > 0)
            notes++;
        line(holds > 0 ? WARN : OK, "pending holds", holds > 0 ? `${holds} awaiting approval — reins pending` : "none");
    }
    else {
        problems++;
        line(WARN, ".reins dir", "not initialized — run `reins init`");
    }
    // Policy (guards)
    console.log("");
    console.log(format_1.c.bold("Policy"));
    const source = (0, guards_1.policySource)();
    const sourceLabel = source === "defaults" ? "built-in defaults (no policy.json or guards.json)" : `.reins/${source}`;
    line(OK, "source", sourceLabel);
    const guards = (0, guards_1.loadGuards)();
    line(OK, "rule count", `${guards.rules.length}`);
    // Staleness. Before this check existed, a rule fix could ship upstream and
    // never reach a single existing install — which is exactly what happened to
    // the recursive-rm pattern between June and July 2026.
    const plan = (0, policyUpgrade_1.planUpgrade)(guards);
    const stale = (0, policyUpgrade_1.stalenessNote)(plan);
    if (stale) {
        notes++;
        line(WARN, "policy version", stale);
    }
    else {
        line(OK, "policy version", `v${plan.toVersion} (current)`);
    }
    const policyProblems = (0, guards_1.validateRules)(guards.rules);
    const errors = policyProblems.filter((p) => p.severity === "error");
    const warnings = policyProblems.filter((p) => p.severity === "warning");
    if (policyProblems.length === 0) {
        line(OK, "rules", "no problems found");
    }
    else {
        for (const p of errors) {
            problems++;
            line(BAD, `rule ${p.ruleId}`, p.message);
        }
        for (const p of warnings) {
            notes++;
            line(WARN, `rule ${p.ruleId}`, p.message);
        }
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
    const noteSuffix = notes > 0 ? format_1.c.dim(` (${notes} note${notes === 1 ? "" : "s"} above)`) : "";
    if (problems === 0) {
        console.log(OK + format_1.c.green(" Everything looks good.") + noteSuffix);
    }
    else {
        console.log(WARN +
            format_1.c.yellow(` ${problems} thing${problems === 1 ? "" : "s"} to look at above.`) +
            noteSuffix);
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
