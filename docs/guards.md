# Guards

Guards turn a forbidden command or path into a wall. Mechanism: `PreToolUse` → `permissionDecision: "deny"`. The agent physically cannot proceed with that call — this holds **even under `--permission-mode bypassPermissions`**.

```bash
reins guard list                              # see active rules + their ids
reins guard add bash "psql.*production"       # block a command pattern (regex)
reins guard add path "infra/**"               # block writes to paths (glob)
reins guard add bash "docker .*--privileged" --reason "no privileged containers"
reins guard add bash "git push" --ask         # escalate to YOU instead of denying
reins guard add bash "npm publish" --hold     # park for your LATER approval
reins guard add tool "mcp__stripe__*" --ask   # match by tool NAME — for MCP tools bash/path can't reach
reins guard remove <id>                       # ids shown by `guard list`
reins guard reset                             # back to defaults
```

Rules live in **`.reins/policy.json`** (renamed from `guards.json` in 0.4 — old files still load forever; the first save upgrades in place, and the pre-existing `guards.json` is left untouched, never deleted out from under you). A rule can also carry `"expires": "2026-09-01"` so a temporary hold doesn't outlive its reason — an expired rule is simply inactive, not deleted. `reins doctor` validates the policy file: bad regex/glob, unknown type/action, duplicate ids, a malformed `expires`, and foot-guns like a pattern broad enough to match everything or an `--ask` rule in a headless setup.

<p align="center">
  <img src="https://raw.githubusercontent.com/manishkumar/reins/main/assets/guard-list.svg" alt="reins guard list output: the default denylist plus a hold rule, each with its hardness (deny/ask/hold), pattern, and reason" width="820">
</p>

**`--ask` is the middle hardness.** Some actions aren't *never* — they're *check with me first* (pushes, prod-adjacent commands, package publishes). An `ask` rule doesn't veto; it makes Claude Code pause and show **you** the exact call with your rule's reason, and you approve or deny it in the moment (`permissionDecision: "ask"`).

<p align="center">
  <img src="https://raw.githubusercontent.com/manishkumar/reins/main/assets/ask-prompt.svg" alt="A guard with --ask stopping a git push: Claude Code shows its own permission prompt with the reins rule's reason, and waits for the developer to answer yes or no" width="880">
</p>

One thing to know: it needs a human at the terminal — in a headless/non-interactive run there's no one to ask, so `ask` effectively denies there. When you need a wall that holds unconditionally, that's `deny` (the default); when nobody is watching, that's `--hold`, in [holds.md](holds.md).

Hold rules have their own page: [holds.md](holds.md).

Ships with a sane default denylist (override freely): recursive `rm` at a catastrophic target, recursive `rm` generally (with build artifacts and scratch dirs exempted — see below), `git push --force`, `git push --delete`, `git reset --hard`, `DROP/TRUNCATE`, `curl … | sh`, and writes to `.env*` / `.git/**`.

**Path globs** match the full path *or any segment-aligned suffix*, so `infra/**` catches the absolute `file_path`s Claude Code sends (e.g. `/Users/you/proj/infra/main.tf`) and works with Windows backslashes too.

### What guards are — and are not

Guards are **deterministic vetoes on recognized patterns** — excellent speed bumps against accidents and obvious footguns, **not a sandbox.** The honest limits:

- **They block a *form*, not an *intent*.** Blocked from `rm -rf foo`, an agent may still delete via `find -exec rm`; blocked from a `.env` Write it may try a shell redirect (we block the common redirect forms too, but the cat-and-mouse is unwinnable in general). For containment of a determined/adversarial agent, use OS-level sandboxing and real permission boundaries.
- **They match raw command text, so false positives happen.** `git commit -m "removed the rm -rf call"` will be blocked by the `rm -rf` guard, because the pattern appears in the message. If a guard is too aggressive for your workflow, `reins guard remove <id>` it or edit `.reins/policy.json` — they're fully yours.
- **Heredoc text that is data is not matched.** `python3 - <<'EOF' … EOF` and `cat > notes.md <<EOF … EOF` hand their body to a program as text, so a rule does not fire on what the body says. This applies only when the heredoc feeds `cat`, `tee`, `python`, `node`, `ruby` or `perl`, the opening line has no pipe or command substitution, and the closing delimiter is present. A body fed to a shell, `ssh`, a database client or anything unrecognised is still matched, and so is a body with `$(…)` or a backtick under an unquoted delimiter. The cost is the usual one: a script written this way and run later (`cat > x.sh <<'EOF'` then `sh x.sh`) is not read, the same as a script written with the Write tool.

#### We measured how bad this is

Both limits above used to be stated as theory. Then we read the capture DB of a real project — 51 sessions, 2,396 tool calls, six weeks — and got numbers:

| | |
|---|---|
| Guard firings | **16** |
| That prevented something dangerous | **0** |
| That the agent worked around within seconds | **5 of 5** it retried |
| Median time to bypass | **11 seconds** |

Every firing was a build artifact (`rm -rf .next`) or a scratch file. And the workaround was never clever — it was dropping a flag:

```
14:34:21  DENIED   rm -f src/app/harness/page.tsx && rmdir src/app/harness
14:34:30  ALLOWED  rm    src/app/harness/page.tsx && rmdir src/app/harness
```

