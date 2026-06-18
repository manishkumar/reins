# Contributing to reins

Thanks for helping make `reins` better. It's a small, sharp tool — contributions
that keep it small and sharp are the most welcome.

## Dev setup

```bash
git clone https://github.com/manishkumar/reins
cd reins
npm install
npm run build      # compiles src/ -> dist/
npm link           # puts `reins` on your PATH, pointing at this checkout
npm test
```

After any source change: `npm run build` (the linked `reins` picks it up
automatically — no need to re-link).

## Project shape

- `src/cli.ts` — single entry point; lazy-loads each subcommand (hooks fire on
  every tool call, so the hot path must stay lean).
- `src/hooks/` — the three hook handlers (`pre-tool`, `post-tool`, `stop`).
- `src/commands/` — user-facing commands.
- `src/guards.ts`, `src/steering.ts`, `src/db.ts` — the core primitives.
- `test/` — `node:test` unit tests over the pure logic.

## Guiding principles (please read before a big PR)

1. **Daily, present-tense value over analytics.** The live reflexes (steer,
   guard, loop) are the product. The SQLite log is a byproduct.
2. **Steering and guards are different primitives — never merge them.** Steering
   is a soft nudge (`additionalContext`); a guard is a hard veto
   (`permissionDecision: deny`).
3. **Honest latency & honest limits.** Steering lands at the next tool boundary,
   not instantly. Guards block forms, not intent. Say so plainly.
4. **Local-first, zero telemetry.** No network calls, ever. PRs that phone home
   will be rejected.
5. **Fail open.** A bug in a hook must never wedge the user's agent.

## Before opening a PR

- `npm run build && npm test` must pass.
- Add/adjust tests for behavior changes.
- Keep runtime dependencies at zero (we rely on `node:` built-ins).
- Update `CHANGELOG.md` under `[Unreleased]`.

## Reporting bugs

Open an issue with: your OS, `node --version`, `reins version`, the exact
command, and what you expected vs. what happened.
