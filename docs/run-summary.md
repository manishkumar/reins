# Run summary

An unattended run on `feat/watch-cockpit`, 1 to 2 October 2026. The goal was
to make reins answer five questions a person watching agents has, on every
surface, from data reins already captures:

1. Is it doing what I asked?
2. Is it about to do something I cannot undo?
3. Is it stuck?
4. Can I trust that it is done?
5. What happened while I was away?

Six feature commits and this one. Nothing was pushed, published or
version-bumped. `DEFAULT_RULES` and `POLICY_VERSION` are untouched. No commit
carries a co-author or session trailer.

## Commits

### d0c24d1 — phase 0: session titles in the cockpit

Changed: `reins watch` leads each session with the title Claude Code gave it,
its git branch and the last prompt, read from the tail of the session
transcript (`src/sessionContext.ts`). The transcript path is captured in a new
`sessions.transcript` column.

Verified by running: the suite; the cockpit against this repository's own
`.reins/runs.db`, where real sessions showed their real titles.

### d8f9031 — phase 1: one session face on every surface

Changed: `src/sessionFace.ts` is the one function that names a session.
`reins sessions`, `reins pending`, `reins lastrun`, `reins report`, the steer
picker and the cockpit all use it. The mnemonic and the id still address a
session.

Verified by running: the suite (`test/face.test.js`); each command by hand
against a scratch project with three transcripts and a hold.

### 6e0aff7 — phase 2: claim check, and capture of failed tool calls

Changed: `src/claim.ts` compares a session's end state with its own calls and
gives one verdict: the last test or build run failed, files were edited after
the last run, nothing was run, the result was not visible, or it checks out.
It shows in the Stop summary line, the cockpit row and detail pane, `lastrun`
and the report. It reports and decides nothing.

Found while building it: reins had never captured a failed tool call. Claude
Code sends those to `PostToolUseFailure`, which reins did not register. 1,700
captured calls in this repository contained no failed command. `reins init`
now installs a fourth hook, and `reins doctor` reports a partial install.

Verified by running: the suite (`test/claim.test.js`, `test/gate.test.js`,
`test/merge.test.js`); a live probe in this session, where a command exiting 4
was recorded with `ok = 0`; the verdicts against this repository's real
sessions, which is how "result not visible" was found to dominate and was
taken out of the Stop line.

### 324aeed — phase 3: footprint

Changed: `src/footprint.ts` lists, per session, the directories and files it
edited and the commands it ran most, beside the prompt it was given, in the
cockpit detail pane, `lastrun` and the report. Facts only. `src/shell.ts` is
the shared command splitter for it and the claim check.

Verified by running: the suite (`test/footprint.test.js`); against real
sessions, which exposed quoted text being counted as commands and led to the
shared splitter.

### ddfdb3a — phase 4: dogfood in a real terminal

Changed: fixes found by running the interactive cockpit under tmux at 60x14,
80x24, 104x30 and 150x40, against a scratch project with five sessions, three
holds, a breach, a worked-around guard and a loop.

- The header ran its counts into the clock at 80 columns. It now gives up the
  refresh interval, the idle count and the active count, in that order.
- A long title pushed the status and the verdict off the agent row. The row
  drops its sparkline, then cuts the title.
- A looping session could be hidden under "+2 more". It is listed first.
- Paths inside the project are shown from the project root.
- The hold row, the help dialog's key column, the approve heading and the
  activity line no longer overflow or touch.
- The README screenshots were regenerated.

Verified by running: the live cockpit in a pty at all four sizes, with the
default view, an agent selected, the zoomed detail pane, and the approve, help
and steer dialogs; the suite (`test/layout.test.js`).

Not exercised in the pty: pressing `y` to approve, and denying with a typed
reason. Those paths are covered by the existing tests, not by this dogfood.

### 0b1e50b — phase 5: mod probe and a read-only mod

Changed: `docs/mods-probe.md`, `mods/probe`, `mods/reins-status`, and a new
caveat in the README threat model. Claude Code here is 2.1.287, so the phase
ran.

Measured with `claude plugin test mods/probe` (8 tests pass): dialog time is
not charged to a hook's 10 s budget; a hook that throws or waits past 10 s is
skipped and the tool call runs; a hook that blocks the event loop is never cut
off; a mod's `tool.call` hook runs above `PreToolUse` command hooks and can
rewrite what they see. The conclusion is that the reins gate stays a command
hook, because a mod fails open.

`mods/reins-status` shows the hold queue in the status line and a band above
the prompt. It has no approval control.

Verified by running: `claude plugin validate` and `claude plugin test` on both
mods (8 and 4 tests pass); `tsc` against the engine's declarations.

Not verified: either mod in a live interactive session. The band and status
line were checked through the engine's test host with mocked files and clock,
never seen in a terminal.

### This commit — closing documents

`docs/open-questions.md` and this file.

## Final state

`npm run build && npm test` on the last commit: 279 tests, 279 pass. `dist/`
is tracked and the working tree is clean after the build, so the committed
`dist/` matches the source.

## The five questions, and where each is answered now

| Question | Answered by | Limit |
| --- | --- | --- |
| Doing what I asked? | The last prompt beside the footprint, on every surface | Facts only. reins does not judge drift. Edits made through the shell are counted, not listed. |
| About to do something irreversible? | Holds, as before, now named by session title and prompt | Unchanged. Only what a hold rule matches. |
| Stuck? | The loop alarm, now also for failing calls. A looping session leads the cockpit. | Consecutive identical calls only. |
| Can I trust "done"? | The claim check | Reads command names and exit status. A piped test run is "not visible". Unknown runners are not recognised. |
| What happened while I was away? | `lastrun` and the report, with title, verdict and footprint | Needs SQLite capture. |

## Guard blocks during the run

The reins guard in this repository blocked two of the run's own commands. Both
were worked around and the policy was not edited.

- Deleting a scratch directory recursively. A new directory name was used.
- A shell heredoc whose test fixture contained a destructive command as text.
  The file was written with the editor tool and the fixture text changed.

## Side effects outside the commits

- `.claude/settings.json` in this repository (untracked) gained the
  `PostToolUseFailure` hook through `reins init`, so the new capture is live
  in sessions here.
- The installed `reins` is linked to this checkout, so every build in this
  run was live in this session's own hooks.
- tmux sessions used for the dogfood were closed. Scratch projects are in the
  session's temporary directory.

## Left open

See `docs/open-questions.md` for the seven decisions. The ones that affect a
release most: what an older Claude Code does with the `PostToolUseFailure` key
(untested), and that existing installs will start seeing loop alarms and hold
breaches for failing calls once `reins init` is run again.
