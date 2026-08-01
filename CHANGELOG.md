# Changelog

All notable changes to `reins` are documented here. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/); this project uses [SemVer](https://semver.org/).

## [Unreleased]

### Added

- **A parked action now tells the human directly.** `hold` was built for the run
  nobody is watching, and it showed: `permissionDecisionReason` is addressed to
  the *model*, so the person who has to type `reins approve` only learned about
  the queue if the agent chose to mention it, somewhere in a wall of tool
  output. Claude Code has exactly one field that reaches the user instead of the
  model — `systemMessage` — and the hold gate now uses it:

  ```
  [reins] ⏸ HELD  Bash  git push origin main
          approve: reins approve bb568799   ·   see all: reins pending
  ```

  It rides inside the single JSON object the hook already emits (a second write
  would corrupt the stdout protocol), so nothing about the decision path
  changes: same park, same deny, same one-shot approval. Notification is
  first-park-only — a re-proposed action is the same decision, and re-notifying
  teaches the reader to ignore the line that matters. No settings change, no
  second terminal; it reaches every install by updating the package. The Stop
  summary already reported actions still parked at the end of a run, and still
  does — this is the same fact, delivered when it can still be acted on.

## [0.3.2]

### Fixed

- **`rm -rf` no longer false-vetoes a relative deletion inside exempted space.**
  Found by dogfooding a fresh 0.3.1 install: an agent working in its scratchpad
  runs `rm -rf home proj`, but every scratch exemption is written as an absolute
  prefix (`^/(?:private/)?tmp/`), and the matcher had no `cwd` to resolve
  against — so the exemption list was unreachable from the exact place it was
  written for, on every macOS session. Relative arguments are now judged from
  the session's `cwd`.

  The widening is narrow on purpose, since an exemption only ever lets *more*
  run: it applies only when the cwd is itself exempted **and every argument in
  the segment resolves inside it**. An absolute path, a `~`, an unexpanded
  `$VAR`, a `..` that climbs out, or a `cd` anywhere in the command all drop it
  and the guard fires as before. The rejected design was per-argument
  resolution — it clears the rule via the command word itself (`rm` →
  `<cwd>/rm`, which matches the scratch exemption), which from a scratch cwd
  would have exempted `rm -rf /Users/you/project`. There's a regression test
  pinning that.

  This ships in the **binary**, not the policy: `DEFAULT_RULES` is unchanged, so
  `POLICY_VERSION` stays at 2 and no `reins policy upgrade` is needed — updating
  the package is enough.

## [0.3.1]

### Changed — the default denylist was measured, and it was wrong

Six weeks of captured runs in a real project (51 sessions, 2,396 tool calls)
were replayed against the shipped rules. The guards fired **16 times and
prevented nothing**: every firing was a build artifact (`rm -rf .next`) or a
scratch file. In all five cases where the agent still wanted the outcome, it
reran the command with a flag dropped and it went through — median gap **11
seconds**. Meanwhile `prisma`, `.env` reads and remote-branch deletion ran
unguarded the whole time. Replaying all 1,145 Bash calls through the new rules:
`rm-rf` now fires **zero** times, and the two calls that do fire are real.

- **Rule exemptions (`except`).** Rules take a list of patterns that veto a
  match. `rm-rf` now ignores build output and scratch dirs (`.next`, `dist`,
  `build`, `target`, `coverage`, `node_modules`, `__pycache__`, `/tmp`,
  scratchpads). Exemptions are evaluated **per command segment** and **per
  argument**, so `rm -rf .next && rm -rf /` is still blocked and
  `rm -rf "my build dir"` is not exempted by the word *build* in a phrase.
- **New `rm-catastrophic` rule** for `/`, `~`, `$HOME`, `..` and system
  directories. Carries no exemptions and is ordered first, so no exemption list
  can ever wave those through.
- **New `git-delete-remote-branch` rule.** The captured data had the risk
  ordering backwards: `git push --force-with-lease` was denied while
  `git push origin --delete <branch>` — which actually destroyed a ref — was
  not. Covers `--delete`, `-d`, and the `:branch` refspec.
- **`write-dotenv` widened to `.env*`** in the shipped defaults (it already was
  upstream; see the delivery bug below for why installs never got it).

### Added

- **`reins policy upgrade` — a delivery path for rule fixes.** Rules were
  written once at init and never revisited, so a fix reached zero existing
  installs: a repo initialized in June 2026 was still enforcing a pattern that
  blocked plain `rm -f one-file.txt` in late July, weeks after the fix shipped.
  The same repo's secrets guard still read `**/.env`, leaving `.env.local` and
  `.env.production` unguarded the entire time. Shipped rules now carry an
  `origin` and the policy file a `version`; `reins policy upgrade` shows a diff
  and `--apply` writes it. Your own rules are never touched, and deliberate
  edits to a shipped rule (`action`, `expires`) survive. At the current
  generation a differing rule is treated as **your** customization, not
  staleness — it is reported, never overwritten. `reins doctor` flags a stale
  policy.
- **`reins policy version`** — what this project is actually running. Separates
  the **binary** (shared by every repo; hooks call bare `reins`) from the
  **policy generation** (per-project, frozen at init). A project does not pin a
  reins version; it pins its rules.
- **Guard-bypass detection.** When a denied command's intent runs anyway in a
  barely different form, reins says so — at the tool boundary and again in a
  session summary at Stop ("3 guards fired, 3 bypassed, the fastest after 9s").
  It reports and stops there: widening the guard to chase the variant is an
  arms race pattern matching cannot win. Denials are fingerprinted to a
  flag-stripped token set and matched by **asymmetric containment** — the
  question is "did the vetoed thing happen anyway", not "are these two commands
  equally similar" (a symmetric measure missed a real bypass that merely
  appended `&& echo removed`). The ledger is a plain file under `.reins/`, not
  the DB: "your guard didn't hold" must not vanish on Node < 22.5.
