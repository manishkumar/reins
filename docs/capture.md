# Capture and the report

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

- `reins sessions` — list recent sessions in the project (what each is about, status, call count, time), with the name and short id you address it by, its branch and its last prompt on the line below. Handy when several agents have run in one repo. Every session gets a deterministic mnemonic (`rosy-egret`) derived from its id; `reins name <session> "<label>"` replaces it with something meaningful to you (`--clear` reverts). Names work anywhere a session id does: `steer --session`, `lastrun`, the steer picker.
- `reins lastrun <session>` — inspect a specific older run (id prefix or name).
- `reins loops` — just the sessions where the agent got stuck.

## `reins report` — the captured runs as a local web page

`watch` is the live view; **`reins report` is the browsable archive.** It reads `.reins/runs.db` and writes a single **self-contained HTML file** (inline CSS, no JS framework, **zero network requests** — nothing leaves your machine) with:

- **Needs you**, at the top: every parked hold with its proposed input, how long it has waited, and the `reins approve` / `reins deny` commands to copy; then any hold breach or worked-around guard from the last 7 days. Older events are counted, not listed (`reins audit --guards` has them all). There is no approve button: approving stays a deliberate CLI action, and a page that could approve would need a local server any website could send requests to.
- **Summary cards** — sessions, tool calls, blocked, failed, loops, plus **token and cost rollups** when the transcript had them (best-effort; hidden when never captured).
- **Per-tool breakdown** — how the calls split across tools (Bash vs Edit vs Read…), with per-tool blocked/failed counts.
- **Guard-fire heatmap** — which guard rules actually fired, split into denied (⛔) vs escalated-to-you (✋), so you can see which rules earn their keep and which never trigger.
- **Every session's full trajectory** — guard-blocks (⛔ with the rule id that fired), escalations (✋), failures (✗), and loops (⟳) marked inline.

```bash
reins report            # writes .reins/report.html
reins report --open     # ...and opens it in your browser
reins report -o /tmp/run.html   # custom path (e.g. to share a single run)
```

Finished sessions start collapsed unless they're the latest or have something in "Needs you". The file is written owner-only (`0600`) because it contains commands and paths from your runs. Without SQLite (Node < 22.5, or `REINS_NO_SQLITE=1`) the report still renders holds and the bypass ledger, since those are plain files; session history needs capture.

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

[Back to the README](../README.md)