Meanwhile the things that repo could genuinely lose data to — `prisma`, `.env` reads, remote branch deletion — ran unguarded the entire time. A `git push --force-with-lease` was denied; `git push origin --delete <branch>` was not.

<details>
<summary>Four changes came out of that, and they're the shape of the honest answer rather than a fix for it: per-argument exemptions, a no-exemption <code>rm-catastrophic</code> rule, cwd-relative matching, and bypass <i>reporting</i> rather than escalation. <i>(expand)</i></summary>

- **Exemptions, matched per argument.** Rules take an `except` list, so `rm -rf` ignores `.next`, `dist`, `node_modules`, `/tmp` and friends. Exemptions are evaluated per command segment and per argument — `rm -rf .next && rm -rf /` is still blocked, and `rm -rf "my build dir"` is not exempted by the word *build* appearing in a phrase.
- **`rm-catastrophic`**, a separate rule with **no exemptions**, for `/`, `~`, `$HOME`, `..` and system directories. Ordered first, so no exemption list can ever wave those through.
- **Exemptions read relative paths from where the agent is standing.** An agent that has already `cd`'d into its scratchpad writes `rm -rf home proj`, not the absolute path — so a `/tmp` exemption written as an absolute prefix never matched the one case it existed for. A relative deletion is now judged from the session's `cwd`. The widening is deliberately narrow: it applies only when the cwd is itself exempted **and every argument in the segment stays inside it**. One absolute path, one `~`, one unexpanded `$VAR`, one `..` that climbs out, or a `cd` anywhere in the command, and the guard fires as before.
- **Bypass reporting.** reins now notices when a denied command's intent runs anyway and says so — per event, and in a session summary at the end of the run. It does *not* widen the guard in response: that's an arms race pattern-matching cannot win. It tells you, so you can fix the rule or make it a `hold`.

</details>

> A guard that is wrong every time is worse than no guard. It trains the agent to route around it and trains you to uninstall it. If reins reports a bypass, the useful response is usually to narrow the rule — or to stop pretending a `deny` can hold something and make it a `--hold` instead.

#### `reins audit --guards` — check yours the same way

That measurement was done by hand, once. It's a command now:

```bash
reins audit --guards          # every denial this project ever recorded, scored
reins audit --guards --json   # same, for scripting
```

```text
reins · guard audit  18 denials across 10 sessions

  rm-rf     16 fired · 15 wouldn't fire under today's shipped rules · 5 worked around, fastest 10s
      ↻ 2026-07-25 rm -f src/app/pdf-harness/page.tsx && rmdir src/app/pdf-harness
        ran anyway 10s later: rm src/app/pdf-harness/page.tsx && rmdir src/app/pdf-harness
```

Two verdicts, both deterministic:

- **stale** — the recorded command doesn't match the rules reins ships *today*. That denial wasn't a judgement call that went the wrong way; it's damage from a rule already fixed upstream, and it means `reins policy upgrade` has real work to do.
- **worked around** — a near-identical call ran later in the same session. The same containment measure live bypass reporting uses, so the two can never disagree.

It reads the capture DB, which the live bypass ledger can't: that ledger is cleared at the end of each run, so cross-project history only ever existed here. Verdicts are computed from what capture stored — whitespace collapsed, long commands truncated — which can only make a rule look *more* likely to fire, so "stale" is under-claimed rather than over-claimed, and truncated rows are marked as such in the output.

### `reins scan` — rules aimed at *your* repo

The default denylist is the same everywhere, which means it's aimed at no one in particular. `reins scan` reads your manifests (`package.json`, `prisma/`, `supabase/`, `alembic.ini`, `*.tf`, `k8s/`, `.env`) and proposes rules for what *this* repo can actually destroy.

```bash
reins scan            # detect + propose; writes .reins/suggested.json, enforces nothing
reins scan --accept   # move the proposals into your policy
```

It is deterministic — no model, no network, no new dependency. Three deliberate constraints:

- **Nothing auto-activates.** Proposals are staged; a human moves them across.
- **No proposal is ever a `deny`.** A hand-written deny is a considered veto; a generated one is a guess. Guesses get `hold` or `ask`; promote one yourself if you mean it.
- **Every detection shows its evidence** — the dependency or file that justifies it.

### Keeping rules current: `reins policy upgrade`

A rule fix is worthless if it never reaches installs that already exist. It used to not: a repo initialized in June was still enforcing June's rules in late July, including a pattern that wrongly blocked plain `rm -f one-file.txt` — fixed upstream weeks earlier, delivered to nobody.

```bash
reins policy upgrade           # show what would change
reins policy upgrade --apply   # apply it
```

Shipped rules carry an `origin` so they can be refreshed while your own rules are left alone; `reins doctor` tells you when yours are stale. Your deliberate edits survive — if you downgraded a rule to `ask` or gave it an `expires`, an upgrade keeps that.

Staleness is read off each **rule**, not off the file. That distinction cost a real install seven weeks: writing the policy file used to stamp it with the *current* generation even when it had never carried one, so a repo could sit at "v2" while enforcing June's rule bodies — and the upgrade, seeing a current version, filed every stale rule under "you customized this" and refused to touch it, permanently. A rule that can't say which generation wrote it is now treated as stale and refreshed. If a shipped rule's pattern is genuinely *yours*, mark it `"origin": "user"` and nothing will ever touch it again.

---

[Back to the README](../README.md)
