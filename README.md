# reins

**Steer a running Claude Code agent without stopping it.** Plus: hard-block forbidden actions, get warned when it loops, and capture every run's trajectory to a queryable SQLite file you own.

Local-first. No daemon. No backend. No account. Nothing leaves your machine.

> Reins guide a galloping horse without stopping it. That's the whole idea: nudge the agent while it runs, veto what it must never do, and keep a record — all from your terminal.

---

## Why this exists

You're watching an agent work and you can see it drifting — over-engineering, editing the wrong module, about to run something destructive. Today your only options are to let it finish and clean up, or kill it and lose all its in-flight context.

`reins` gives you a middle path built from four Claude Code hooks:

| When | Reflex | What it does | Hardness |
|---|---|---|---|
| **Before** a tool runs | **Guard** | Hard-vetoes forbidden commands/paths (`rm -rf`, writes to `.env`, …) | Hard — non-overridable |
| **During** the run | **Steer** | Injects a one-line course-correction at the next tool boundary | Soft — the model weighs it |
| **After each** tool | **Loop alarm** | Warns inline when the same call repeats N times | Observe + warn |
| **At the end** | **Capture** | Logs the run's trajectory + outcome to SQLite | Observe |

The steering is the headline. The SQLite log is a **byproduct** — you never have to open it for the tool to earn its place.

---

## Install

**Install straight from GitHub — works today, no build step:**

```bash
npm install -g github:manishkumar/reins
reins version
```

> Once it's published to the npm registry, `npm install -g reins` will be the one-liner. Both put the same `reins` on your PATH.

Prefer a local checkout (for hacking on it)?

```bash
git clone https://github.com/manishkumar/reins && cd reins
npm install && npm run build && npm link
```

Requires **Node ≥ 18**. (Capture uses SQLite — built in on Node ≥ 22.5, optional on older Node; see [Compatibility](#compatibility). Steering and guards work on any Node ≥ 18.)

---

## 60-second first run

```bash
cd your-project
reins init          # creates .reins/ AND wires the hooks into .claude/settings.json
```

`reins init` now does the wiring for you — it merges the three hooks (`PreToolUse`, `PostToolUse`, `Stop`) into `.claude/settings.json` (creating it if needed, never clobbering existing settings). Then **restart Claude Code in this project** so it loads them.

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

**2. Steering composes with the goal; it can't overwrite it.** Think of `reins steer` as **the detail you forgot to put in the original prompt** — added spec from the same author. *"focus on the token refresh path"*, *"keep it minimal"*, *"use the existing logger"*. It does **not** work as a hijack: a nudge that flatly contradicts the user's explicit instructions ("STOP, ignore everything, do X instead") is correctly weighed down by the model. Since the person typing `reins steer` is the same person who wrote the prompt, this is rarely a real constraint — just phrase steering as *more spec*, not *a reversal*. **If you need a hard "never do X," that's a guard, not steering.**

Two quick `reins steer`s before the next tool call **both** reach the agent (they append). Use `--replace` to overwrite, `reins steer --clear` to reset.

**Running several agents in one repo?** A plain `reins steer` is a *broadcast* — it lands on whichever session hits the next tool boundary first. To nudge a specific agent, target its session (ids from `reins sessions`, prefixes accepted):

```bash
reins sessions                                   # find the session id
reins steer "stay on the payments module" --session 3b9f2a1c
```

A targeted nudge only reaches that session; broadcasts still go to everyone else.

---

## Guard — the hard veto

Guards turn a forbidden command or path into a wall. Mechanism: `PreToolUse` → `permissionDecision: "deny"`. The agent physically cannot proceed with that call — this holds **even under `--permission-mode bypassPermissions`**.

```bash
reins guard list                              # see active rules + their ids
reins guard add bash "psql.*production"       # block a command pattern (regex)
reins guard add path "infra/**"               # block writes to paths (glob)
reins guard add bash "docker .*--privileged" --reason "no privileged containers"
reins guard remove <id>                       # ids shown by `guard list`
reins guard reset                             # back to defaults
```

Ships with a sane default denylist (override freely): `rm -rf`, `git push --force`, `git reset --hard`, `DROP/TRUNCATE`, `curl … | sh`, and writes to `.env*` / `.git/**`.

**Path globs** match the full path *or any segment-aligned suffix*, so `infra/**` catches the absolute `file_path`s Claude Code sends (e.g. `/Users/you/proj/infra/main.tf`) and works with Windows backslashes too.

### What guards are — and are not

Guards are **deterministic vetoes on recognized patterns** — excellent speed bumps against accidents and obvious footguns, **not a sandbox.** Two honest limits:

- **They block a *form*, not an *intent*.** Blocked from `rm -rf foo`, an agent may still delete via `find -exec rm`; blocked from a `.env` Write it may try a shell redirect (we block the common redirect forms too, but the cat-and-mouse is unwinnable in general). For containment of a determined/adversarial agent, use OS-level sandboxing and real permission boundaries.
- **They match raw command text, so false positives happen.** `git commit -m "removed the rm -rf call"` will be blocked by the `rm -rf` guard, because the pattern appears in the message. If a guard is too aggressive for your workflow, `reins guard remove <id>` it or edit `.reins/guards.json` — they're fully yours.

---

## Loop alarm

When the agent runs the **same tool with identical input** ≥ N times (default 3), `reins` injects an inline warning at that tool boundary nudging it to try something else, and records the loop.

```bash
reins loops          # list sessions where loops happened
```

Tune the threshold in `.reins/config.json` (`"loopThreshold"`).

---

## Capture: `reins lastrun`, `reins sessions`, `reins loops`

The daily *"what the hell did it just do"* commands. A clean, scannable account of a run — like a `git diff` for agent behavior.

```
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

- `reins sessions` — list recent sessions in the project (status, call count, time). Handy when several agents have run in one repo.
- `reins lastrun <session-prefix>` — inspect a specific older run.
- `reins loops` — just the sessions where the agent got stuck.

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

The hooks read the Claude Code event JSON on **stdin** and reply on stdout. You can exercise them by hand — useful for trying out a guard or steering rule without a live run:

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

Guards, separately, are **not** a containment boundary (see *What guards are — and are not*).

A crashing hook **fails open** (the agent proceeds) so a bug in `reins` can never wedge your agent — which also means guards are best-effort if the hook itself errors.

---

## Command reference

```
reins init [--print|--local]     Set up .reins/ and wire (or print) the hooks
reins uninstall [--purge]        Remove the hooks (--purge also drops .reins/)
reins doctor                     Diagnose your setup
reins steer "<msg>" [--replace]  Queue steering for the next tool call (appends)
reins steer [--clear]            Show / clear pending steering
reins guard list|add|remove|reset
reins lastrun [session-prefix]   Readable account of a run
reins sessions [-n N]            List recent sessions
reins loops                      Sessions where the agent looped
reins hook pre-tool|post-tool|stop   (invoked by Claude Code, not you)
```

## How it works (one breath)

Each hook is `reins hook <pre-tool|post-tool|stop>`, reading the event JSON on stdin and replying over stdout per the Claude Code hook contract. `pre-tool` checks guards (deny) then steering (inject + clear). `post-tool` records the call and raises the loop alarm. `stop` finalizes the run. State lives in `.reins/`: `steering.txt`, `guards.json`, `config.json`, `runs.db`. CLI commands find `.reins/` by walking up from your current directory, so they work from any subdirectory of the project.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Keep it small and sharp.

## License

MIT
