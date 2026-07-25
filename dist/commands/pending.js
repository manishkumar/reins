"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.cmdPending = cmdPending;
exports.cmdApprove = cmdApprove;
exports.cmdDeny = cmdDeny;
const holds_1 = require("../holds");
const steering_1 = require("../steering");
const util_1 = require("../util");
const format_1 = require("./format");
/** `reins pending` — the review queue: every action a hold rule parked. */
function cmdPending() {
    const pending = (0, holds_1.listPending)();
    if (pending.length === 0) {
        console.log(format_1.c.dim("No actions awaiting approval."));
        return 0;
    }
    // Claude Code replays only the most recently deferred call when a session
    // resumes; an earlier one it superseded is abandoned there. Approving such an
    // entry still files the decision, but nothing will come back for it in that
    // session — so say so plainly instead of letting the human believe otherwise.
    const superseded = supersededDeferIds(pending);
    console.log(format_1.c.bold("Pending actions") + format_1.c.dim(" — parked by hold rules, awaiting your decision"));
    console.log("");
    for (const p of pending) {
        const mark = p.transport !== "defer"
            ? ""
            : superseded.has(p.id)
                ? format_1.c.dim(" ⏸ superseded")
                : format_1.c.dim(" ⏸ in session");
        console.log(`  ${format_1.c.cyan(p.id)}  ${format_1.c.dim(age(p.ts).padEnd(8))} ${format_1.c.dim(shortId(p.session_id).padEnd(9))}` +
            ` ${p.tool.padEnd(8)} ${(0, util_1.truncate)((0, util_1.summarizeToolInput)(p.tool, p.input), 70)}` +
            ` ${format_1.c.dim(`[${p.rule_id}]`)}${mark}`);
    }
    console.log("");
    console.log(format_1.c.dim("Approve one: ") +
        "reins approve <id>" +
        format_1.c.dim("   Refuse one: ") +
        'reins deny <id> [--steer "do this instead"]');
    if (superseded.size > 0) {
        console.log(format_1.c.dim(`  ⏸ superseded: the session parked a newer call after this one; only the newest is\n` +
            `    replayed on resume. Approving it takes effect only if the agent proposes it again.`));
    }
    return 0;
}
/**
 * Ids of deferred holds that a later deferred hold in the same session has
 * displaced. Only the newest survives the resume replay.
 */
function supersededDeferIds(pending) {
    const newest = new Map();
    for (const p of pending) {
        if (p.transport !== "defer")
            continue;
        const cur = newest.get(p.session_id);
        if (!cur || cur.ts < p.ts)
            newest.set(p.session_id, p);
    }
    const out = new Set();
    for (const p of pending) {
        if (p.transport !== "defer")
            continue;
        if (newest.get(p.session_id)?.id !== p.id)
            out.add(p.id);
    }
    return out;
}
/**
 * `reins approve <id>` — sign off on a parked action. Files a one-shot decision
 * the boundary collects the next time the agent comes back for that action.
 *
 * What "comes back" means depends on how the action was held. A deferred hold
 * is replayed by Claude Code itself when the session resumes, so approval binds
 * to that exact call. A denied hold has to be re-proposed by the agent, so
 * approval binds to the identical input — a changed retry is a new proposal,
 * which is the design and not a gap.
 */
function cmdApprove(args) {
    const found = resolveId(args[0], "approve");
    if (!found)
        return 1;
    (0, holds_1.writeDecision)(undefined, found, "approved");
    (0, holds_1.removePending)(undefined, found.id);
    resolveHold(found.id, "approved");
    const summary = (0, util_1.summarizeToolInput)(found.tool, found.input);
    // The reply channel: a targeted steer tells the (possibly still running)
    // session its parked action is cleared. If the run already ended, the
    // decision still stands — it waits at the boundary. Steering delivery is
    // best-effort here; the filed decision is the gate.
    try {
        (0, steering_1.appendSteering)(`Your parked action ${found.id} (${found.tool}: ${(0, util_1.truncate)(summary, 120)}) is approved — ` +
            `retry that exact call now, then continue.`, undefined, found.session_id);
    }
    catch {
        /* session steering is a courtesy; the decision is what matters */
    }
    console.log(format_1.c.green(`✓ Approved ${format_1.c.bold(found.id)}`) + format_1.c.dim(` (${found.tool}: ${(0, util_1.truncate)(summary, 80)})`));
    if (found.transport === "defer") {
        // The call is parked inside Claude Code's own transcript; nothing runs
        // until that session is resumed. Say so, and hand over the exact command —
        // an approval the human thinks landed but that nobody resumes is the
        // quietest possible failure.
        console.log(format_1.c.dim("  The original call is parked in the session. Resume it to run:") +
            "\n    " +
            format_1.c.cyan(`claude --resume ${found.session_id} -p "continue"`));
    }
    else {
        console.log(format_1.c.dim("  One-shot: the next attempt of this ") +
            format_1.c.dim(format_1.c.bold("exact")) +
            format_1.c.dim(" call passes, then the rule holds again. The session was steered to retry."));
    }
    return 0;
}
/**
 * `reins deny <id> [--steer "..."]` — refuse a parked action. Removes it from
 * the queue; optionally queues an alternative instruction as steering (this is
 * where steer becomes the gate's reply channel).
 */
