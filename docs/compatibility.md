# Compatibility

## Node

| | Steering & Guards | Capture (`lastrun`/`loops`/`sessions`) |
|---|---|---|
| **Node ≥ 22.5** | ✅ | ✅ via built-in `node:sqlite` |
| **Node 18–22.4** | ✅ | ✅ *if* you `npm i -g better-sqlite3`, else disabled |
| **`REINS_NO_SQLITE=1`** | ✅ | off by choice |

The live reflexes never touch the database, so they work on **any Node ≥ 18**. Capture needs a synchronous SQLite backend: `node:sqlite` (built in on 22.5+) or the optional `better-sqlite3`. If neither is present, capture **degrades silently** — your agent is never affected — and `reins doctor` / `reins lastrun` tell you why. (Windows, macOS, Linux all supported; path guards normalize separators.)

## Claude Code versions and the `PostToolUseFailure` hook

**Failed commands count, as of the `PostToolUseFailure` hook.** Claude Code sends a tool call that failed (a non-zero exit, a tool error) to `PostToolUseFailure` and not to `PostToolUse`. Installs from before reins registered that hook never captured a failed command, so a test failing on repeat never tripped this alarm and no trajectory showed a failed run. `reins init` adds the hook to an existing install without touching the rest, and `reins doctor` reports an install that is missing it. Restart Claude Code afterwards.

**Claude Code older than 2.0.56 does not have this event, and it loads no hooks at all from a settings file that names it**: no guard, hold or steer runs, and nothing reports an error. Measured by running 2.0.0, 2.0.55 and 2.0.56 against the same file. `reins init` reads `claude --version` and leaves the hook out on those versions, and takes it out of a file an earlier init wrote. Failed tool calls are then not captured, and the claim check cannot see a failing test run.

The fourth hook is written only on evidence that your Claude Code knows it. reins reads the version from `claude --version`, from the environment Claude Code gives the commands it runs (so `reins init` run inside a session knows), and from the version a reins hook last saw in this project. When they disagree it acts on the oldest. When none can be read, init writes the three hooks every version accepts and says so: guards, holds and steering work, and failed tool calls are not captured until you run `reins init` again once a version is known, or pass `reins init --failure-hook` if you know yours is 2.0.56 or newer.

**`reins doctor` also checks the fact itself.** Each hook notes that it ran in `.reins/hooks-seen.json`, and doctor reports whether any hook has run since the settings file last changed. If none has, the version is unknown and the file names `PostToolUseFailure`, doctor reports a problem and tells you to assume no guard is active until one runs. The limits: the note proves hooks loaded at that time, on that machine. It needs one tool call in a session to exist, and a call made by hand (`reins hook pre-tool` with no session id) does not count.

A settings file committed to a repository and shared by a team is read by each person's Claude Code, so one teammate on an old version gets no hooks from a file written for a current one.

---

[Back to the README](../README.md)
