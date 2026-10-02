# How it works

Each hook is `reins hook <pre-tool|post-tool|post-tool-failure|stop>`, reading the event JSON on stdin and replying over stdout per the Claude Code hook contract. `pre-tool` checks guards (deny, ask, or hold — deny-and-queue by default, or `defer` when opted in and Claude Code honors it) then steering (inject + clear). `post-tool` records the call, raises the loop alarm on consecutive repeats, and flags a `HOLD BREACH` if a still-parked action executed anyway; `post-tool-failure` does the same for a call that failed. `stop` delivers any still-pending steering (briefly holding the stop), then finalizes the run — noting any actions still parked, and what the session's own calls say about its work being done (the claim check). State lives in `.reins/`: `steering.txt`, `policy.json` (`guards.json` before 0.4, still read), `pending/`, `decided/` (`allowed/` before 0.4, no longer read), `config.json`, `runs.db`. Both the CLI and the hooks find `.reins/` by walking up to the nearest one — commands work from any subdirectory, and a tool call the agent makes after `cd`-ing into one still sees the project's own rules, steering and approval queue (the hooks' walk is bounded by `$CLAUDE_PROJECT_DIR`, so it never climbs above the session root).

The file formats and decision semantics behind guards/steering/holds are written up separately, vendor-neutral, in [SPEC.md](../SPEC.md) — not a standard, just a description of what reins does, in case another harness ever wants the same gate.

## Testing the hooks manually

<details>
<summary>The hooks read the Claude Code event JSON on <b>stdin</b> and reply on stdout — you can exercise them by hand. <i>(expand)</i></summary>

Useful for trying out a guard or steering rule without a live run:

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

Useful fields per event: `session_id`, `cwd`, `tool_name`, `tool_input` (pre/post); `tool_response` (post); `error`, `is_interrupt` (post-tool-failure); `transcript_path`, `reason` (stop). No output from a hook = "allow, inject nothing."

Two notes for manual testing: events **without** a `session_id` don't get recorded (so quick guard/steer checks won't litter your trajectory log); and a session you record by hand will show as "still running" in `reins lastrun` until you also send a `stop` event for it.

</details>

---

[Back to the README](../README.md)
