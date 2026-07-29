# CLAUDE.md

reins is a kit of Claude Code hooks that lets a human steer a *running* agent: soft
nudges (`steer`), hard vetoes (`guard`), an approval queue (`hold`), a loop alarm, and
SQLite capture of every run. Local-first: no daemon, no backend, no accounts.

Read the README before changing behavior — its "honest caveats" sections are spec, not
marketing copy. If you change what a feature can or can't do, update its caveat in the
same commit.

## Commands

- `npm run build` — tsc → `dist/` (and chmods `dist/cli.js`)
- `npm test` — `node --test` over `test/*.test.js`. **Tests import from `dist/`, so
  always build first.** A stale `dist/` makes tests pass against code you didn't write.

## Invariants — break these and the tool is worse than not existing

This code runs *inside other people's agent sessions*, at every tool call, in repos you
will never see. That is the frame for everything below.

1. **A hook must never break the host run.** Every hook fails OPEN: if reins crashes or
   can't read its own files, the agent's tool call proceeds as if reins weren't
   installed. The one exception is the hold gate, which biases CLOSED — if parking a
   held action fails, deny anyway; a hold rule's action must never run unapproved just
   because the queue misbehaved. Capture (DB writes) is best-effort and must never
   influence a decision.

2. **The stdout protocol is sacred.** A hook invocation emits at most ONE JSON object on
   stdout and exits 0; no output means passthrough. `src/hookio.ts` is the only place
   that writes stdout in the hook path. The most likely regression in this codebase is
   an innocent `console.log` (or a library that prints) anywhere reachable from
   `reins hook *` — it corrupts the protocol silently. Diagnostics go to stderr or nowhere.

3. **Zero runtime dependencies. Zero network calls.** Both are README badges and the
   entire trust story. Never solve a problem by adding a dependency — the answer is more
   code in `src/`, or "no". SQLite is `node:sqlite` (optional, Node ≥ 22.5); steering,
   guards, and holds must keep working without it. Which is why:

4. **The control plane is plain files, not the DB.** Steering queue, policy rules, hold
   queue, and filed decisions live as files under `.reins/`. The DB is capture only — a
   byproduct. No steering/guard/hold decision may ever depend on the DB being available.

5. **PreToolUse order is deliberate:** guard (short-circuits) → steering (injected once,
   then cleared) → passthrough.

6. **A queued steer is never silently lost.** If there is no next tool call, the Stop
   hook delivers it. Any refactor of steering must preserve this delivery guarantee.

7. **Approvals are one-shot and bound to one proposal.** A deferred hold is bound to the
   exact call (`tool_use_id`, replayed by Claude Code on resume); a denied hold is bound
   to the identical input, scoped to the session that proposed it. Either way `reins
   approve` clears *one* call, once. Widening this — prefix matching, per-rule blanket
   allows, TTLs, unscoped hash keys — is a security regression dressed as a UX
   improvement. Don't.

8. **A hold must actually hold, or say it didn't.** `defer` is the better transport (the
   real call is preserved and replayed, so approval doesn't depend on the agent
   reconstructing it) but Claude Code honors it *only in print mode* and *only for a solo
   tool call*, and ignores it silently otherwise. So `src/defer.ts` demands **positive
   evidence** of print mode — it reads the argv of the Claude Code process itself
   (`CLAUDE_PID`), the same input Claude Code judged itself by — and answers "no"
   otherwise, falling back to the deny transport that works everywhere. Do not swap that
   for a cheaper proxy: `CLAUDE_CODE_ENTRYPOINT` was tried and is wrong in both
   directions (a real `-p` run can report `claude-vscode`; an interactive session can
   inherit `sdk-cli`). PostToolUse independently reports any parked action that executed
   anyway as a HOLD BREACH. A hold that quietly stopped holding is the worst bug this
   project can ship.

9. **`reins init` merges into `.claude/settings.json`, never clobbers it**, and
   `reins uninstall` removes exactly what init added.

10. **Changing `DEFAULT_RULES` means bumping `POLICY_VERSION`.** Rules are written
    to `.reins/policy.json` once, at init, and nothing revisits them on its own —
    so a rule fix that doesn't bump the version reaches zero existing installs.
    This is not hypothetical: a repo initialized in June 2026 was still enforcing
    a pattern that blocked plain `rm -f one-file.txt` in late July, weeks after
    the fix shipped. `reins policy upgrade` is the delivery path, `reins doctor`
    is the notification, and the version bump is what arms both. Upgrades never
    clobber: a user's `action`/`expires` on a shipped rule survives, and
    hand-written rules are never touched.

11. **Generated rules are never `deny`.** Anything `reins scan` proposes is a
    guess about a stranger's repo, and it lands as `hold` or `ask` in a staging
    file that does nothing until a human moves it across. A hand-written deny is
    a considered veto; the two must not be confused. Scan stays deterministic —
    manifests only, no model, no network — because that's what keeps the
    zero-dependency claim honest.

12. **Bypass detection reports; it never escalates.** When a denied command's
    intent runs anyway, reins says so and stops there. Widening the guard to
    chase the variant is an arms race pattern matching cannot win, and it would
    turn a reporting feature into a decision the DB could influence (see 1 and
    4). The ledger is a plain file for the same reason capture can't be trusted
    here: "your guard didn't hold" must not vanish on Node < 22.5.

## Judgment calls that keep recurring

- **Steering is added spec, not a hijack.** The vocabulary is "steer"/"nudge" — never
  "stop", "interrupt", "override" — in code, docs, and output strings alike. A hard
  "never do X" belongs in a guard, not a steer.
- **Guards are speed bumps, not a sandbox.** They match *form* (raw text), not intent.
  When someone asks to make them "unbypassable", the honest answer is OS-level
  sandboxing, and the README already says so. When extending the default denylist,
  prefer precision over recall: one false veto in a stranger's run costs more trust than
  a missed pattern.
- **The loop alarm is consecutive-only.** `npm test` after each edit is healthy
  iteration; the same call N times *with nothing in between* is a loop. Any "smarter"
  matching must keep that distinction.
- **No `session_id` means a manual/test invocation.** Guards and steering still run, but
  never record phantom sessions or park phantom holds.
- **Path guards match absolute paths and Windows backslashes** (segment-aligned suffix
  matching — see the `matchesPathGlob` tests). Claude Code sends absolute `file_path`s;
  a guard that only matches relative paths is a guard that doesn't fire.

## When unsure

Every ambiguous call here resolves the same way: *what does the person watching — or
deliberately not watching — the agent need?* Fail open for their run, fail closed for
their approvals, state the honest caveat, and keep everything on their machine.
