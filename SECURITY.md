# Security Policy

`reins` is local-first and makes zero network calls — there's no server, account, or telemetry to attack. The security surface is local, and worth being explicit about.

## Reporting a vulnerability

Please open a [GitHub security advisory](https://github.com/manishkumar/reins/security/advisories/new) or email the maintainer rather than filing a public issue for anything exploitable. We'll acknowledge within a few days.

## Threat model (what reins does and does not protect)

**`.reins/steering.txt` is the sensitive surface.** Anything that can write that file can inject context into your running agent at its next tool call. reins creates `.reins/` as `0700` and git-ignores it, but:

- Do **not** point an untrusted or automated writer (CI, shared scripts) at `.reins/steering.txt`. Treat write access to it as write access to your prompts.
- Steering is a **soft** channel — the model weighs it and resists outright contradictions — so this is defense-in-depth, not a sole control. v1 ships no signing on the steering file.

**`.reins/allowed/` is approval access.** A hold rule's one-shot allowances live there as files; anything that can write that directory can pre-approve a parked action. Same posture as steering: `0700`, git-ignored, don't point untrusted writers at it. (`.reins/pending/` stores each parked action's full tool input, which may contain sensitive strings — same protections apply.)

**Guards are speed bumps, not a sandbox.** They are deterministic vetoes on recognized command/path patterns — excellent against accidents and obvious footguns, but they block a *form*, not an *intent*. A determined or adversarial agent can reach a forbidden outcome through an unrecognized path (e.g. `find -delete` instead of `rm -rf`, or a payload hidden inside `bash -c "…"`). For real containment, use OS-level sandboxing and permission boundaries. Do **not** rely on reins guards as a security boundary against a hostile process.

**Fail-open by design.** A crashing hook lets the agent proceed, so a bug in reins can never wedge your work — which also means guards are best-effort if the hook process itself errors.

## Supported versions

reins is pre-1.0 and ships fixes on the latest `main` / newest published version. Please reproduce on the latest before reporting.
