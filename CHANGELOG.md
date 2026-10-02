# Changelog

All notable changes to `reins` are documented here. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/); this project uses [SemVer](https://semver.org/).

## [Unreleased]

### Added

- **`mods/reins-status`, an experimental read-only Claude Code mod.** `/reins`
  opens a pane beside the conversation with each hold's full input, and a
  count sits in the status line and in one line above the prompt, read from
  `.reins/pending/`. A new hold raises a toast once. It has no
  approval control and hooks no tool call. The mod API is early access. The
  mod was tested against the engine with `claude plugin test` and seen to load
  in a headless run. The status line, the band and the pane were seen in a
  live session; the toast was not.
- **`reins init --mod` installs that mod.** It copies the mod into
  `.claude/skills/reins-status/`, where Claude Code loads it once the
  workspace is trusted. It is opt-in, it never writes into a folder of that
  name that is not the reins mod, and `reins uninstall` removes exactly the
  files it added. The mod now ships in the npm package.
- **`docs/mods-probe.md`.** What Claude Code 2.1.287 does with a mod hook that
  throws, times out or opens a dialog, and where mods sit against command
  hooks, measured with `mods/probe`. A mod fails open and runs above
  `PreToolUse`, so the reins gate stays a command hook. The threat model in
  the README now says a mod can rewrite or answer a call before reins sees it.

- **Sessions are named by what they are about.** The cockpit, `reins
  sessions`, `reins pending`, `reins lastrun`, the steer picker and the report
  lead with the title Claude Code gave the session, with its git branch and
  your last prompt beside it. A name set with `reins name` still leads, and
  the mnemonic and short id stay on the row as the way to address it. The
  title is read from the tail of the session transcript, which is not a
  documented format, so it falls back to the mnemonic when it cannot be read.
- **Claim check.** When a turn ends, reins compares what the session did with
  its own tool calls and reports one of: the last test or build run failed,
  files were edited after the last run, files were edited and nothing was
  run, the result is not visible (a piped or interrupted run), or the last
  run passed. Failed, stale and unverified get a line at Stop; every verdict
  is in `reins lastrun`, the cockpit and the report. It reports and never
  blocks. `"claimCheck": false` silences the Stop line.
- **Footprint.** `reins lastrun`, the cockpit's agent detail pane and the
  report show which files and directories a session edited and which commands
  it ran most, next to the prompt it was given. Facts only: reins does not
  judge whether the two match. Shell commands that can change files are
  counted, since their changes are not in the list.

- **`reins watch` is now a cockpit you can act from.** Three panes: NEEDS YOU
  (held actions, hold breaches, worked-around guards), AGENTS (live status,
  a 12-minute activity sparkline, last call or queued steer), and a detail
  pane with a hold's full proposed input or an agent's trajectory.
  - **Approve and deny from the keyboard.** `a` opens a dialog with the full
    input, and `y` stays locked until it has been scrolled to the end. The
    action is re-read when `y` is pressed, and nothing is approved if it was
    resolved elsewhere or no longer matches what was reviewed. `d` denies,
    optionally with an alternative sent as steering. The CLI and the cockpit
    share one implementation (`src/holdActions.ts`), and `reins audit`
    records the resolver as `human-tui` or `human-cli`.
  - **New holds are announced** with a header flash, the terminal bell, and a
    desktop notification in iTerm2, WezTerm and Ghostty. `--quiet` silences
    the bell and notification. The selection never moves on its own.
  - **Works without SQLite** as an approval queue: holds and the bypass
    ledger are files. The agents pane explains that it needs capture.
  - **Agent text is sanitized** before it reaches the terminal. Control
    characters in commands and paths are replaced, so an escape sequence in
    a command can't set the clipboard or draw over a dialog.
  - Resizes live, redraws only changed lines, and needs 60×14 at least.
    `--once` and piped output print a plain snapshot with the `reins approve`
    / `reins deny` command for each hold.

- **`reins report` leads with what needs you.** A "Needs you" section at the
  top lists every parked hold (the proposed input, how long it has waited, and
  the `reins approve` / `reins deny` commands), plus hold breaches and
  worked-around guards from the last 7 days. Older events are counted and
  pointed at `reins audit --guards`. A page with nothing waiting says so.
- **`reins report` works without SQLite.** Holds and the bypass ledger are
  plain files, so the report now renders them on Node < 22.5 or with
  `REINS_NO_SQLITE=1` and says that session history needs capture.

### Changed

- `reins watch` reads "looping" as a consecutive streak of identical calls,
  matching the loop alarm. It used to count repeats anywhere in the session.
- Steering typed into `reins watch` appends to the queue, like `reins steer`.
  It used to replace it, which could drop a nudge that hadn't been delivered.

- Finished sessions start collapsed in the report unless they are the most
  recent one or have a "Needs you" item. Their summary line still shows the
  blocked and loop counts.
- The report file is written owner-only (`0600`), including when it overwrites
  an existing file. It contains commands and paths from agent runs.
- Durations of 48 hours or more read in days (`19d 3h`).

- **The cockpit shows why a hold parked.** The text a Bash rule matched is
  highlighted in the proposed input, in the detail pane and the approve
  dialog. When it sits below the third line of a long command, that line is
  also shown above the input with its line number. The match comes from the
  guard's own matcher (`firingSegment` in `src/guards.ts`, which
  `checkGuards` now decides with), read against the rule as it stands now.

