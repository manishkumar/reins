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
| **Before** a tool runs | ⛔ **Guard** | Hard-vetoes forbidden commands/paths (`rm -rf`, writes to `.env`, …) — or escalates to you with `--ask`, or **parks the action for your later approval** with `--hold` | Hard veto (deny) / your call (ask) / your call, later (hold) |
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

`reins init` does the wiring for you — it merges the three hooks (`PreToolUse`, `PostToolUse`, `Stop`) into `.claude/settings.json` (creating it if needed, never clobbering existing settings). Then **restart Claude Code in this project** so it loads them.

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
reins sessions                                   # every session has a name: rosy-egret  a2cbbe90
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
reins guard remove <id>                       # ids shown by `guard list`
reins guard reset                             # back to defaults
```

<p align="center">
  <img src="https://raw.githubusercontent.com/manishkumar/reins/main/assets/guard-list.svg" alt="reins guard list output: the default denylist plus a hold rule, each with its hardness (deny/ask/hold), pattern, and reason" width="820">
</p>

**`--ask` is the middle hardness.** Some actions aren't *never* — they're *check with me first* (pushes, prod-adjacent commands, package publishes). An `ask` rule doesn't veto; it makes Claude Code pause and show **you** the exact call with your rule's reason, and you approve or deny it in the moment (`permissionDecision: "ask"`). One thing to know: it needs a human at the terminal — in a headless/non-interactive run there's no one to ask, so `ask` effectively denies there. When you need a wall that holds unconditionally, that's `deny` (the default).

### `--hold` — the approval queue, for the run nobody is watching

`ask` needs you at the terminal. **`hold` is `ask` for the agent that runs while you sleep.** A hold rule doesn't kill the attempt against a wall — it **parks the proposed action** (the full call, verbatim) in a queue, tells the agent *"this is parked for approval (id abc123) — continue with other work"*, and waits for you. The run survives; the action doesn't happen without you.

```bash
reins guard add bash "git push" --hold        # park pushes instead of denying
# ...the agent runs overnight, tries to push, gets parked, keeps working...

reins pending                                 # morning: what did they want to do?
#   ab12cd34  7h  3b9f2a1c  Bash  git push origin main  [bash-git-push]

