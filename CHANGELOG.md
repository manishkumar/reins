# Changelog

All notable changes to `reins` are documented here. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/); this project uses [SemVer](https://semver.org/).

## [0.3.0]

### Added
- **The hold queue: `--hold`, `reins pending`, `reins approve`, `reins deny`.**
  The third guard hardness, for the run nobody is watching. A rule added with
  `--hold` doesn't kill the agent's attempt against a wall — it **parks** the
  proposed action (full input, rule, session) in `.reins/pending/`, denies that
  attempt with a reason that hands the agent the queue id and tells it to
  continue with other work, and waits for you. `reins pending` lists the queue;
  `reins approve <id>` writes a **one-shot allowance keyed on the exact input
  hash** (the identical retry passes once — a *changed* retry is a new
  proposal, by design) and steers the session to retry; `reins deny <id>
  [--steer "do this instead"]` refuses, optionally steering the alternative.
  Queue state is plain files, not SQLite, so the gate works even where capture
  can't — and alone in reins, hold **biases closed**: if parking itself fails,
  the call is still denied. Sessions that end with parked actions say so in
  `lastrun` / `sessions` (⏳ awaiting approval), `doctor` shows the queue, and
  the audit trail records `HELD:` / `APPROVED:` / `REFUSED:` rows with rule and
  hold ids.

- **`reins report` deeper insights** (the ones the README promised): **cost/token
  rollups** (totals card + per-session meta, shown only when the transcript had
  the data), a **per-tool breakdown** (calls per tool with blocked/failed
  counts), and a **guard-fire heatmap** (which rules fired, denied ⛔ vs
  escalated ✋ — which rules earn their keep). Escalated (`ASKED:`) calls now
  render with their own ✋ glyph instead of raw text, and denied/asked rows show
  the guard rule id that fired as a chip. Still one self-contained HTML file,
  inline CSS, zero network.
- **Guard `--ask`: the middle hardness.** `reins guard add bash "git push" --ask`
  escalates instead of hard-denying — Claude Code pauses and shows *you* the
  action with your rule's reason (`PreToolUse` → `permissionDecision: "ask"`).
  For actions that are sometimes fine (pushes, prod-adjacent commands) where a
  veto is too blunt. Rules without `action` keep hard-denying; existing
  `guards.json` files are untouched. Note: headless runs have no one to ask, so
  `ask` behaves like deny there.
- **Guaranteed steering delivery.** Steering queued after the agent's last tool
  call used to rot in `.reins/` forever — there was no next tool boundary to
  land on. The Stop hook now delivers any pending nudge by blocking the stop
  (`decision: "block"`), so a steer always reaches the agent before the run
  ends. Consumption makes it self-terminating: the re-stop finds nothing
  pending and passes through.
- Gate decisions are recorded with provenance: `DENIED:`/`ASKED:` rows in
  `runs.db` now carry the rule id (`[guard:rm-rf]`), so `lastrun` and raw SQL
  show *which* rule stopped a call.

### Changed
- **Loop alarm counts consecutive repeats, not all-session repeats.** The 3rd
  `npm test` of a long, healthy edit→test cycle no longer trips it (and then
  every later run of it); three identical calls *in a row* still do. Fixes the
  alarm crying wolf on the healthiest pattern an agent has.

## [0.1.0]

### Added
- Initial public iteration: four Claude Code hook reflexes — steer, guard,
  loop alarm, capture — plus the `reins` CLI (`init`, `steer`, `guard`,
  `lastrun`, `loops`, and `hook` entrypoints).
- `reins init` now **auto-merges** the hooks into `.claude/settings.json`
  (idempotent, never clobbers; `--print` / `--local` variants).
- `reins doctor` — diagnoses Node/capture capability, hook wiring, `.reins`
  writability, and pending steering.
- `reins sessions` (alias `ls`) — list recent sessions in the project.
- `reins uninstall [--purge]` — cleanly remove the hooks (and optionally the
  `.reins/` data), the counterpart to `init`'s auto-wiring.
- Cross-Node compatibility: works on Node ≥ 18; capture via `node:sqlite`
  (≥22.5) or optional `better-sqlite3`, degrading silently otherwise.
- `REINS_NO_SQLITE` to disable the trajectory log entirely.
- `reins steer` appends multiple nudges instead of dropping earlier ones
  (`--replace` to overwrite).
- Per-session steering: `reins steer "…" --session <id>` targets one agent (the
  multi-agent "which session am I steering" gap); a plain `reins steer` stays a
  broadcast. The pre-tool hook prefers a session-targeted nudge, else the global.
- `reins watch` — a live, auto-refreshing cockpit for all agents in the repo:
  each agent its own block (status + recent trajectory tail), divided by a rule,
  with keyboard actions to steer one agent (`s`), broadcast (`b`), or clear
  (`c`). Liveness is driven by recent tool activity, not the per-turn Stop hook,
  so a mid-conversation agent reads `active`, not `completed`. Read-only over
  `runs.db`; dependency-free (ANSI + node:readline); `--once` / non-TTY prints a
  single snapshot. The fleet view that built-in queued messages can't do.
- `reins report [--open]` — render the captured trajectory to a single
  self-contained HTML file (inline CSS, zero network): summary cards (sessions,
  tool calls, blocked, failed, loops) and every session's full trajectory with
  guard-blocks and loops marked. Local-first browsable archive; `-o` for a
  custom path. HTML output escapes captured text (XSS-safe).
- **Installable from GitHub today**: `npm install -g github:manishkumar/reins`
  (prebuilt `dist/` committed; no build step or devDeps needed). Tag-triggered
  npm publish workflow for the eventual registry release.

### Fixed
- `reins guard add` validates the pattern (regex/glob) up front and rejects bad
  input, instead of silently saving a dead guard that never matches.
- Path guards now fire on the **absolute** paths Claude Code sends (and on
  Windows separators); the `.env` default covers the `.env.*` family. Closes a
  silent false-security gap where `infra/**` never matched.
- Reliable capture under concurrency: atomic `seq` and retry-on-`SQLITE_BUSY`
  (was dropping ~40% of rows with multiple agents on one project).
- CLI commands discover `.reins/` by walking up, so `reins steer` works from a
  subdirectory instead of writing a stray `.reins/` the agent never reads.
- `.reins/` is created `0700` (owner-only).