### Changed

- **The agent list leads with what waits on you.** Order is looping, then
  sessions with a held action, then newest first. A session with no call for
  over a day is counted in the footer and not listed, unless it is looping,
  holds an action or has a steer queued.
- **Agent rows.** The call count is labeled (`76 calls`) and is given up
  before the title is cut. A session with no title, branch or prompt takes
  two lines. A call that did not simply run says what happened to it
  (`denied`, `held`, `failed`, `approved`, `refused`). The "result not
  visible" claim verdict is no longer on the row; the detail pane has it.
- **Dates in the cockpit** read `10 Sep 22:50` in every locale. A hold whose
  session has been quiet for over a day says so.

### Fixed

- **Approving from the cockpit compared against the wrong snapshot.** The
  check that an action is unchanged since it was reviewed read the reviewed
  copy from the screen's model, which refreshes under an open dialog. It now
  keeps the action as it stood when the dialog opened.
- **The cockpit at narrow widths.** Found by running it in a real terminal at
  80×24 and 150×40. The header ran its counts into the clock; it now gives up
  the refresh interval, the idle count and the active count, in that order,
  and keeps what needs you and the looping count. A long session title pushed
  the status and the claim check verdict off the agent row; the row now drops
  its sparkline and cuts the title first. A looping session could be hidden
  under "+2 more"; it is now listed first. File paths inside the project are
  shown from the project root. A hold row cuts the session title before the
  rule id and always keeps a column between them. The help dialog's key
  column no longer runs into its text, and the activity line stays inside the
  detail pane. The left column is half the screen, up to 76 columns.
- **Failed tool calls were never captured.** Claude Code sends a call that
  failed to `PostToolUseFailure`, which reins did not register. No failed
  command reached the trajectory, a command failing on repeat never tripped
  the loop alarm, and a held action that executed and failed was never
  reported as a HOLD BREACH. `reins init` now wires the fourth hook, adds it
  to an existing install without touching the rest, and `reins doctor`
  reports an install that is missing it. **Run `reins init` and restart
  Claude Code to pick it up.**

- The per-tool and guard-fire bars in the report rendered empty. The bar was
  an inline element, so its width was ignored.

## [0.4.0] - 2026-09-29

### Added

- **A parked action now says so in one scannable line.** `hold` was built for
  the run nobody is watching, and it showed. The deny reason was always visible
  — Claude Code renders it as the tool's error — but it is sixty words written
  to redirect a *model*, with the id and the approve command buried mid-sentence.
  Claude Code has exactly one field that reaches the user instead of the model —
  `systemMessage` — and the hold gate now uses it:

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
- **`reins audit --guards [--json]`** looks back over every denial the project
  ever recorded and gives each one two deterministic verdicts. *Stale*: the
  rules reins ships today would not have denied it, so it came from a rule
  that has since been fixed. *Worked around*: a near-identical call ran later
  in the same session. It reads both the `decisions` table and the older
  tagged `tool_calls` rows, so projects captured before 0.4 get their full
  history. Capture stores commands whitespace-collapsed and truncated, which
  can only make a rule look more likely to fire, so staleness is
  under-counted rather than over-counted, and truncated rows are marked. On
  the repo it was built against: 18 denials, 15 stale, 5 worked around.

