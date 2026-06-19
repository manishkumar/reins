#!/usr/bin/env node
"use strict";
// reins — a local-first kit of Claude Code hooks.
// One entry point: it is both what the hooks invoke (`reins hook ...`) and the
// user-facing command (`reins steer ...`, `reins guard ...`, etc.).
//
// Hot path note: hooks fire on every tool call, so the dispatch below lazy-loads
// each command's module. The common pre-tool path touches no DB unless it denies.
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
async function main() {
    const [, , cmd, ...rest] = process.argv;
    switch (cmd) {
        case "hook":
            return runHook(rest);
        case "steer": {
            const { cmdSteer } = await Promise.resolve().then(() => __importStar(require("./commands/steer")));
            return cmdSteer(rest);
        }
        case "guard": {
            const { cmdGuard } = await Promise.resolve().then(() => __importStar(require("./commands/guard")));
            return cmdGuard(rest);
        }
        case "lastrun": {
            const { cmdLastrun } = await Promise.resolve().then(() => __importStar(require("./commands/lastrun")));
            return cmdLastrun(rest);
        }
        case "loops": {
            const { cmdLoops } = await Promise.resolve().then(() => __importStar(require("./commands/loops")));
            return cmdLoops();
        }
        case "sessions":
        case "ls": {
            const { cmdSessions } = await Promise.resolve().then(() => __importStar(require("./commands/sessions")));
            return cmdSessions(rest);
        }
        case "init": {
            const { cmdInit } = await Promise.resolve().then(() => __importStar(require("./commands/init")));
            return cmdInit(rest);
        }
        case "doctor": {
            const { cmdDoctor } = await Promise.resolve().then(() => __importStar(require("./commands/doctor")));
            return cmdDoctor();
        }
        case "uninstall": {
            const { cmdUninstall } = await Promise.resolve().then(() => __importStar(require("./commands/uninstall")));
            return cmdUninstall(rest);
        }
        case "version":
        case "--version":
        case "-v": {
            let v = "unknown";
            try {
                v = require("../package.json").version;
            }
            catch {
                /* keep unknown */
            }
            console.log(v);
            return 0;
        }
        case undefined:
        case "help":
        case "--help":
        case "-h":
            printHelp();
            return 0;
        default:
            console.error(`reins: unknown command "${cmd}"`);
            printHelp();
            return 1;
    }
}
async function runHook(rest) {
    const which = rest[0];
    try {
        switch (which) {
            case "pre-tool": {
                const { runPreTool } = await Promise.resolve().then(() => __importStar(require("./hooks/preTool")));
                await runPreTool();
                return 0;
            }
            case "post-tool": {
                const { runPostTool } = await Promise.resolve().then(() => __importStar(require("./hooks/postTool")));
                await runPostTool();
                return 0;
            }
            case "stop": {
                const { runStop } = await Promise.resolve().then(() => __importStar(require("./hooks/stop")));
                await runStop();
                return 0;
            }
            default:
                process.stderr.write(`reins hook: unknown hook "${which}"\n`);
                return 0; // never block the agent over a bad hook arg
        }
    }
    catch (e) {
        // Fail open: a crashing hook must not wedge the agent. Log, allow.
        process.stderr.write("[reins] hook error (failing open): " + String(e) + "\n");
        return 0;
    }
}
function printHelp() {
    console.log(`reins — steer a running Claude Code agent, block forbidden actions,
catch loops, and capture every run. Local-first. No daemon, no backend.

USAGE
  reins init                       Set up .reins/ and wire hooks into settings
  reins init --print               Print the hooks block instead of writing it
  reins init --local               Wire into .claude/settings.local.json
  reins doctor                     Diagnose your setup when something's off
  reins uninstall [--purge]        Remove reins hooks (--purge also drops .reins)
  reins steer "<message>"          Queue live steering for the next tool call
  reins steer "<message>" --replace  Overwrite pending steering (default: append)
  reins steer                      Show pending steering
  reins steer --clear              Clear pending steering
  reins guard list                 Show guard rules (hard vetoes)
  reins guard add bash "<regex>"   Block matching Bash commands
  reins guard add path "<glob>"    Block writes to matching paths (e.g. **/.env)
  reins guard remove <id>          Remove a guard
  reins guard reset                Restore default guards
  reins lastrun [session-prefix]   Readable account of the most recent run
  reins sessions                   List recent sessions in this project
  reins loops                      Sessions where the agent looped

HOOK ENTRYPOINTS (wired via .claude/settings.json — see \`reins init\`)
  reins hook pre-tool | post-tool | stop

Steering is a soft nudge the model weighs — think "the detail you forgot to put
in the original prompt", not "an order that overrides it". For a hard, the agent
physically can't proceed, use a guard.`);
}
main()
    .then((code) => process.exit(code))
    .catch((e) => {
    process.stderr.write("[reins] fatal: " + String(e) + "\n");
    process.exit(1);
});
