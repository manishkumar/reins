# The hold queue inside Claude Code (experimental mod)

Claude Code 2.1.287 added function hooks ("mods"). `mods/reins-status/` in this repository is one: it reads `.reins/pending/`, refreshed every five seconds and at the end of each turn. Type `/reins` and a pane opens beside the conversation with every hold: its rule and reason, its directory, the whole input (up to 150 lines) and the `reins approve` and `reins deny` commands for it. Claude Code docks the pane as a sidebar in its fullscreen layout from 110 columns, and puts it above the prompt otherwise. When the pane is closed, the status line shows `reins-status: 2 held · /reins`, one line above the prompt names the oldest hold, and a hold that arrives while you are in the session raises a toast once.

```bash
reins init --mod
```

That copies four files into `.claude/skills/reins-status/`, where Claude Code loads a plugin it finds in a project (it lists as `reins-status@skills-dir` in `claude plugin list`). It is opt-in: plain `reins init` installs no mod. If a folder of that name exists and is not this mod, reins leaves it untouched and says so. `reins uninstall` removes the four files and any folder that leaves empty. To try it without installing, run `claude --plugin-dir <reins package>/mods/reins-status`.

**It shows the queue and never answers it.** There is no approve or deny control on it, and it hooks no tool call. The reason is measured, in [docs/mods-probe.md](mods-probe.md): the mod engine skips a hook that throws or runs past its 10 seconds and lets the tool call go ahead, so a hold enforced by a mod would fail open. The reins gate stays a command hook. Approving stays in `reins approve` and `reins watch`.

The caveats. The mod API is early access and can change in any Claude Code release, and this mod then stops loading until it is updated. It was tested with `claude plugin test` against the engine, with the file system and clock mocked. Installed through `.claude/skills/`, it was seen to load and set the status line in a headless run. The status line, the line above the prompt and the `/reins` pane have been seen in a live interactive session, on one terminal and one Claude Code version (2.1.287). The toast has not: it passes `claude plugin test` and is otherwise unverified. The pane does not mark which line the rule matched; `reins watch` does. The pane opens only when you type `/reins`, never on its own. Claude Code loads a project's plugins only after the workspace is trusted, so the mod does not load in a folder you have not trusted, and the hooks still run there. `.claude/skills/` is usually committed, so installing the mod puts it in front of everyone who works in the repository. The copy is not updated when reins is: run `reins init --mod` again after upgrading. It finds `.reins/` by walking up from the session's directory, so it works from a subdirectory. It uses no SQLite and makes no network call.

---

[Back to the README](../README.md)
