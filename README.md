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

```bash
npm install -g reins      # or use `npx reins …` anywhere below
```

Requires Node ≥ 22.5 (you already have it — Claude Code runs on Node) and Claude Code ≥ 2.1.9.

```bash
cd your-project
reins init                # creates .reins/ and prints the hooks block
```

Paste the printed block into `.claude/settings.json` (it wires `PreToolUse`, `PostToolUse`, and `Stop` to `reins`):

```json
{
  "hooks": {
    "PreToolUse":  [{ "matcher": "*", "hooks": [{ "type": "command", "command": "reins hook pre-tool" }] }],
    "PostToolUse": [{ "matcher": "*", "hooks": [{ "type": "command", "command": "reins hook post-tool" }] }],
    "Stop":        [{ "hooks": [{ "type": "command", "command": "reins hook stop" }] }]
  }
}
```

That's it. `.reins/` is self-gitignored.

---

## 60-second first run: steering

1. Kick off any real task in Claude Code (e.g. *"add token refresh to the auth module"*).
2. While it's running, in another terminal:

   ```bash
   reins steer "focus the auth work on the token refresh path — don't touch the login flow"
   ```

3. At its **next tool call**, the agent picks up your note and course-corrects. The run never stopped; no context was lost.

```
$ reins steer "keep it minimal — one function, no new deps"
✓ Steering queued.
It reaches the agent at its next tool call — its next decision point — then
clears (one-shot). The run keeps going; nothing is interrupted.
```

### The two honest caveats (this is the product, read them)

**1. Latency: next tool boundary, not "right now."** A `PreToolUse` hook only fires when the agent is *about to call a tool*. So steering lands at the agent's next decision point — typically seconds away, but not instantaneous. This is the correct async model (you can't babysit an agent keystroke-by-keystroke), and it's why the verbs are "steer" and "nudge," never "stop" or "interrupt."

**2. Steering composes with the goal; it can't overwrite it.** Think of `reins steer` as **the detail you forgot to put in the original prompt** — added spec from the same author. *"focus on the token refresh path"*, *"keep it minimal"*, *"use the existing logger"*. It does **not** work as a hijack: a nudge that flatly contradicts the user's explicit instructions ("STOP, ignore everything, do X instead") is correctly treated by the model as suspicious and weighed down. Since the person typing `reins steer` is the same person who wrote the prompt, this is rarely a real constraint — just phrase steering as *more spec*, not *a reversal*. **If you need a hard "never do X," that's a guard, not steering.**

---

## Guard — the hard veto

Guards turn a forbidden command or path into a wall. Mechanism: `PreToolUse` → `permissionDecision: "deny"`. The agent physically cannot proceed with that call — this holds **even under `--permission-mode bypassPermissions`**.

```bash
reins guard list                              # see active rules
reins guard add bash "psql.*production"       # block a command pattern (regex)
reins guard add path "infra/**"               # block writes to paths (glob)
reins guard add bash "docker .*--privileged" --reason "no privileged containers"
reins guard remove <id>
reins guard reset                             # back to defaults
```

Ships with a sane default denylist (override freely): `rm -rf`, `git push --force`, `git reset --hard`, `DROP/TRUNCATE`, `curl … | sh`, and writes to `.env` / `.git/**`.

### What guards are — and are not

Guards are **deterministic vetoes on recognized patterns**. They are excellent speed bumps against accidents and obvious footguns. They are **not a sandbox.** A pattern guard blocks a *form*, not an *intent*: an agent told to `rm -rf foo` and blocked may still delete `foo` via `find -exec rm`; blocked from a `.env` Write it may try a shell redirect (we block the common redirect forms too, but the cat-and-mouse is unwinnable in general). For true containment of an adversarial or determined agent, use OS-level sandboxing and real permission boundaries. `reins` guards are for *"don't let me/it footgun by accident,"* not *"contain a hostile process."*

---

## Loop alarm

When the agent runs the **same tool with identical input** ≥ N times (default 3), `reins` injects an inline warning at that tool boundary nudging it to try something else, and records the loop.

```bash
reins loops          # list sessions where loops happened
```

Tune the threshold in `.reins/config.json` (`"loopThreshold"`).

---

## Capture: `reins lastrun`

The daily *"what the hell did it just do"* command. A clean, scannable account of the most recent run — like a `git diff` for agent behavior.

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

Inspect an older run with `reins lastrun <session-id-prefix>`.

It's all in `.reins/runs.db` — three tables (`sessions`, `tool_calls`, `outcomes`) you can query with raw SQL whenever you want. Token/cost columns are best-effort (read from the session transcript) and may be null; that's harmless.

```sql
-- e.g. which runs ended after a guard block?
SELECT s.id, s.final_outcome, COUNT(*) AS blocked
FROM tool_calls t JOIN sessions s ON s.id = t.session_id
WHERE t.input_summary LIKE 'DENIED:%'
GROUP BY s.id;
```

---

## Local-first guarantee

`reins` makes **zero network calls**. No telemetry, no phoning home, no account, ever. Your trajectories live in a SQLite file on your disk that you can read, query, back up, or delete. That privacy — and the raw-SQL hackability — is the entire point. The platform vendor will ship cost dashboards; they will not ship *"your agent's every move, in a DB only you can see."*

---

## Security / threat model

**`.reins/steering.txt` is security-sensitive: write access to it equals steering access.** Anything that can write that file can inject context into your running agent at its next tool call. It is project-local and git-ignored by default, which is the right posture — but be deliberate:

- **Do not let an untrusted or automated writer feed it.** A CI job, a shared script, or any process you don't fully control writing to `.reins/steering.txt` is a hijack path into your agent. Treat write access to that file as you'd treat write access to your prompts.
- Steering is a **soft** channel by design — the model still weighs it and resists outright contradictions of your instructions — so this is defense-in-depth, not a sole control. But name the risk so nobody wires up an automated steerer by accident.

v1 ships no signing or auth on the steering file; the mitigation is filesystem permissions and not pointing untrusted writers at it. If you need stronger guarantees, restrict permissions on `.reins/`.

Guards, separately, are **not** a containment boundary (see *What guards are — and are not* above).

A crashing hook **fails open** (the agent proceeds) so a bug in `reins` can never wedge your agent — which also means guards are best-effort if the hook itself errors.

---

## How it works (one breath)

Each hook is `reins hook <pre-tool|post-tool|stop>`, reading the event JSON on stdin and replying over stdout per the Claude Code hook contract. `pre-tool` checks guards (deny) then steering (inject + clear). `post-tool` records the call and raises the loop alarm. `stop` finalizes the run. State lives in `.reins/`: `steering.txt`, `guards.json`, `config.json`, `runs.db`.

## License

MIT
