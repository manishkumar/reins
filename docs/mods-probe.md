# Mod probe

Claude Code 2.1.287 ships function hooks ("mods"): TypeScript modules that run
inside the Claude Code process and can hook tool calls, draw UI and read
files. This file records what was measured about them on 2 October 2026, and
what that means for reins.

The mod API is marked early access in its own declarations. Everything below
is true of 2.1.287 and may change.

## How it was tested

`mods/probe/` is a mod whose `tool.call` hook misbehaves on request: it
throws, waits, blocks, or opens a dialog, depending on a marker in the Bash
command. `mods/probe/hooks/probe.test.ts` drives it through the engine with
`claude plugin test mods/probe`. That command loads the mod with the engine's
own host and runs each test in a child of the Claude Code binary. All eight
tests pass. To repeat it:

```
claude plugin validate mods/probe
claude plugin test mods/probe     # about 45 seconds, no model calls
```

What this harness is and is not: it is the real engine dispatching the real
hook chain, with the tool itself, the settings hooks and the dialog replaced
by hooks the test registers at the bottom of the chain. It is not an
interactive session. Nothing here was observed in a live terminal with a
person answering a dialog.

## Question 1: does a blocking dialog count against the 10-second budget?

No.

A hook has 10,000 ms per dispatch (`HookBudget.ms` in the declarations). The
budget covers the hook's own time. Time spent inside a `$` call or inside
`next(e)` is not charged, and `$.ui.ask` is a `$` call.

Measured: the probe hook waits 6 s, then calls `$.ui.ask`, and the dialog
takes another 6 s to answer. The hook has been running for 12 s when it
returns `{ deny }`, and the deny stands. A hook that waits 10.5 s on its own,
with no `$` call in flight, is cut off at 10.0 s (next question).

The one exception the declarations name is `$.clock.sleep`, which is charged.
That was not measured: the test host has no clock, only a mocked one.

## Question 2: what happens on timeout or crash?

The hook is skipped and the tool call runs. A mod fails open.

| The hook | What the engine did |
| --- | --- |
| throws | Skipped. The call ran. The failure is reported by name. |
| waits 10.5 s without blocking | Skipped at 10.0 s (measured 10,008 to 10,013 ms). The call ran. The `{ deny }` it returned later was discarded. |
| waits 10.5 s and has a `.catch` handler | The handler ran at 10.0 s and its `{ deny }` stood. The handler has 1 s of its own (`catchMs`). |
| blocks the event loop for 10.5 s (a busy loop) | Not cut off. Its `{ deny }` stood after 10.5 s. |
| spends 3 s and returns `{ deny }` | The deny stood. |

The fourth row was not expected. The budget is enforced by the event loop, so
a hook that never yields cannot be interrupted, and the whole session waits
for it. A synchronous regex with catastrophic backtracking would freeze Claude
Code and then still be honoured.

Where the failure is reported: in the transcript as one dim line while the
session hot-reloads the mod's folder, and in the debug log otherwise
(`claude --debug`). In an ordinary session the person sees nothing.

## Question 3: where do mods sit relative to command hooks?

Above them. The declarations give the chain for a classic event as
`[managed settings hooks, ...hooks modules, the other settings hooks as core]`.

Measured, for a tool call:

1. The mod's `tool.call` hook runs first. When it rewrites the command with
   `next({ ...e, command })`, the settings `PreToolUse` hook receives the
   rewritten command.
2. `PreToolUse` runs next, beneath every mod's `tool.call` hook.
3. A `PreToolUse` deny ends the call. The tool does not run. The mod's
   `await next(e)` resolves to an errored result carrying the reason.

The declarations add two things that were not measured: managed (enterprise)
settings hooks run above every mod and their deny is final, and the permission
check and its dialog run after both.

## What this means for reins

**The reins gate stays a command hook.** reins is a `PreToolUse` command hook
registered in `.claude/settings.json`. Three results above settle this:

- A mod fails open on a throw and on a timeout. That is the right default for
  a guard (invariant 1) and the wrong one for a hold, which must fail closed.
  A `.catch` handler that denies would close the gap, but it has 1 s, and the
  failure is silent in an ordinary session.
- A mod's deny can be discarded by the engine for running long. A command
  hook's deny cannot.
- A command hook runs in its own process. It cannot freeze the session.

**A mod above reins can change what reins sees.** A mod's `tool.call` hook
can rewrite a command before `PreToolUse` reads it. reins then matches,
parks and approves the rewritten command, which is the one that would run, so
an approval still names what executes. What a mod can also do is answer the
call itself with `{ result }` and never call `next`, and then no `PreToolUse`
hook runs at all. This is the same trust boundary as any code the person
installs in their own Claude Code, and it is now a caveat in the README's
threat model.

**What a mod is good for here is display.** `mods/reins-status/` reads
`.reins/pending/` and shows a count in the status line and the oldest holds in
a band above the prompt. It hooks no `tool.call` and has no approve or deny
control. If it fails, the band is empty and nothing else changes.

## Not verified

- Anything in a live interactive session: the real dialog, the real status
  line, the band's appearance, hot reload.
- `$.clock.sleep` being charged to the budget.
- Managed settings hooks running above mods.
- The 5 s linger bound (`lingerMs`) after a hook is abandoned.
- Any Claude Code version other than 2.1.287.
