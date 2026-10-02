# Claim check and footprint

## Claim check

An agent that edited five files and never ran a test will still tell you the tests pass. Its tool calls are the evidence, and reins reads them when a turn ends:

| verdict | what the calls show |
|---|---|
| **failed** | the last test or build run failed |
| **stale** | files were edited after the last test or build run |
| **unverified** | files were edited and no test or build ran at all |
| **unknown** | a run happened but its result is not visible to reins |
| **verified** | the last run passed and nothing was edited after it |

```
[reins] Claim check: the last test run failed (npm test). reins lastrun lists the calls.
```

That line appears at Stop for **failed**, **stale** and **unverified**, and only when the turn edited code or ran a check, so a turn of conversation does not repeat it. Every verdict, including the quiet ones, is in `reins lastrun`, in the `reins watch` agent row and detail pane, and on each session in `reins report`. Set `"claimCheck": false` in `.reins/config.json` to silence the Stop line.

**It reports and never blocks.** The Stop goes ahead, and no guard, hold or steer reads the verdict. It is deterministic: command text and exit status, no model and no network.

What it can and cannot see:

- **It prefers saying "unknown" to guessing.** `npm test | tail -5` exits with `tail`'s status, so reins cannot tell whether the tests passed and says so. `set -o pipefail` in the command makes the result visible. An interrupted run is unknown too. The same goes for a run whose exit status something replaces: `npm test || true`, `npm test; echo done`, `npm test &` and `if npm test; then …` are unknown. `npm test || exit 1` keeps the failure and is read as a result, and so is a `;` chain under `set -e`.
- **A command counts only at command position.** `grep "npm test" README.md` is not a test run. A run is still found behind `timeout`, `env`, `nice` and `nohup`, inside a subshell (`(cd pkg && npm test)`), inside `bash -c "…"`, and when the runner is called by path (`./node_modules/.bin/jest`). It recognizes the common runners (npm, pnpm, yarn, bun, jest, vitest, pytest, go, cargo, make, maven, gradle, dotnet and others) and build, lint and typecheck commands. A project script named something else (`./ci.sh`, `just verify`) is not recognized, so a session that used one reads as **unverified** or **stale**.
- **Captured commands are cut at 160 characters with newlines collapsed.** A test command on the second line of a multi-line command, or past the cut, is missed or reported as unknown.
- **Edits made through the shell are invisible.** It counts `Edit`, `Write`, `MultiEdit` and `NotebookEdit` calls. A `sed -i` or a script that rewrites files is not counted as an edit. Markdown and text files are not counted either, since a test run does not verify prose.
- **A passing run is the agent's own run.** "verified" means the last test command the agent chose to run exited zero. It does not mean the tests cover the change.
- **It needs capture** (SQLite, Node ≥ 22.5) and the `PostToolUseFailure` hook (see [compatibility.md](compatibility.md)). Without that hook no failed run is ever recorded, and a failing session reads as verified or stale.
- **A pass counts the shell writes it could not see.** When shell commands that can change files ran after the last passing run, the verdict says how many: `tests passed after the last edit; 2 shell commands after it may have changed files`.

## Footprint

Next to the prompt a session was given, reins shows what the session edited and ran, so you can compare the two yourself:

```
asked      the redirect loops on logout
edited 7 files in 3 directories, 31 edits (1 outside the project)
  src/auth/  4 files · 22 edits
  src/billing/  2 files · 8 edits
  ./  1 file · 1 edit
most edited: src/auth/session.ts ×14, src/auth/login.ts ×5, src/billing/invoice.ts ×6
3 shell commands may have changed files too (redirects, sed -i, inline scripts); those files are not listed
ran: npm test ×9 · git status ×4 · grep ×12
```

It is in `reins lastrun`, the agent detail pane of `reins watch`, and each session in `reins report`.

**Facts only.** reins does not say whether the footprint matches the prompt. A session asked about a logout redirect that made 8 edits under `src/billing/` may be drifting or may have found the cause there. Deciding that would take a model, and reins makes no model or network calls.

What it cannot see: a file changed by a shell command is not in the list. It counts the shell commands that could have changed files so the gap is visible, and for an agent that edits through scripts that count can be most of the work. Commands are read from the first 160 characters of each call, and files outside the project are shown by absolute path.

---

[Back to the README](../README.md)