### Changed

- **Holds use deny-and-queue by default; defer is opt-in.** `holdTransport`
  now defaults to `"deny"` instead of `"auto"`. `auto` confirmed print mode
  before choosing defer, but Claude Code also drops defer when the model makes
  several tool calls in one message, and a hook can't see that. The held
  action then ran, and reins could only report a HOLD BREACH afterwards. That
  is too late for a deploy or a publish. Set `"holdTransport": "auto"` in
  `.reins/config.json` to get the previous behavior. An unrecognized value now
  means `deny`.

### Fixed

- **An approval could be spent in a different directory.** A deny-transport
  approval was keyed to the session and the exact input, but not to where the
  agent was standing. `./deploy.sh` held and approved in `staging/` would then
  run in `prod/` in the same session. Parked actions now record their working
  directory (symlinks resolved), the approval key includes it, and `reins
  pending` shows it whenever it isn't the project root. Approvals filed before
  this change, and still waiting, no longer match: the agent's retry parks
  again and needs a fresh `reins approve`.
- **Pre-0.4 approvals in `.reins/allowed/` are no longer honored.** They were
  keyed by the bare input hash, so any session in any directory could spend
  one. An approval stranded by this re-parks and is asked again.
- **A stale policy file could be stamped as current, freezing its rules.** A
  `policy.json` with no `version` was written back with the current version
  by any `guard add`, `guard remove` or `scan --accept`, while its rule bodies
  stayed old. `policy upgrade` then read that stamp and treated every stale
  rule as a user customization, permanently. In one real repo this kept an
  old `rm-rf` rule without its exemptions, denying `rm -rf .next` fourteen
  times over seven weeks after the fix shipped. Saving now never writes a
  version the file didn't have, and the upgrade reads staleness off each
  rule's `origin` rather than the file's `version`. A rule with no origin is
  refreshed (still diff-first, `--apply` only), and the upgrade tells you to
  mark it `"origin": "user"` if you want to keep it. `doctor` no longer
  reports such a file as current.
- **Bypass detection no longer reports a different command as a workaround.**
  Matching ignored flags, so a denied `git push --force-with-lease origin
  feat/x` looked 86% identical to a later `git fetch origin feat/x`. The
  action words now have to match too, in both the live check and
  `audit --guards`.
- **Your own guard rules stopped applying once the agent `cd`'d into a
  subdirectory.** Read that as a security fix, not a papercut. The hooks took
  the event's `cwd` verbatim as the project root, but Claude Code reports the
  working directory of the *tool call* — and the Bash tool keeps a persistent
  shell cwd, so a single `cd packages/api` made every later hook look for
  `.reins/` in a directory that doesn't have one. Nothing errored, because "no
  `.reins/`" is indistinguishable from "not set up yet": guards fell back to
  the built-in defaults (so `rm -rf /` still held, and nothing *looked*
  broken) while every rule you wrote yourself — including `--ask` and `--hold`
  rules, and anything from `reins scan --accept` — silently stopped matching.
  Steering queued at the root wasn't delivered at those boundaries (it stayed
  queued, so the Stop hook still handed it over — late, not lost), approvals
  filed at the root weren't seen by the call that needed them, and capture
  created a second `.reins/` in the subdirectory, splitting the run's history
  across two databases.

  Hooks now resolve the project the way user-facing commands always have — by
  walking up from the given directory to the nearest `.reins/` — bounded by
  `$CLAUDE_PROJECT_DIR` so an uninitialized project can never climb past
  itself and adopt an ancestor's state (a stray `~/.reins`, say). The walk
  fails open: an unreadable directory mid-climb falls back to where it started
  rather than disturbing the host run.

- **`reins doctor` now reports stray `.reins/` directories** nested below the
  project root. Fixing the resolution doesn't heal a repo the bug already
  touched — from inside that subdirectory the stray is still the *nearest*
  ancestor, so it keeps shadowing your policy. Doctor names them and leaves
  them alone; one could be a legitimately nested project, and deleting
  someone's `runs.db` is not a diagnostic's job.

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