function cmdDeny(args) {
    const steerIdx = args.findIndex((a) => a === "--steer");
    let steerMsg = "";
    if (steerIdx >= 0) {
        steerMsg = args.slice(steerIdx + 1).join(" ").trim();
        args = args.slice(0, steerIdx);
    }
    const found = resolveId(args[0], "deny");
    if (!found)
        return 1;
    // File the refusal, don't just drop the queue entry: a deferred call will be
    // replayed at the boundary, and without a recorded answer it would re-park
    // and ask the same question forever. The refusal (and any alternative) is
    // delivered to the agent exactly when it asks.
    (0, holds_1.writeDecision)(undefined, found, "denied", steerMsg || undefined);
    (0, holds_1.removePending)(undefined, found.id);
    recordRejection(found);
    resolveHold(found.id, "denied");
    const summary = (0, util_1.summarizeToolInput)(found.tool, found.input);
    if (steerMsg) {
        try {
            (0, steering_1.appendSteering)(`Your parked action ${found.id} (${found.tool}: ${(0, util_1.truncate)(summary, 120)}) was refused. ` +
                `Instead: ${steerMsg}`, undefined, found.session_id);
        }
        catch {
            /* best-effort */
        }
    }
    console.log(format_1.c.red(`✗ Refused ${format_1.c.bold(found.id)}`) + format_1.c.dim(` (${found.tool}: ${(0, util_1.truncate)(summary, 80)})`));
    if (steerMsg)
        console.log(format_1.c.dim(`  Steered the session instead: "${(0, util_1.truncate)(steerMsg, 90)}"`));
    else
        console.log(format_1.c.dim('  (No steering queued. Add --steer "..." to tell the agent what to do instead.)'));
    return 0;
}
/** Resolve an id/prefix to exactly one pending action, explaining any miss. */
function resolveId(idArg, verb) {
    if (!idArg) {
        console.error(format_1.c.red(`Usage: reins ${verb} <id>   (ids via: reins pending)`));
        return null;
    }
    const matches = (0, holds_1.findPending)(undefined, idArg);
    if (matches.length === 0) {
        console.error(format_1.c.red(`No pending action matches "${idArg}".`) + format_1.c.dim("  (reins pending lists the queue)"));
        return null;
    }
    if (matches.length > 1) {
        console.error(format_1.c.red(`"${idArg}" is ambiguous — matches:`));
        for (const m of matches) {
            console.error(`  ${format_1.c.cyan(m.id)}  ${m.tool}  ${(0, util_1.truncate)((0, util_1.summarizeToolInput)(m.tool, m.input), 60)}`);
        }
        return null;
    }
    return matches[0];
}
/**
 * Best-effort audit row for a human refusal. The queue file is gone after this,
 * so without the row the trajectory would show a HELD that silently vanished.
 */
function recordRejection(p) {
    try {
        const { openDb, upsertSessionStart, insertToolCall, } = require("../db");
        const db = openDb();
        if (!db)
            return;
        const { hashToolInput } = require("../util");
        const { resolveProjectDir } = require("../paths");
        upsertSessionStart(db, p.session_id, resolveProjectDir(), (0, util_1.nowIso)());
        insertToolCall(db, {
            session_id: p.session_id,
            tool: p.tool,
            input_summary: `REFUSED: ` +
                (0, util_1.summarizeToolInput)(p.tool, p.input) +
                ` [guard:${p.rule_id}] [hold:${p.id}]`,
            input_hash: hashToolInput("REFUSED:" + p.tool, p.input),
            ok: 0,
            ts: (0, util_1.nowIso)(),
        });
    }
    catch {
        /* audit is best-effort; the refusal itself already happened (file removed) */
    }
}
/**
 * Close the loop on the decisions row this hold parked, so `reins audit`
 * shows how a held action was resolved, not just that it was held. Best-effort
 * like recordRejection: the approve/deny itself already happened via the
 * pending-queue file, so a capture failure here changes nothing about that.
 */
function resolveHold(id, resolution) {
    try {
        const { openDb, resolveDecision } = require("../db");
        const db = openDb();
        if (!db)
            return;
        resolveDecision(db, {
            hold_id: id,
            resolution,
            resolver: "human-cli",
            resolved_ts: (0, util_1.nowIso)(),
        });
    }
    catch {
        /* audit is best-effort; the approve/deny already happened */
    }
}
function shortId(id) {
    return id.length > 8 ? id.slice(0, 8) : id;
}
function age(tsIso) {
    const ms = Date.now() - new Date(tsIso).getTime();
    if (!isFinite(ms) || ms < 0)
        return "?";
    const s = Math.round(ms / 1000);
    if (s < 60)
        return `${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60)
        return `${m}m`;
    const h = Math.floor(m / 60);
    if (h < 48)
        return `${h}h`;
    return `${Math.floor(h / 24)}d`;
}
