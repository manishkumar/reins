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
exports.cmdGuard = cmdGuard;
const crypto = __importStar(require("node:crypto"));
const guards_1 = require("../guards");
const format_1 = require("./format");
function cmdGuard(args) {
    const sub = args[0];
    switch (sub) {
        case "list":
        case undefined:
            return list();
        case "add":
            return add(args.slice(1));
        case "remove":
        case "rm":
            return remove(args.slice(1));
        case "reset":
            return reset();
        default:
            console.error(format_1.c.red(`Unknown: reins guard ${sub}`));
            console.error("Try: reins guard [list|add|remove|reset]");
            return 1;
    }
}
function list() {
    const guards = (0, guards_1.loadGuards)();
    if (guards.rules.length === 0) {
        console.log(format_1.c.dim("No guard rules. (Add one: reins guard add bash '<regex>')"));
        return 0;
    }
    console.log(format_1.c.bold("Guard rules — deny is a hard veto; ask escalates to you; hold parks for later:"));
    for (const r of guards.rules) {
        const tag = r.type === "bash" ? format_1.c.magenta("bash ") : format_1.c.blue("path ");
        const action = r.action === "ask" ? format_1.c.yellow("ask ") : r.action === "hold" ? format_1.c.cyan("hold") : format_1.c.red("deny");
        console.log(`  ${format_1.c.dim(r.id.padEnd(20))} ${tag} ${action} ${format_1.c.cyan(r.pattern)}`);
        console.log(`  ${" ".repeat(20)}            ${format_1.c.dim(r.reason)}`);
    }
    return 0;
}
function add(args) {
    const type = args[0];
    if (type !== "bash" && type !== "path") {
        console.error(format_1.c.red("Usage: reins guard add <bash|path> <pattern> [--ask|--hold] [--reason \"...\"]"));
        console.error(format_1.c.dim("  bash <regex>  matches the command of a Bash tool call"));
        console.error(format_1.c.dim("  path <glob>   matches file paths (e.g. **/.env, secrets/**)"));
        console.error(format_1.c.dim("  --ask         escalate to you (permission prompt) instead of hard-denying"));
        console.error(format_1.c.dim("  --hold        park the action for async approval (reins pending/approve/deny)"));
        return 1;
    }
    const ask = args.includes("--ask");
    const hold = args.includes("--hold");
    args = args.filter((a) => a !== "--ask" && a !== "--hold");
    if (ask && hold) {
        console.error(format_1.c.red("Pick one hardness: --ask (interactive prompt) or --hold (async queue)."));
        return 1;
    }
    const reasonIdx = args.findIndex((a) => a === "--reason" || a === "-r");
    let reason = "";
    let patternParts = args.slice(1);
    if (reasonIdx >= 0) {
        reason = args.slice(reasonIdx + 1).join(" ").trim();
        patternParts = args.slice(1, reasonIdx);
    }
    const pattern = patternParts.join(" ").trim();
    if (!pattern) {
        console.error(format_1.c.red("Missing pattern."));
        return 1;
    }
    // Validate up front: a pattern that doesn't compile would be silently skipped
    // at match time, leaving a dead guard the user believes is protecting them.
    if (type === "bash") {
        try {
            new RegExp(pattern);
        }
        catch (e) {
            console.error(format_1.c.red("Invalid regex: ") + format_1.c.dim(String(e.message)));
            console.error(format_1.c.dim("  (bash guards are JavaScript regular expressions)"));
            return 1;
        }
    }
    else {
        try {
            (0, guards_1.globToRegExp)(pattern);
        }
        catch (e) {
            console.error(format_1.c.red("Invalid glob: ") + format_1.c.dim(String(e.message)));
            return 1;
        }
    }
    if (!reason) {
        const subject = type === "bash" ? `Command matching /${pattern}/` : `Touching ${pattern}`;
        reason =
            ask || hold
                ? `${subject} needs your approval (reins guard).`
                : `${subject} is blocked by a reins guard.`;
    }
    const guards = (0, guards_1.loadGuards)();
    const id = makeId(type, pattern, guards.rules.map((r) => r.id));
    const rule = { id, type, pattern, reason };
    if (ask)
        rule.action = "ask"; // absent = deny; keeps pre-0.2 files byte-stable
    if (hold)
        rule.action = "hold";
    guards.rules.push(rule);
    (0, guards_1.saveGuards)(guards);
    console.log(format_1.c.green(`✓ Added guard ${format_1.c.bold(id)}`) +
        (ask ? format_1.c.yellow(" (ask)") : hold ? format_1.c.cyan(" (hold)") : ""));
    console.log(`  ${rule.type} ${format_1.c.cyan(rule.pattern)} — ${format_1.c.dim(rule.reason)}`);
    if (hold) {
        console.log(format_1.c.dim("  Matching actions will park in the queue: reins pending / approve / deny"));
    }
    return 0;
}
function remove(args) {
    const id = args[0];
    if (!id) {
        console.error(format_1.c.red("Usage: reins guard remove <id>   (see ids via: reins guard list)"));
        return 1;
    }
    const guards = (0, guards_1.loadGuards)();
    const before = guards.rules.length;
    guards.rules = guards.rules.filter((r) => r.id !== id);
    if (guards.rules.length === before) {
        console.error(format_1.c.red(`No guard with id "${id}".`));
        return 1;
    }
    (0, guards_1.saveGuards)(guards);
    console.log(format_1.c.green(`✓ Removed guard ${id}`));
    return 0;
}
function reset() {
    (0, guards_1.saveGuards)({ rules: [...guards_1.DEFAULT_RULES] });
    console.log(format_1.c.green("✓ Guards reset to the built-in defaults."));
    return 0;
}
function makeId(type, pattern, existing) {
    const slug = pattern
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 16);
    let base = `${type}-${slug || "rule"}`;
    if (!existing.includes(base))
        return base;
    const suffix = crypto.createHash("sha1").update(pattern).digest("hex").slice(0, 4);
    return `${base}-${suffix}`;
}