- **`reins scan` — rules aimed at your repo.** Reads manifests only
  (`package.json`, `prisma/`, `supabase/`, `alembic.ini`, `*.tf`, `k8s/`,
  `.env`) and proposes rules for what *this* project can destroy. Deterministic:
  no model, no network, no new dependency. Nothing auto-activates — proposals
  stage to `.reins/suggested.json` until `--accept`. **No proposal is ever a
  `deny`**: a hand-written deny is a considered veto, a generated one is a
  guess, so guesses get `hold` or `ask`. Every detection shows its evidence.
- **The steer picker.** With several agents alive in one repo, a bare
  `reins steer "<msg>"` used to broadcast silently — landing on whichever
  session moved first, which may not be the one you meant. Now, when more than
  one session has been active in the last ~15 minutes *and* you're at a TTY,
  steer lists them (name, short id, active/idle, last tool call, any queued
  steer) and asks which one you mean. Enter keeps the broadcast — old muscle
  memory intact — a number targets that session, `q` cancels, and
  `--broadcast` skips the question. Piped/scripted invocations are never
  prompted and broadcast exactly as before, so nothing breaks in automation.
- **Session names.** Every session now has a deterministic mnemonic
  (`rosy-egret`) derived from its id — no storage, works even with capture
  off — shown in `sessions`, `watch`, and the steer picker next to the short
  id. `reins name <session> "<label>"` replaces it with your own
  (`--clear` reverts). Names and mnemonics work anywhere a session id does:
  `steer --session payments-agent`, `lastrun auth-work`, the picker. They are
  display + addressing sugar stored in the capture DB (custom names need
  `node:sqlite`; the `name` column is added to existing runs.db files
  automatically, best-effort) — steering files, holds, and approvals stay
  keyed by the real session id, so no control-plane decision ever depends on
  a name resolving. Resolution precedence is exact id → id prefix → custom
  name → mnemonic, so an id prefix can never be shadowed by a name.
- **Hold now uses Claude Code's native `defer`.** Where Claude Code is verified to
  honor it (print mode: `claude -p` / the SDK), a hold rule returns
  `permissionDecision: "defer"` instead of denying — Claude Code parks the
  *actual tool call* in the session (the turn ends with `stop_reason:
  "tool_deferred"`), and resuming the session (`claude --resume <id> -p
  "continue"`) replays that exact call through the hook. Approving now runs
  the ORIGINAL proposal instead of asking the agent to reconstruct a retry.
  reins only picks defer when it can confirm the run is headless (`claude -p`
  / the SDK) — positive evidence, not a guess — and falls back everywhere
  else, including Windows or whenever it can't tell, to the previous
  deny-and-queue transport, which still works anywhere. Two honest limits,
  both documented in the README: defer is **print-mode only** (an interactive
  terminal session silently discards it) and **solo-call only** (ignored when
  the model emitted several tool calls in one assistant message). Override
  the pick with `"holdTransport":
  "auto"|"defer"|"deny"` in `.reins/config.json`.
- **HOLD BREACH detection.** The solo-call limit above is invisible to the
  `PreToolUse` hook, so `PostToolUse` now checks the queue from the far side:
  if an action that's still parked for approval executed anyway, it's
  reported loudly on stderr and recorded, visible in `reins audit`. Detection,
  not prevention — the action already ran by the time it's caught.
- **`reins audit [session] [--json]`.** Every gate decision (deny / ask /
  hold / allow / breach) for a session, in order, with the rule that fired,
  how it was ultimately resolved, and who resolved it. `--json` emits the raw
  rows for scripting. `reins lastrun` gained a decisions rollup. Backed by a
  new `decisions` table in `runs.db` — capture only, never gates anything.
- **`policy.json`.** `guards.json` (pre-0.3) keeps loading forever; the first
  save upgrades to the new name in place without touching the old file.
  Rules gain an optional `expires` (an expired rule is simply inactive, not
  deleted) and a new `tool` rule type matching tool-name globs like
  `mcp__stripe__*` — for MCP tools, which bash/path rules can't reach.
  `reins doctor` now validates the policy file: bad regex/glob, unknown
  type/action, duplicate ids, a malformed `expires`, and foot-guns like an
  overly-broad pattern or an `--ask` rule in a headless setup.
- **`SPEC.md`** — the file convention behind guards/steering/holds, written up
  separately and vendor-neutral, for anyone who wants the same gate outside
  Claude Code. Linked from the README's "How it works" section.

### Changed
- **Hold transport is chosen automatically, not fixed to deny.** A hold rule's
  actual mechanism (`defer` vs. deny-and-queue) now depends on the
  environment reins is running in rather than always being deny-and-queue;
  see "Added" above. `reins pending` marks deferred entries a later deferred
  hold in the same session has superseded, since Claude Code only replays the
  newest on resume.
- **Refusals are delivered at the boundary.** `reins deny <id> [--steer
  "..."]` now files the refusal so the agent (or the resumed session) is told
  the moment it comes back for that exact action, instead of the action
  silently re-parking forever with no record of having been refused.
- **`.reins/allowed/` renamed to `.reins/decided/`**, and now holds refusals
  as well as approvals (a refusal has to be recorded too, or a replayed
  denied call just re-parks and asks the same question forever). Pre-0.4
  `allowed/` files are still read, so upgrading reins mid-run strands no
  approval a human already gave.

### Fixed
- **A deny-transport hold approval is now scoped to the session that proposed
  it.** Previously a one-shot allowance was keyed only on the input hash, so
  a second session running the identical command could spend the first
  session's approval. It's now additionally keyed to the proposing session,
  closing that gap.

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
