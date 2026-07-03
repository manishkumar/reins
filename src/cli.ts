#!/usr/bin/env node
// reins — a local-first kit of Claude Code hooks.
// One entry point: it is both what the hooks invoke (`reins hook ...`) and the
// user-facing command (`reins steer ...`, `reins guard ...`, etc.).
//
// Hot path note: hooks fire on every tool call, so the dispatch below lazy-loads
// each command's module. The common pre-tool path touches no DB unless it denies.

async function main(): Promise<number> {
  const [, , cmd, ...rest] = process.argv;

  switch (cmd) {
    case "hook":
      return runHook(rest);

    case "steer": {
      const { cmdSteer } = await import("./commands/steer");
      return cmdSteer(rest);
    }
    case "guard": {
      const { cmdGuard } = await import("./commands/guard");
      return cmdGuard(rest);
    }
    case "pending": {
      const { cmdPending } = await import("./commands/pending");
      return cmdPending();
    }
    case "approve": {
      const { cmdApprove } = await import("./commands/pending");
      return cmdApprove(rest);
    }
    case "deny": {
      const { cmdDeny } = await import("./commands/pending");
      return cmdDeny(rest);
    }
    case "lastrun": {
      const { cmdLastrun } = await import("./commands/lastrun");
      return cmdLastrun(rest);
    }
    case "loops": {
      const { cmdLoops } = await import("./commands/loops");
      return cmdLoops();
    }
    case "sessions":
    case "ls": {
      const { cmdSessions } = await import("./commands/sessions");
      return cmdSessions(rest);
    }
    case "watch": {
      const { cmdWatch } = await import("./commands/watch");
      return cmdWatch(rest);
    }
    case "report": {
      const { cmdReport } = await import("./commands/report");
      return cmdReport(rest);
    }
    case "init": {
      const { cmdInit } = await import("./commands/init");
      return cmdInit(rest);
    }
    case "doctor": {
      const { cmdDoctor } = await import("./commands/doctor");
      return cmdDoctor();
    }
    case "uninstall": {
      const { cmdUninstall } = await import("./commands/uninstall");
      return cmdUninstall(rest);
    }
    case "version":
    case "--version":
    case "-v": {
      let v = "unknown";
      try {
        v = (require("../package.json") as { version: string }).version;
      } catch {
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

async function runHook(rest: string[]): Promise<number> {
  const which = rest[0];
  try {
    switch (which) {
      case "pre-tool": {
        const { runPreTool } = await import("./hooks/preTool");
        await runPreTool();
        return 0;
      }
      case "post-tool": {
        const { runPostTool } = await import("./hooks/postTool");
        await runPostTool();
        return 0;
      }
      case "stop": {
        const { runStop } = await import("./hooks/stop");
        await runStop();
        return 0;
      }
      default:
        process.stderr.write(`reins hook: unknown hook "${which}"\n`);
        return 0; // never block the agent over a bad hook arg
    }
  } catch (e) {
    // Fail open: a crashing hook must not wedge the agent. Log, allow.
    process.stderr.write("[reins] hook error (failing open): " + String(e) + "\n");
    return 0;
  }
}

function printHelp(): void {
  console.log(`reins — steer a running Claude Code agent, block forbidden actions,
catch loops, and capture every run. Local-first. No daemon, no backend.

USAGE
  reins init                       Set up .reins/ and wire hooks into settings
  reins init --print               Print the hooks block instead of writing it
  reins init --local               Wire into .claude/settings.local.json
  reins doctor                     Diagnose your setup when something's off
  reins uninstall [--purge]        Remove reins hooks (--purge also drops .reins)
  reins steer "<message>"          Queue live steering for the next tool call
  reins steer "<msg>" --session <id>  Target one agent (id/prefix from sessions)
  reins steer "<message>" --replace  Overwrite pending steering (default: append)
  reins steer                      Show pending steering
  reins steer --clear              Clear pending steering
  reins guard list                 Show guard rules (deny = hard veto, ask = escalate)
  reins guard add bash "<regex>"   Block matching Bash commands
  reins guard add path "<glob>"    Block writes to matching paths (e.g. **/.env)
  reins guard add ... --ask        Escalate to you (permission prompt) instead of denying
  reins guard add ... --hold       Park for async approval instead of denying
  reins guard remove <id>          Remove a guard
  reins guard reset                Restore default guards
  reins pending                    List actions parked by hold rules
  reins approve <id>               Approve a parked action (one-shot, exact input)
  reins deny <id> [--steer "..."]  Refuse a parked action, optionally steer instead
  reins lastrun [session-prefix]   Readable account of the most recent run
  reins sessions                   List recent sessions in this project
  reins watch                      Live cockpit: all agents, steer any one
  reins report [--open]            Write a local HTML report of every run
  reins loops                      Sessions where the agent looped

HOOK ENTRYPOINTS (wired via .claude/settings.json — see \`reins init\`)
  reins hook pre-tool | post-tool | stop

Steering is a soft nudge the model weighs — think "the detail you forgot to put
in the original prompt", not "an order that overrides it". For a hard "never",
use a guard; for a "check with me first", use a guard with --ask; for a
"check with me first" while you're NOT at the terminal, use --hold and review
the queue later with reins pending / approve / deny.`);
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    process.stderr.write("[reins] fatal: " + String(e) + "\n");
    process.exit(1);
  });
