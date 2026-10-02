# Steering

`reins steer "<message>"` queues a one-line note that the agent reads at its next tool call. This page is the detail and the caveats.

## The two honest caveats (this is the product, read them)

**1. Latency: next tool boundary, not "right now."** A `PreToolUse` hook only fires when the agent is *about to call a tool*. So steering lands at the agent's next decision point — usually seconds away, but not instantaneous. This is the correct async model (you can't babysit an agent keystroke-by-keystroke), and it's why the verbs are "steer" and "nudge," never "stop" or "interrupt."

One delivery guarantee: if there **is** no next tool call — you steered as the agent was already finishing — the Stop hook delivers the nudge instead, briefly holding the stop and handing the note over. A queued steer is never silently lost.

**2. Steering composes with the goal; it can't overwrite it.** Think of `reins steer` as **the detail you forgot to put in the original prompt** — added spec from the same author. *"focus on the token refresh path"*, *"keep it minimal"*, *"use the existing logger"*. It does **not** work as a hijack: a nudge that flatly contradicts the user's explicit instructions ("STOP, ignore everything, do X instead") is correctly weighed down by the model. Since the person typing `reins steer` is the same person who wrote the prompt, this is rarely a real constraint — just phrase steering as *more spec*, not *a reversal*. **If you need a hard "never do X," that's a guard, not steering.**

Two quick `reins steer`s before the next tool call **both** reach the agent (they append). Use `--replace` to overwrite, `reins steer --clear` to reset.

**Running several agents in one repo?** A plain `reins steer` is a *broadcast* — it lands on whichever session hits the next tool boundary first. When more than one session has been active in the last ~15 minutes and you're at a terminal, `reins steer "<msg>"` **lists them and asks which one you mean** (name, id, liveness, last tool call) — press Enter to keep the broadcast, pick a number to target, `--broadcast` to skip the question. Piped/scripted invocations are never prompted; they broadcast exactly as before.

To aim without the picker, target a session by id prefix, its auto mnemonic, or a name you gave it:

```bash
reins sessions                                   # every session has a name under its title: rosy-egret a2cbbe90
reins name a2cbbe90 "payments-agent"             # ...or give it your own
reins steer "stay on the payments module" --session payments-agent
```

A targeted nudge only reaches that session; broadcasts still go to everyone else. Names are display and addressing sugar stored in the local capture DB (so custom names need `node:sqlite`, Node ≥ 22.5) — the auto mnemonics are derived from the session id and work everywhere. Steering files, holds, and approvals stay keyed by the real session id; nothing control-plane ever depends on a name resolving.

---

[Back to the README](../README.md)
