# The reins convention

A small, vendor-neutral convention for **gating an agent's irreversible actions and
recording what was decided** — expressed as plain files in one directory.

This document describes the file formats and the decision semantics, not reins' Claude
Code implementation. reins is one implementation; the convention is deliberately simple
enough that a different harness, a different language, or a shell script can implement it
in an afternoon.

Status: **v1, and honest about it.** It describes what reins actually does today. It is
not a standard, nobody else implements it yet, and it will change if a second
implementation finds it wrong.

---

## 1. Why files

Every piece of state here is a file a human can read with `cat`, edit with an editor, and
delete to undo. There is no daemon, no socket, no database requirement, and no network
call in the entire convention. Two consequences worth stating plainly:

- **Anything that can write these files can steer or approve.** The directory is the
  security boundary (mode `0700`); there is no second authentication layer.
- **The gate keeps working when everything optional is broken.** Capture (§7) may be
  unavailable; steering, policy, and holds must not care.

## 2. Location

All state lives in `.reins/` at the project root, created mode `0700`, and self-ignored
from version control (it holds run-local state and can contain secrets echoed from tool
inputs). Implementations resolve the project root from the harness-supplied working
directory when acting as a hook, and by walking up from the process cwd otherwise.

```
.reins/
  policy.json      the rules                       (§3)
  steering.txt     queued messages for the agent   (§4)
  pending/         proposed actions awaiting a human decision (§5)
  decided/         answers waiting to be collected (§6)
  config.json      implementation settings
  runs.db          optional capture + audit trail  (§7)
```

## 3. Policy

`policy.json` is an object with a `rules` array. Each rule:

```jsonc
{
  "id": "publish-hold",      // unique, stable, human-typed
  "type": "bash",            // "bash" | "path" | "tool"
  "pattern": "npm\\s+publish",
  "reason": "Publishing waits for a human.",  // shown to the agent AND the approver
  "action": "hold",          // "deny" | "ask" | "hold"; absent means "deny"
  "expires": "2026-09-01"    // optional ISO-8601; an expired rule is inactive
}
```

`type` selects what `pattern` is matched against:

| type   | matched against              | pattern syntax |
|--------|------------------------------|----------------|
| `bash` | the shell command string     | regular expression, case-insensitive |
| `path` | file paths in the tool input | glob, matched against the absolute path and each segment-aligned suffix |
| `tool` | the tool's name              | glob (e.g. `mcp__stripe__*`) |

Rules are evaluated in order; the **first match wins**. A malformed rule (bad regex, bad
glob, unknown `type`) is **skipped, never fatal** — one broken rule must not disable a
policy file's other rules or break the agent's run.

Matching is on **form, not intent**. A rule matches the text of a proposed action, so it
can be evaded by an equivalent command written differently, and it can fire on a harmless
call that merely contains the pattern. This is a speed bump at a boundary, not a sandbox;
implementations should say so where a user will read it.

## 4. Steering

Steering is plain text — one nudge per line, appended, deliberately not a structured
format: a human types these, and `echo "use the existing helper" >> .reins/steering.txt`
must work.

```
.reins/steering.txt                 broadcast: whichever session reaches the next boundary
.reins/steering.<session_id>.txt    targeted: only that session
```

A queued message is **consumed exactly once** — the reader renames the file, then reads it,
so two agents hitting the boundary together cannot both take the same nudge — and is
delivered as *additional context*: an addition to the agent's instructions, never a
replacement for them, and always overridable by its own judgment. (An instruction the
agent must not override is a policy rule, not a nudge.)

An implementation that queues steering **must** guarantee delivery: if the agent's run
ends before any tool call collects a queued message, it is delivered at the end-of-run
boundary instead. A queued message that silently rots is a broken promise to the human who
wrote it.

## 5. Pending actions

When a `hold` rule matches, the proposed action is written to `pending/<id>.json`:

