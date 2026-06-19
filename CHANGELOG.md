# Changelog

All notable changes to `reins` are documented here. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/); this project uses [SemVer](https://semver.org/).

## [Unreleased]

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
