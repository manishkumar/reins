# Holds: the approval queue

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

> While building this feature we put a `--hold` rule on `git push` in this very repo. An agent session finished the work, tried to push its own commits, and got parked (`f27f93b3`). The developer refused it — `reins deny f27f93b3 --steer "i pushed myself"` — and the refusal reached the still-running agent at its next tool call, which acknowledged and moved on. The same afternoon the rule also parked a **false positive**: a script whose *text* merely mentioned the push command. That's the "form, not intent" caveat in [guards.md](guards.md) doing exactly what it says — both halves of the trade-off, live, on day one.

</details>

`reins approve` writes a **one-shot decision keyed to the exact proposal** — the deferred call's own id when Claude Code preserved it, otherwise this session's exact input hash from the same working directory — and hands you what to do next: for a still-running deny-transport hold it steers the session to retry; for a deferred hold it prints the `claude --resume` command, because an approval nobody resumes is the quietest possible failure. Sessions that end with parked actions say so in `reins sessions` / `reins lastrun` (⏳ awaiting approval), and the trajectory (`reins audit`) records `HELD` / `APPROVED` / `REFUSED` with the rule and queue ids.

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

---

[Back to the README](../README.md)