```jsonc
{
  "id": "f27f93b3",
  "session_id": "abc123",
  "tool": "Bash",
  "input": { "command": "npm publish" },   // the full proposal, verbatim
  "input_hash": "…",                       // stable hash of tool + input
  "tool_use_id": "toolu_01…",              // the harness's id, when it has one
  "transport": "defer",                    // "defer" | "deny" — see §8
  "rule_id": "publish-hold",
  "reason": "Publishing waits for a human.",
  "ts": "2026-07-25T18:04:32.089Z"
}
```

The entry is what the human reviews, so `input` is stored complete and unabbreviated. An
identical proposal from the same session does not create a second entry.

## 6. Decisions

A human's answer is written to `decided/<key>.json` and **consumed exactly once**, by the
same rename-then-read discipline as steering:

```jsonc
{
  "action_id": "f27f93b3",
  "session_id": "abc123",
  "resolution": "approved",      // "approved" | "denied"
  "steer": "open a PR instead",  // optional; for refusals
  "transport": "defer",
  "input_hash": "…",
  "tool_use_id": "toolu_01…",
  "rule_id": "publish-hold",
  "decided_ts": "2026-07-25T18:31:02.512Z"
}
```

`<key>` binds the answer to **one proposal**:

- `u-<tool_use_id>` when the harness preserved the original call (transport `defer`);
- `h-<session hash>-<input_hash>` otherwise, so an answer can only be spent by the session
  it was given to, on the identical input.

Two properties are load-bearing, and widening either is a security regression however
convenient it looks:

1. **One-shot.** An approval clears one call. The rule applies again afterwards.
2. **Exact.** A changed retry — one different flag — is a *new proposal*, not a
   pre-approved one. The human approved an action, not a permission.

**Refusals are recorded, not just deleted.** If a refused action is only removed from
`pending/`, the agent's next attempt re-matches the rule and parks again, and the human is
asked the same question forever.

## 7. The record (optional)

Implementations may keep an audit trail of every gate decision — proposed action, rule,
decision, resolution, resolver, timestamps. reins uses SQLite (`runs.db`, table
`decisions`, surfaced by `reins audit`).

This is **capture, never control**. No steering, policy, or hold decision may depend on
the record being available, and a failure to write it must never change what was decided.

## 8. Decision semantics

An implementation evaluates a proposed action and produces exactly one outcome:

| outcome  | meaning | when the harness can't do it |
|----------|---------|------------------------------|
| `allow`  | proceed | — |
| `deny`   | this call does not run; the agent is told why | — |
| `ask`    | a human at the terminal decides now | degrade to `deny` |
| `hold`   | park the proposal; a human decides later | degrade to `deny` |

Two transports implement `hold`:

- **defer** — the harness preserves the proposed call itself and replays it when the
  session resumes, so an approval executes the *original* call. Better, and not always
  available.
- **deny** — the attempt is vetoed and the proposal is copied into `pending/`. Approval
  lets an identical retry through, which requires the agent to make one. Works anywhere.

**Every degradation goes toward `deny`.** An implementation that cannot be sure a hold
will be enforced must not emit it. This is the one place the convention biases closed: a
hold that silently fails to hold is worse than no hold at all, because a human believes an
action is waiting for them when it has already run.

Where a gap is known and undetectable, the implementation should **detect the breach after
the fact** and record it (reins reports a still-parked action that executed as a
`HOLD BREACH`) rather than let it pass unobserved.

## 9. Failure semantics

| subsystem | fails |
|-----------|-------|
| policy evaluation, steering, capture | **open** — the agent's run proceeds as if the tool were not installed |
| holds | **closed** — if parking fails, deny |

A crashing implementation fails open everywhere, including for holds. That is a real
limitation, not a design choice, and it should be documented rather than argued with: a
hook process that dies cannot deny anything.

## 10. Not in scope

Deliberately absent, and not oversights: any network protocol, central policy server, or
remote queue; identity, signatures, or multi-user authorization; a rule DSL beyond the
three matchers above; telemetry of any kind.

---

*Feedback, and especially a second implementation, is welcome — the convention gets more
useful the moment it survives contact with a harness that isn't Claude Code.*
