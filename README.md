<div align="center">

# 🐎 reins

### Steer a running Claude Code agent — without stopping it

Nudge it mid-run · hard-block what it must never do · get warned when it loops · keep every run in a SQLite file you own

[![CI](https://github.com/manishkumar/reins/actions/workflows/ci.yml/badge.svg)](https://github.com/manishkumar/reins/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node ≥ 18](https://img.shields.io/badge/node-%E2%89%A5%2018-brightgreen)](#compatibility)
![Dependencies: zero](https://img.shields.io/badge/runtime%20deps-zero-brightgreen)
[![Network calls: zero](https://img.shields.io/badge/network%20calls-zero-8a2be2)](#local-first-guarantee)

**[Install](#install) · [60-second start](#60-second-first-run) · [Guards](#guard--the-hard-veto-and-the-escalation) · [The cockpit](#reins-watch--the-multi-agent-cockpit) · [How it works](#how-it-works-one-breath)**

</div>

```text
# terminal 1 — the agent is mid-task, and you can see it drifting
  ⏺ Edit(src/login/flow.ts)         ← wait, why is it in the login flow?

# terminal 2 — you, without killing the run
  $ reins steer "focus on the token refresh path — don't touch the login flow"
  ✓ queued — lands at the agent's next tool call

# terminal 1 — next tool boundary, same run, context intact
  ⏺ [reins — live steering from the developer] folded in
  ⏺ Edit(src/auth/refresh.ts)       ← back on course
```

Local-first. No daemon. No backend. No account. Nothing leaves your machine.

<p align="center">
  <img src="https://raw.githubusercontent.com/manishkumar/reins/main/assets/steer-picker.svg" alt="reins steer with several live sessions: a picker lists each agent by name with its status and last tool call, and asks where the steer should land" width="920">
</p>

---

## Why this exists

> Reins guide a galloping horse without stopping it. That's the whole idea: nudge the agent while it runs, veto what it must never do, and keep a record — all from your terminal.

You're watching an agent work and you can see it drifting — over-engineering, editing the wrong module, about to run something destructive. Today your only options are to let it finish and clean up, or kill it and lose all its in-flight context.

`reins` gives you a middle path built from four Claude Code hooks:

| When | Reflex | What it does | Hardness |
|---|---|---|---|
| **Before** a tool runs | ⛔ **Guard** | Hard-vetoes forbidden commands/paths (`rm -rf`, writes to `.env`, …) — or escalates to you with `--ask`, or **parks the action for your later approval** with `--hold` (natively, via Claude Code's `defer`, where it's honored — deny-and-queue everywhere else) | Hard veto (deny) / your call (ask) / your call, later (hold) |
| **During** the run | ✎ **Steer** | Injects a one-line course-correction at the next tool boundary | Soft — the model weighs it |
| **After each** tool | ⟳ **Loop alarm** | Warns inline when the same call repeats N times in a row | Observe + warn |
| **At the end** | ▶ **Capture** | Logs the run's trajectory + outcome to SQLite | Observe |

The steering is the headline. The SQLite log is a **byproduct** — you never have to open it for the tool to earn its place.

> 📖 **The story behind reins** — why the durable part turned out to be the gate, not the steering, and what a brutal self-review got right: [*I Built a Tool to Steer Running AI Agents. It Taught Me Where Their Real Cost Is.*](https://medium.com/@manishky/i-built-a-tool-to-steer-running-ai-agents-it-taught-me-where-their-real-cost-is-fc617abfcb07)

---

## Install

```bash
npm install -g @manishky/reins
reins version
```

> Prefer installing straight from GitHub? `npm install -g github:manishkumar/reins` works too — no build step. Both put the same `reins` on your PATH.

<details>
<summary>Prefer a local checkout (for hacking on it)?</summary>

```bash
git clone https://github.com/manishkumar/reins && cd reins
npm install && npm run build && npm link
```

</details>

Requires **Node ≥ 18**. (Capture uses SQLite — built in on Node ≥ 22.5, optional on older Node; see [Compatibility](#compatibility). Steering and guards work on any Node ≥ 18.)

---

## 60-second first run

```bash
cd your-project
reins init          # creates .reins/ AND wires the hooks into .claude/settings.json
```

`reins init` does the wiring for you — it merges the four hooks (`PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `Stop`) into `.claude/settings.json` (creating it if needed, never clobbering existing settings). Then **restart Claude Code in this project** so it loads them.

Prefer to paste it yourself? `reins init --print` prints the block instead. Want it in `settings.local.json` (not committed)? `reins init --local`.

Now, the headline — **steering**:

1. Kick off any real task in Claude Code (e.g. *"add token refresh to the auth module"*).
2. While it's running, in another terminal:

   ```bash
   reins steer "focus the auth work on the token refresh path — don't touch the login flow"
   ```

3. At its **next tool call**, the agent picks up your note and course-corrects. The run never stopped; no context was lost.

Not sure it's all hooked up? Run **`reins doctor`** — it checks your Node/capture capability, whether the hooks are wired, `.reins` writability, and pending steering.

### The two honest caveats (this is the product, read them)

**1. Latency: next tool boundary, not "right now."** A `PreToolUse` hook only fires when the agent is *about to call a tool*. So steering lands at the agent's next decision point — usually seconds away, but not instantaneous. This is the correct async model (you can't babysit an agent keystroke-by-keystroke), and it's why the verbs are "steer" and "nudge," never "stop" or "interrupt."

One delivery guarantee: if there **is** no next tool call — you steered as the agent was already finishing — the Stop hook delivers the nudge instead, briefly holding the stop and handing the note over. A queued steer is never silently lost.

**2. Steering composes with the goal; it can't overwrite it.** Think of `reins steer` as **the detail you forgot to put in the original prompt** — added spec from the same author. *"focus on the token refresh path"*, *"keep it minimal"*, *"use the existing logger"*. It does **not** work as a hijack: a nudge that flatly contradicts the user's explicit instructions ("STOP, ignore everything, do X instead") is correctly weighed down by the model. Since the person typing `reins steer` is the same person who wrote the prompt, this is rarely a real constraint — just phrase steering as *more spec*, not *a reversal*. **If you need a hard "never do X," that's a guard, not steering.**

Two quick `reins steer`s before the next tool call **both** reach the agent (they append). Use `--replace` to overwrite, `reins steer --clear` to reset.

**Running several agents in one repo?** A plain `reins steer` is a *broadcast* — it lands on whichever session hits the next tool boundary first. When more than one session has been active in the last ~15 minutes and you're at a terminal, `reins steer "<msg>"` **lists them and asks which one you mean** (name, id, liveness, last tool call) — press Enter to keep the broadcast, pick a number to target, `--broadcast` to skip the question. Piped/scripted invocations are never prompted; they broadcast exactly as before.

To aim without the picker, target a session by id prefix, its auto mnemonic, or a name you gave it:

```bash
reins sessions                                   # every session has a name under its title: rosy-egret a2cbbe90
reins name a2cbbe90 "payments-agent"             # ...or give it your own
reins steer "stay on the payments module" --session payments-agent
```

A targeted nudge only reaches that session; broadcasts still go to everyone else. Names are display and addressing sugar stored in the local capture DB (so custom names need `node:sqlite`, Node ≥ 22.5) — the auto mnemonics are derived from the session id and work everywhere. Steering files, holds, and approvals stay keyed by the real session id; nothing control-plane ever depends on a name resolving.

---

## Guard — the hard veto (and the escalation)

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

One thing to know: it needs a human at the terminal — in a headless/non-interactive run there's no one to ask, so `ask` effectively denies there. When you need a wall that holds unconditionally, that's `deny` (the default); when nobody is watching, that's `--hold`, below.

### `--hold` — the approval queue, for the run nobody is watching

`ask` needs you at the terminal. **`hold` is `ask` for the agent that runs while you sleep.** A hold rule doesn't kill the attempt against a wall — it **parks the proposed action** and waits for you. The run survives; the action doesn't happen without you.

Since 0.4, hold has two transports — **deny-and-queue**, the default, which works everywhere, and **defer**, which parks the real call inside Claude Code so approving replays the original. Defer is opt-in, because Claude Code can drop it in ways a hook can't see.

<details>
<summary>How the two transports differ, and why defer is opt-in. <i>(expand)</i></summary>

- **deny (the default, works everywhere).** The attempt is denied and the proposal is copied into `.reins/pending/`. Approving lets an identical retry, from the same directory, through; a still-running agent is steered to make it.
- **defer (opt-in).** In an environment Claude Code is verified to honor it — print mode, `claude -p` or the SDK — reins returns `permissionDecision: "defer"`. Claude Code parks the *actual tool call* inside the session itself (the turn ends with `stop_reason: "tool_deferred"`) instead of copying it into a queue. Resuming the session (`claude --resume <id> -p "continue"`) replays that **exact** call through the hook, so approving runs the original proposal — the agent never has to reconstruct it.
To opt in, set `"holdTransport": "auto"` in `.reins/config.json`. reins then uses defer only when it can **confirm** the run is headless (`claude -p` / the SDK) by reading the Claude Code process's own command line, and falls back to deny for anything it can't confirm (an interactive session, Windows, or not being able to tell). Even confirmed, defer has a gap: Claude Code ignores it when the model made several tool calls at once, and the held action then runs (see the caveats below). Earlier versions made `auto` the default; it stopped being one because a hold that silently stops holding is worse than one that always works. `"defer"` forces defer without checking, and `"deny"` is the default.

</details>

```bash
reins guard add bash "git push" --hold        # park pushes instead of denying
# ...the agent runs overnight, tries to push, gets parked, keeps working...

reins pending                                 # morning: what did they want to do?
#   ab12cd34  7h  3b9f2a1c  Bash  git push origin main  [bash-git-push]

reins approve ab12cd34                        # sign off — the agent may retry (or resume) it
reins deny ab12cd34 --steer "open a PR instead of pushing to main"
```

<p align="center">
  <img src="https://raw.githubusercontent.com/manishkumar/reins/main/assets/hold-queue.svg" alt="The full hold-queue loop: a hold rule parks the agent's npm install and shows you a one-line HELD notice with the approve command, reins pending lists it, reins approve signs it off, and the agent's retry runs at its next tool boundary" width="720">
</p>

<details>
<summary><b>Field note</b> — the first action ever parked by this queue was reins' own release, and the same afternoon it also parked a false positive. <i>(expand)</i></summary>

> While building this feature we put a `--hold` rule on `git push` in this very repo. An agent session finished the work, tried to push its own commits, and got parked (`f27f93b3`). The developer refused it — `reins deny f27f93b3 --steer "i pushed myself"` — and the refusal reached the still-running agent at its next tool call, which acknowledged and moved on. The same afternoon the rule also parked a **false positive**: a script whose *text* merely mentioned the push command. That's the "form, not intent" caveat below doing exactly what it says — both halves of the trade-off, live, on day one.

</details>

`reins approve` writes a **one-shot decision keyed to the exact proposal** — the deferred call's own id when Claude Code preserved it, otherwise this session's exact input hash from the same working directory — and hands you what to do next: for a still-running deny-transport hold it steers the session to retry; for a deferred hold it prints the `claude --resume` command, because an approval nobody resumes is the quietest possible failure. Sessions that end with parked actions say so in `reins sessions` / `reins lastrun` (⏳ awaiting approval), and the trajectory (`reins audit`, below) records `HELD` / `APPROVED` / `REFUSED` with the rule and queue ids.

**A park reads as one line, not a paragraph.** The deny reason was always on screen — Claude Code renders it as the tool's error — but it's sixty words aimed at redirecting the *model*, with the id and the approve command buried mid-sentence. reins now also puts a scannable line in front of *you*: `⏸ HELD  git push origin main`, and the exact `reins approve <id>` to run. No settings change, no second terminal. `reins watch` is still the right tool for several agents at once; this is for the session you're already looking at.

<details>
<summary><b>The honest caveats, as always</b> — what a hold can and can't promise: transport limits, one-shot exact approval, HOLD BREACH reporting, and why hold is the one thing in reins that fails <i>closed</i>. <i>(expand — read before you rely on it unattended)</i></summary>

- **You're notified once per parked action, not once per attempt.** If the agent re-proposes something already in the queue, that's the same decision, and re-notifying would train you to ignore the line that matters. The action stays held either way — quieter is not weaker. The full queue is always `reins pending`.
- **Defer is off unless you turn it on.** Everything in the next two bullets applies only if you set `holdTransport` to `"auto"` or `"defer"`. The default, deny-and-queue, has neither gap.
- **Defer is print-mode only.** Claude Code silently discards a deferred decision in an interactive terminal session. With `"auto"`, reins only uses defer when it can confirm the run is headless; on Windows, or whenever it can't tell, you get deny-and-queue instead.
- **Defer is solo-call only.** Claude Code also ignores defer when the model emitted several tool calls in one assistant message — invisible to a single `PreToolUse` invocation, so reins cannot detect it ahead of time and the held call can fall through to the normal permission flow (which may allow it under a permissive `--permission-mode`). Because that gap can't be closed at the boundary, `PostToolUse` and `PostToolUseFailure` check the queue from the far side instead: an action that executed while still parked is reported as a **HOLD BREACH**, whether or not the action itself succeeded, on stderr and recorded (`reins audit`). Detection, not prevention: for a deploy or a publish, the report arrives after the fact. This is why defer is opt-in.
- **Approval is exact and one-shot.** By input hash for a deny-transport hold, by call id for a deferred one — either way a *changed* retry, even one flag, is a new proposal that parks again. A deny-transport approval is **scoped to the session that proposed it** (since 0.4; before that a second session running the identical command could consume the first's approval) and **to the directory it was proposed from** (earlier versions let `./deploy.sh` approved in `staging/` also run in `prod/` in the same session). `reins pending` shows the directory whenever it isn't the project root. Symlinks are resolved, so an approval given in `current/` doesn't carry over after `current` is repointed.
- **Only the newest deferred hold in a session survives resume.** If the same session parks a second call before you get to the first, Claude Code replays only the most recent on resume — the older one won't come back. `reins pending` marks it `⏸ superseded`; approving it still files the decision, but it takes effect only if the agent proposes that action again.
- **Same machine, same repo.** The queue is files in `.reins/` (`pending/`, `decided/` — renamed from `allowed/` in 0.4; pre-0.4 `allowed/` files are no longer read, because they were keyed by the bare input hash and any session could spend them); there's no server, so you review from a terminal on the same checkout. (Remote/notify hook-ups are deliberately out of scope for now.)
- **Approval doesn't re-run anything.** It permits the retry or the replay; making it happen still needs a still-running agent to act on the steer, or that session to be resumed.
- **Refusals land at the boundary.** `reins deny <id> [--steer "..."]` files the refusal, and the agent (or the resumed session) is told the moment it comes back for that exact action — it doesn't sit re-parked, unresolved, forever.
- **Hold biases closed — uniquely in reins.** If parking itself fails (say `.reins/` is unwritable), the call is denied outright rather than allowed through. The fail-open caveat still applies one level up: a *crashing* hook process fails open, as everywhere.

</details>

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

## Loop alarm

When the agent runs the **same tool with identical input** ≥ N times **in a row** (default 3), `reins` injects an inline warning at that tool boundary nudging it to try something else, and records the loop. Consecutive is the operative word: re-running `npm test` after each edit is healthy iteration and never trips the alarm — the same call three times *with nothing in between* does.

```bash
reins loops          # list sessions where loops happened
```

Tune the threshold in `.reins/config.json` (`"loopThreshold"`).

**Failed commands count, as of the `PostToolUseFailure` hook.** Claude Code sends a tool call that failed (a non-zero exit, a tool error) to `PostToolUseFailure` and not to `PostToolUse`. Installs from before reins registered that hook never captured a failed command, so a test failing on repeat never tripped this alarm and no trajectory showed a failed run. `reins init` adds the hook to an existing install without touching the rest, and `reins doctor` reports an install that is missing it. Restart Claude Code afterwards.

---

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

- **It prefers saying "unknown" to guessing.** `npm test | tail -5` exits with `tail`'s status, so reins cannot tell whether the tests passed and says so. `set -o pipefail` in the command makes the result visible. An interrupted run is unknown too.
- **A command counts only at command position.** `grep "npm test" README.md` is not a test run. It recognizes the common runners (npm, pnpm, yarn, bun, jest, vitest, pytest, go, cargo, make, maven, gradle, dotnet and others) and build, lint and typecheck commands. A project script named something else (`./ci.sh`, `just verify`) is not recognized, so a session that used one reads as **unverified** or **stale**.
- **Captured commands are cut at 160 characters with newlines collapsed.** A test command on the second line of a multi-line command, or past the cut, is missed or reported as unknown.
- **Edits made through the shell are invisible.** It counts `Edit`, `Write`, `MultiEdit` and `NotebookEdit` calls. A `sed -i` or a script that rewrites files is not counted as an edit. Markdown and text files are not counted either, since a test run does not verify prose.
- **A passing run is the agent's own run.** "verified" means the last test command the agent chose to run exited zero. It does not mean the tests cover the change.
- **It needs capture** (SQLite, Node ≥ 22.5) and the `PostToolUseFailure` hook above. Without that hook no failed run is ever recorded, and a failing session reads as verified or stale.
- **A pass counts the shell writes it could not see.** When shell commands that can change files ran after the last passing run, the verdict says how many: `tests passed after the last edit; 2 shell commands after it may have changed files`.

---

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

## Capture: `reins lastrun`, `reins sessions`, `reins loops`

The daily *"what the hell did it just do"* commands. A clean, scannable account of a run — like a `git diff` for agent behavior.

```text
$ reins lastrun
reins · last run
  session  3b9f2a1c-…
  repo     /Users/you/project
  when     2026-06-18T14:22:04Z  (3m 11s)
  outcome  completed
  totals   42 tool calls · 128,540 tokens

Trajectory
  ⛔ Bash       rm -rf build/
  ✎ Write      src/auth/refresh.ts
  ✏ Edit       src/auth/index.ts
  ▶ Bash       npm test ⟳
  ▶ Bash       npm test ⟳
  ▶ Bash       npm test ⟳

Summary
  files touched  2
  commands run   8
  blocked        1 (guard vetoes)
  loops          1 (repeated ≥ 3×)
    ⟳ Bash ×3: npm test
```

- `reins sessions` — list recent sessions in the project (what each is about, status, call count, time), with the name and short id you address it by, its branch and its last prompt on the line below. Handy when several agents have run in one repo. Every session gets a deterministic mnemonic (`rosy-egret`) derived from its id; `reins name <session> "<label>"` replaces it with something meaningful to you (`--clear` reverts). Names work anywhere a session id does: `steer --session`, `lastrun`, the steer picker.
- `reins lastrun <session>` — inspect a specific older run (id prefix or name).
- `reins loops` — just the sessions where the agent got stuck.

### `reins watch` — the cockpit

`reins sessions` is a snapshot; **`reins watch` is where you run things from.** One screen shows every agent in the repo and everything waiting on you, and it has the controls to answer: approve or deny a held action, and steer one agent or all of them. It's built for the case a built-in queued message can't serve: several agents running and one person watching.

<p align="center">
  <img src="https://raw.githubusercontent.com/manishkumar/reins/main/assets/watch.svg" alt="reins watch: a NEEDS YOU pane with a held npm publish and a worked-around guard, an AGENTS pane where each session shows its title, status, claim check verdict, branch and last prompt, and a detail pane showing the held action's rule, session, directory and full proposed input" width="760">
</p>

- **NEEDS YOU**, top left: every held action, plus hold breaches and worked-around guards from the last 7 days. It reads from `.reins/pending/` and the bypass ledger, so it works without SQLite.
- **AGENTS**, below: each session leads with what it is about, then its live status (`active` / `looping` / `idle` / `done`) and, where the row has room, its call count and a sparkline of its calls over the last 12 minutes. The second line has the name and short id you address it by, its git branch, and the last prompt you sent it. The third has its last call, queued steer, or held action; a call that did not simply run says what happened to it (`failed`, `denied`, `held`, `approved`, `refused`). A session with no title, branch or prompt takes two lines, with its id beside its name. An agent that is not working also carries its [claim check](#claim-check) verdict beside the status, except "result not visible", which is in the detail pane only: agents pipe test output by habit, and a chip on half the rows says nothing. Status comes from recent tool activity, not the per-turn Stop hook, so an agent mid-conversation reads `active`. `looping` means the same call several times in a row, as the loop alarm counts it. A looping session is listed first, then sessions with a held action, and the rest follow newest first, so on a short terminal the list is cut from the quiet end. A session with no call for over a day is counted in the pane's footer and not listed, unless it is looping, holds an action or has a steer queued; `reins sessions` lists them all. File paths inside the project are shown from the project root.
- **When the terminal is narrow**, text is cut in a fixed order. The header gives up the refresh interval, then the idle count, then the active count. What needs you and the looping count stay. An agent row gives up its sparkline, then its call count, then the end of its title. The status and the verdict stay. A hold row cuts the session title before the rule id. Below 104 columns the detail pane is hidden until you press `⏎`. The minimum is 60×14.
- **Detail**, right: for a hold, the rule, reason, session, the prompt that session was last given, directory, transport, and the **full proposed input** with the text the rule matched highlighted. When that text is below the third line of a long command, the matched line is also shown above the input, with its line number, so you do not have to find it. The approve dialog shows the same. The match is found with the guard's own matcher against the rule as it stands now; if the rule was edited or removed since the action parked, nothing is highlighted. Only Bash rules are located this way. A session that proposed a deny-transport hold and has made no call for over a day is said so, since an approval is used only if it retries. For an agent, its branch, last prompt, claim check verdict, footprint, activity and trajectory, newest first. `⏎` zooms it to full screen.

**Where a session's title comes from.** The cockpit, `reins sessions`, `reins pending`, `reins lastrun`, the steer picker and the report all name a session the same way. A name set with `reins name` leads. Otherwise they show the title Claude Code gave the session (the one in its own session list, or the one you set with `/rename`), read from the tail of the session transcript along with the branch and last prompt. Without a transcript the `brave-otter` mnemonic leads, as before. The caveats: the transcript format is not a documented interface, so a Claude Code update can turn titles back into mnemonics until reins catches up. The path is recorded by capture, so titles need SQLite (Node ≥ 22.5), and a session shows its title after its first completed tool call under this version. Claude Code titles a session early, so a long session's title can describe where it started. The last prompt is the current one. The title, branch and prompt are display only. `reins steer` still takes the id, the mnemonic or your custom name, and no guard or hold reads them.

| key | does |
|---|---|
| `↑↓` `j k` · `tab` | move · jump to the next section |
| `a` | approve the selected held action (see below) |
| `d` | deny it, optionally typing what the agent should do instead (sent as steering) |
| `s` · `b` · `c` | steer the selected agent (or the hold's agent) · broadcast to all · clear its queued steer |
| `⏎` · `J K` · `?` · `q` | zoom detail · scroll detail · help · quit |

<p align="center">
  <img src="https://raw.githubusercontent.com/manishkumar/reins/main/assets/watch-approve.svg" alt="reins watch approve dialog: 'Approve this exact call, once?' with the rule, reason, session, directory and the exact input, and y to approve or esc to cancel" width="760">
</p>

**Approving here is `reins approve`, with two extra checks a keypress needs and a typed command doesn't.** Both go through the same code (`src/holdActions.ts`), so an approval still clears one exact call, once. On top of that:

- **The dialog shows the full input and `y` stays locked until you have scrolled to the end of it.** A 120-line heredoc can't be approved from its first line.
- **The action is re-read at the moment you press `y`.** If it was answered from another terminal, or no longer matches what you reviewed, nothing is approved and the cockpit tells you so.

When a new hold arrives, the header flashes and the terminal bell rings. iTerm2, WezTerm and Ghostty also get a desktop notification. `--quiet` turns off the bell and notification. **The selection never moves on its own**, because a list that reorders under your cursor is how the wrong thing gets approved. Steering from the cockpit appends to what's already queued, like `reins steer`, so a queued nudge is never overwritten.

Text from agent runs (commands, paths, steering, session titles and prompts) is untrusted, and control characters are stripped before it reaches your terminal. Otherwise a command containing escape sequences could set your clipboard or draw over the approve dialog.

Nothing listens on a port: the only way in is the keyboard of whoever started it. That's why approving lives here and not in `reins report`. Tune the refresh with `reins watch -n 1` (seconds). Piped or with `--once`, it prints one plain snapshot, including the `reins approve` / `reins deny` command for each hold, so it works in scripts. No TUI library and no daemon: raw ANSI on the terminal you already have, and it needs at least 60×14.

### The hold queue inside Claude Code (experimental mod)

Claude Code 2.1.287 added function hooks ("mods"). `mods/reins-status/` in this repository is one: it reads `.reins/pending/`, refreshed every five seconds and at the end of each turn. Type `/reins` and a pane opens beside the conversation with every hold: its rule and reason, its directory, the whole input (up to 150 lines) and the `reins approve` and `reins deny` commands for it. Claude Code docks the pane as a sidebar in its fullscreen layout from 110 columns, and puts it above the prompt otherwise. When the pane is closed, the status line shows `reins-status: 2 held · /reins`, one line above the prompt names the oldest hold, and a hold that arrives while you are in the session raises a toast once.

```bash
reins init --mod
```

That copies four files into `.claude/skills/reins-status/`, where Claude Code loads a plugin it finds in a project (it lists as `reins-status@skills-dir` in `claude plugin list`). It is opt-in: plain `reins init` installs no mod. If a folder of that name exists and is not this mod, reins leaves it untouched and says so. `reins uninstall` removes the four files and any folder that leaves empty. To try it without installing, run `claude --plugin-dir <reins package>/mods/reins-status`.

**It shows the queue and never answers it.** There is no approve or deny control on it, and it hooks no tool call. The reason is measured, in [docs/mods-probe.md](docs/mods-probe.md): the mod engine skips a hook that throws or runs past its 10 seconds and lets the tool call go ahead, so a hold enforced by a mod would fail open. The reins gate stays a command hook. Approving stays in `reins approve` and `reins watch`.

The caveats. The mod API is early access and can change in any Claude Code release, and this mod then stops loading until it is updated. It was tested with `claude plugin test` against the engine, with the file system and clock mocked. Installed through `.claude/skills/`, it was seen to load and set the status line in a headless run. The status line, the line above the prompt and the `/reins` pane have been seen in a live interactive session, on one terminal and one Claude Code version (2.1.287). The toast has not: it passes `claude plugin test` and is otherwise unverified. The pane does not mark which line the rule matched; `reins watch` does. The pane opens only when you type `/reins`, never on its own. Claude Code loads a project's plugins only after the workspace is trusted, so the mod does not load in a folder you have not trusted, and the hooks still run there. `.claude/skills/` is usually committed, so installing the mod puts it in front of everyone who works in the repository. The copy is not updated when reins is: run `reins init --mod` again after upgrading. It finds `.reins/` by walking up from the session's directory, so it works from a subdirectory. It uses no SQLite and makes no network call.

### `reins report` — the captured runs as a local web page

`watch` is the live view; **`reins report` is the browsable archive.** It reads `.reins/runs.db` and writes a single **self-contained HTML file** (inline CSS, no JS framework, **zero network requests** — nothing leaves your machine) with:

- **Needs you**, at the top: every parked hold with its proposed input, how long it has waited, and the `reins approve` / `reins deny` commands to copy; then any hold breach or worked-around guard from the last 7 days. Older events are counted, not listed (`reins audit --guards` has them all). There is no approve button: approving stays a deliberate CLI action, and a page that could approve would need a local server any website could send requests to.
- **Summary cards** — sessions, tool calls, blocked, failed, loops, plus **token and cost rollups** when the transcript had them (best-effort; hidden when never captured).
- **Per-tool breakdown** — how the calls split across tools (Bash vs Edit vs Read…), with per-tool blocked/failed counts.
- **Guard-fire heatmap** — which guard rules actually fired, split into denied (⛔) vs escalated-to-you (✋), so you can see which rules earn their keep and which never trigger.
- **Every session's full trajectory** — guard-blocks (⛔ with the rule id that fired), escalations (✋), failures (✗), and loops (⟳) marked inline.

```bash
reins report            # writes .reins/report.html
reins report --open     # ...and opens it in your browser
reins report -o /tmp/run.html   # custom path (e.g. to share a single run)
```

Finished sessions start collapsed unless they're the latest or have something in "Needs you". The file is written owner-only (`0600`) because it contains commands and paths from your runs. Without SQLite (Node < 22.5, or `REINS_NO_SQLITE=1`) the report still renders holds and the bypass ledger, since those are plain files; session history needs capture.

It's the same local-first deal as the rest of reins: a file you own, readable offline, safe to delete. The richer "what happened across every run" view a terminal can't give you.

It's all in `.reins/runs.db` — three tables (`sessions`, `tool_calls`, `outcomes`) you can query with raw SQL whenever you want. Token/cost columns are best-effort (read from the session transcript) and may be null; that's harmless.

```sql
-- which runs ended after a guard block?
SELECT s.id, s.final_outcome, COUNT(*) AS blocked
FROM tool_calls t JOIN sessions s ON s.id = t.session_id
WHERE t.input_summary LIKE 'DENIED:%'
GROUP BY s.id;
```

Don't want any log at all? Set `REINS_NO_SQLITE=1` — capture is fully disabled and steering/guards keep working.

---

## Testing the hooks manually

<details>
<summary>The hooks read the Claude Code event JSON on <b>stdin</b> and reply on stdout — you can exercise them by hand. <i>(expand)</i></summary>

Useful for trying out a guard or steering rule without a live run:

```bash
# Will this command be blocked?
echo '{"tool_name":"Bash","tool_input":{"command":"rm -rf build"}}' | reins hook pre-tool
# -> {"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny",...}}

# Does my queued steering inject?
reins steer "keep it minimal"
echo '{"tool_name":"Bash","tool_input":{"command":"ls"}}' | reins hook pre-tool
# -> {"hookSpecificOutput":{"hookEventName":"PreToolUse","additionalContext":"[reins …]"}}

# Record a tool call (capture + loop detection):
echo '{"session_id":"demo","tool_name":"Bash","tool_input":{"command":"npm test"},"tool_response":{}}' | reins hook post-tool
```

Useful fields per event: `session_id`, `cwd`, `tool_name`, `tool_input` (pre/post); `tool_response` (post); `error`, `is_interrupt` (post-tool-failure); `transcript_path`, `reason` (stop). No output from a hook = "allow, inject nothing."

Two notes for manual testing: events **without** a `session_id` don't get recorded (so quick guard/steer checks won't litter your trajectory log); and a session you record by hand will show as "still running" in `reins lastrun` until you also send a `stop` event for it.

</details>

---

## Compatibility

| | Steering & Guards | Capture (`lastrun`/`loops`/`sessions`) |
|---|---|---|
| **Node ≥ 22.5** | ✅ | ✅ via built-in `node:sqlite` |
| **Node 18–22.4** | ✅ | ✅ *if* you `npm i -g better-sqlite3`, else disabled |
| **`REINS_NO_SQLITE=1`** | ✅ | off by choice |

The live reflexes never touch the database, so they work on **any Node ≥ 18**. Capture needs a synchronous SQLite backend: `node:sqlite` (built in on 22.5+) or the optional `better-sqlite3`. If neither is present, capture **degrades silently** — your agent is never affected — and `reins doctor` / `reins lastrun` tell you why. (Windows, macOS, Linux all supported; path guards normalize separators.)

---

## Local-first guarantee

`reins` makes **zero network calls**. No telemetry, no phoning home, no account, ever. Your trajectories live in a SQLite file on your disk that you can read, query, back up, or delete. That privacy — and the raw-SQL hackability — is the entire point.

---

## Security / threat model

**`.reins/steering.txt` is security-sensitive: write access to it equals steering access.** Anything that can write that file can inject context into your running agent at its next tool call. `reins` creates `.reins/` as `0700` (owner-only) and git-ignores it, but be deliberate:

- **Do not let an untrusted or automated writer feed it.** A CI job, a shared script, or any process you don't fully control writing to `.reins/steering.txt` is a hijack path into your agent. Treat write access to that file as you'd treat write access to your prompts.
- Steering is a **soft** channel — the model still weighs it and resists outright contradictions — so this is defense-in-depth, not a sole control. v1 ships no signing on the steering file; the mitigations are filesystem permissions (`0700`) and not pointing untrusted writers at it.
- **`.reins/decided/` is approval access.** One-shot hold decisions — approvals *and* refusals — are files there; anything that can write them can pre-approve (or fake-refuse) a parked action. Same posture, same mitigations.

Guards, separately, are **not** a containment boundary (see *What guards are — and are not*).

**A Claude Code mod runs above reins.** From Claude Code 2.1.287, a mod's `tool.call` hook runs before any `PreToolUse` command hook, reins included (measured in [docs/mods-probe.md](docs/mods-probe.md)). A mod can rewrite a command before reins reads it, in which case reins matches, parks and approves the rewritten command, the one that would run. A mod can also answer a tool call itself, and then no `PreToolUse` hook runs and reins sees nothing. A mod is code you installed in your own Claude Code, so this is the same trust as any other local code. reins does not detect it.

A crashing hook **fails open** (the agent proceeds) so a bug in `reins` can never wedge your agent — which also means guards are best-effort if the hook itself errors.

---

## Command reference

<details>
<summary>Every command, one line each — the same list <code>reins --help</code> prints. <i>(expand)</i></summary>

```text
reins init [--print|--local]     Set up .reins/ and wire (or print) the hooks
reins uninstall [--purge]        Remove the hooks (--purge also drops .reins/)
reins doctor                     Diagnose your setup
reins steer "<msg>" [--replace]  Queue steering for the next tool call (appends;
                                 several live agents + a TTY → a picker asks which)
reins steer "<msg>" --session <id|name>   Target one agent (id/prefix/name/mnemonic)
reins steer "<msg>" --broadcast  Skip the picker; whichever agent moves next gets it
reins steer [--clear]            Show / clear pending steering
reins name <session> "<label>"   Name a session; --clear reverts to the auto mnemonic
reins guard list|add|remove|reset    (add takes --ask to escalate, --hold to park)
reins scan [--accept]            Propose rules for what THIS repo can destroy
reins policy upgrade [--apply]   Refresh shipped rules, keeping yours and your edits
reins policy version             Your policy generation vs the shipped one
reins pending                    List actions parked by hold rules
reins approve <id>               Approve a parked action (one-shot, exact call)
reins deny <id> [--steer "..."]  Refuse a parked action, optionally steer instead
reins audit [session] [--json]   Every gate decision (deny/ask/hold/allow/breach/bypass)
reins audit --guards [--json]    Were the guards right? Every denial ever recorded,
                                 scored: stale rules, and vetoes worked around anyway
reins lastrun [session]          Readable account of a run (id prefix or name)
reins sessions [-n N]            List recent sessions (with names)
reins watch [-n SECS] [--once] [--quiet]  Cockpit: approve/deny holds, steer agents
reins report [--open] [-o FILE]  Self-contained local HTML report of all runs
reins loops                      Sessions where the agent looped
reins hook pre-tool|post-tool|stop   (invoked by Claude Code, not you)
```

</details>

## How it works (one breath)

Each hook is `reins hook <pre-tool|post-tool|post-tool-failure|stop>`, reading the event JSON on stdin and replying over stdout per the Claude Code hook contract. `pre-tool` checks guards (deny, ask, or hold — deny-and-queue by default, or `defer` when opted in and Claude Code honors it) then steering (inject + clear). `post-tool` records the call, raises the loop alarm on consecutive repeats, and flags a `HOLD BREACH` if a still-parked action executed anyway; `post-tool-failure` does the same for a call that failed. `stop` delivers any still-pending steering (briefly holding the stop), then finalizes the run — noting any actions still parked, and what the session's own calls say about its work being done (the claim check). State lives in `.reins/`: `steering.txt`, `policy.json` (`guards.json` before 0.4, still read), `pending/`, `decided/` (`allowed/` before 0.4, no longer read), `config.json`, `runs.db`. Both the CLI and the hooks find `.reins/` by walking up to the nearest one — commands work from any subdirectory, and a tool call the agent makes after `cd`-ing into one still sees the project's own rules, steering and approval queue (the hooks' walk is bounded by `$CLAUDE_PROJECT_DIR`, so it never climbs above the session root).

The file formats and decision semantics behind guards/steering/holds are written up separately, vendor-neutral, in [SPEC.md](SPEC.md) — not a standard, just a description of what reins does, in case another harness ever wants the same gate.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Keep it small and sharp.

---

<div align="center">

MIT · no daemon, no backend, no account — just hooks, and files you own

*If reins caught something dumb before it happened, consider a ⭐*

</div>