reins approve ab12cd34                        # sign off — the agent may retry it
reins deny ab12cd34 --steer "open a PR instead of pushing to main"
```

<p align="center">
  <img src="https://raw.githubusercontent.com/manishkumar/reins/main/assets/hold-queue.svg" alt="The full hold-queue exchange: a guard parks the agent's git push, reins pending lists it, reins deny refuses it with a steer, and the refusal is delivered into the running session" width="740">
</p>

> **Field note — the first action ever parked by this queue was reins' own release.** While building this feature we put a `--hold` rule on `git push` in this very repo. An agent session finished the work, tried to push its own commits, and got parked (`f27f93b3`, the exchange above). The developer refused it — `reins deny f27f93b3 --steer "i pushed myself"` — and the refusal reached the still-running agent at its next tool call, which acknowledged and moved on. The same afternoon the rule also parked a **false positive**: a script whose *text* merely mentioned the push command. That's the "form, not intent" caveat below doing exactly what it says — both halves of the trade-off, live, on day one.

`reins approve` writes a **one-shot allowance for that exact input** and steers the session to retry: the identical call passes once (explicitly allowed, no double prompt), then the rule holds again. Sessions that end with parked actions say so in `reins sessions` / `reins lastrun` (⏳ awaiting approval), and the trajectory records `HELD` / `APPROVED` / `REFUSED` with the rule and queue ids.

The honest caveats, as always:

- **Approval is by exact input hash.** A *changed* retry — even by one flag — is a new proposal that parks again. That's the design, not a gap: you approved a specific action, not a general permission.
- **Same machine, same repo.** The queue is files in `.reins/` (`pending/`, `allowed/`); there's no server, so you review from a terminal on the same checkout. (Remote/notify hook-ups are deliberately out of scope for now.)
- **Approval doesn't re-run anything.** It permits the retry; a still-running agent is steered to retry, an ended one simply passes the gate next time the identical call is attempted (e.g. when you re-kick the task).
- **Hold biases closed — uniquely in reins.** If parking itself fails (say `.reins/` is unwritable), the call is denied outright rather than allowed through. The fail-open caveat still applies one level up: a *crashing* hook process fails open, as everywhere.

Ships with a sane default denylist (override freely): `rm -rf`, `git push --force`, `git reset --hard`, `DROP/TRUNCATE`, `curl … | sh`, and writes to `.env*` / `.git/**`.

**Path globs** match the full path *or any segment-aligned suffix*, so `infra/**` catches the absolute `file_path`s Claude Code sends (e.g. `/Users/you/proj/infra/main.tf`) and works with Windows backslashes too.

### What guards are — and are not

Guards are **deterministic vetoes on recognized patterns** — excellent speed bumps against accidents and obvious footguns, **not a sandbox.** Two honest limits:

- **They block a *form*, not an *intent*.** Blocked from `rm -rf foo`, an agent may still delete via `find -exec rm`; blocked from a `.env` Write it may try a shell redirect (we block the common redirect forms too, but the cat-and-mouse is unwinnable in general). For containment of a determined/adversarial agent, use OS-level sandboxing and real permission boundaries.
- **They match raw command text, so false positives happen.** `git commit -m "removed the rm -rf call"` will be blocked by the `rm -rf` guard, because the pattern appears in the message. If a guard is too aggressive for your workflow, `reins guard remove <id>` it or edit `.reins/guards.json` — they're fully yours.

---

## Loop alarm

When the agent runs the **same tool with identical input** ≥ N times **in a row** (default 3), `reins` injects an inline warning at that tool boundary nudging it to try something else, and records the loop. Consecutive is the operative word: re-running `npm test` after each edit is healthy iteration and never trips the alarm — the same call three times *with nothing in between* does.

```bash
reins loops          # list sessions where loops happened
```

Tune the threshold in `.reins/config.json` (`"loopThreshold"`).

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

- `reins sessions` — list recent sessions in the project (name, status, call count, time). Handy when several agents have run in one repo. Every session gets a deterministic mnemonic (`rosy-egret`) derived from its id; `reins name <session> "<label>"` replaces it with something meaningful to you (`--clear` reverts). Names work anywhere a session id does: `steer --session`, `lastrun`, the steer picker.
- `reins lastrun <session>` — inspect a specific older run (id prefix or name).
- `reins loops` — just the sessions where the agent got stuck.

### `reins watch` — the multi-agent cockpit

`reins sessions` is a snapshot; **`reins watch` is the live view.** A self-refreshing dashboard of every agent in the repo — each one's last tool call, whether it's **active / idle / looping right now**, and any steering already queued for it — built for the case a built-in queued message can't serve: **aiming a nudge at one of several running agents without alt-tabbing into its window.**

<p align="center">
  <img src="https://raw.githubusercontent.com/manishkumar/reins/main/assets/watch.svg" alt="reins watch: three agent sessions, each named, with live status (active / looping / completed), a trajectory tail of recent tool calls, and steer-queued flags" width="680">
</p>

Each agent is its own block — live status (`active` / `idle` / `looping` / outcome), its **recent trajectory tail**, and any queued steering — divided from the next by a rule. Status is driven by *recent tool activity*, not the per-turn Stop hook, so an agent that's mid-conversation reads `active`, not `completed`.

Select a session with `↑/↓` (or `j`/`k`), then:
- **`s`** — steer *just that agent* (writes its per-session nudge; lands at its next tool call).
- **`b`** — broadcast a nudge to all of them.
- **`c`** — clear that agent's queued steering. **`r`** — refresh now. **`q`** — quit.

Read-only over the same `.reins/runs.db`; it never touches a running agent except through the steering you type. Tune the cadence with `reins watch -n 1` (seconds). Piped or non-interactive (`reins watch --once`) it prints a single snapshot instead of taking over the screen — handy in scripts. No TUI library, no daemon — just ANSI on the terminal you already have.

### `reins report` — the captured runs as a local web page

`watch` is the live view; **`reins report` is the browsable archive.** It reads `.reins/runs.db` and writes a single **self-contained HTML file** (inline CSS, no JS framework, **zero network requests** — nothing leaves your machine) with:

- **Summary cards** — sessions, tool calls, blocked, failed, loops, plus **token and cost rollups** when the transcript had them (best-effort; hidden when never captured).
- **Per-tool breakdown** — how the calls split across tools (Bash vs Edit vs Read…), with per-tool blocked/failed counts.
- **Guard-fire heatmap** — which guard rules actually fired, split into denied (⛔) vs escalated-to-you (✋), so you can see which rules earn their keep and which never trigger.
- **Every session's full trajectory** — guard-blocks (⛔ with the rule id that fired), escalations (✋), failures (✗), and loops (⟳) marked inline.

```bash
reins report            # writes .reins/report.html
reins report --open     # ...and opens it in your browser
reins report -o /tmp/run.html   # custom path (e.g. to share a single run)
```

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

Useful fields per event: `session_id`, `cwd`, `tool_name`, `tool_input` (pre/post); `tool_response` (post); `transcript_path`, `reason` (stop). No output from a hook = "allow, inject nothing."

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
- **`.reins/allowed/` is approval access.** One-shot hold allowances are files there; anything that can write them can pre-approve a parked action. Same posture, same mitigations.

Guards, separately, are **not** a containment boundary (see *What guards are — and are not*).

A crashing hook **fails open** (the agent proceeds) so a bug in `reins` can never wedge your agent — which also means guards are best-effort if the hook itself errors.

---

## Command reference

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
reins pending                    List actions parked by hold rules
reins approve <id>               Approve a parked action (one-shot, exact input)
reins deny <id> [--steer "..."]  Refuse a parked action, optionally steer instead
reins lastrun [session]          Readable account of a run (id prefix or name)
reins sessions [-n N]            List recent sessions (with names)
reins watch [-n SECS] [--once]   Live cockpit: all agents, steer any one
reins report [--open] [-o FILE]  Self-contained local HTML report of all runs
reins loops                      Sessions where the agent looped
reins hook pre-tool|post-tool|stop   (invoked by Claude Code, not you)
```

## How it works (one breath)

Each hook is `reins hook <pre-tool|post-tool|stop>`, reading the event JSON on stdin and replying over stdout per the Claude Code hook contract. `pre-tool` checks guards (deny, ask, or hold-with-one-shot-allowance) then steering (inject + clear). `post-tool` records the call and raises the loop alarm on consecutive repeats. `stop` delivers any still-pending steering (briefly holding the stop), then finalizes the run — noting any actions still parked. State lives in `.reins/`: `steering.txt`, `guards.json`, `pending/`, `allowed/`, `config.json`, `runs.db`. CLI commands find `.reins/` by walking up from your current directory, so they work from any subdirectory of the project.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Keep it small and sharp.

---

<div align="center">

MIT · no daemon, no backend, no account — just hooks, and files you own

*If reins caught something dumb before it happened, consider a ⭐*

</div>
