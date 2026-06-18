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
    case "lastrun": {
      const { cmdLastrun } = await import("./commands/lastrun");
      return cmdLastrun(rest);
    }
    case "loops": {
      const { cmdLoops } = await import("./commands/loops");
      return cmdLoops();
    }
    case "init": {
      const { cmdInit } = await import("./commands/init");
      return cmdInit();
    }
    case "version":
    case "--version":
    case "-v":
      console.log(require("../package.json").version);
      return 0;
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
  reins init                       Set up .reins/ and print the hooks block
  reins steer "<message>"          Queue live steering for the next tool call
  reins steer                      Show pending steering
  reins steer --clear              Clear pending steering
  reins guard list                 Show guard rules (hard vetoes)
  reins guard add bash "<regex>"   Block matching Bash commands
  reins guard add path "<glob>"    Block writes to matching paths (e.g. **/.env)
  reins guard remove <id>          Remove a guard
  reins guard reset                Restore default guards
  reins lastrun [session-prefix]   Readable account of the most recent run
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
