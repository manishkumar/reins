"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.cmdPending = cmdPending;
exports.cmdApprove = cmdApprove;
exports.cmdDeny = cmdDeny;
const path = __importStar(require("node:path"));
const paths_1 = require("../paths");
const holds_1 = require("../holds");
const holdActions_1 = require("../holdActions");
const util_1 = require("../util");
const db_1 = require("../db");
const sessionFace_1 = require("../sessionFace");
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
    const superseded = (0, holdActions_1.supersededDeferIds)(pending);
    // Which session asked, in words. Best-effort: the queue itself is plain
    // files and lists without the DB, with mnemonics.
    let db = null;
    try {
        db = (0, db_1.openDbReadOnly)();
    }
    catch {
        /* capture unavailable */
    }
    const faceOf = (0, sessionFace_1.faceReader)(db);
    console.log(format_1.c.bold("Pending actions") + format_1.c.dim(" — parked by hold rules, awaiting your decision"));
    console.log("");
    for (const p of pending) {
        const mark = p.transport !== "defer"
            ? ""
            : superseded.has(p.id)
                ? format_1.c.dim(" ⏸ superseded")
                : format_1.c.dim(" ⏸ in session");
        console.log(`  ${format_1.c.cyan(p.id)}  ${format_1.c.dim(age(p.ts).padEnd(8))} ${format_1.c.dim((0, sessionFace_1.shortId)(p.session_id).padEnd(9))}` +
            ` ${p.tool.padEnd(8)} ${(0, util_1.truncate)((0, util_1.summarizeToolInput)(p.tool, p.input), 70)}` +
            ` ${format_1.c.dim(`[${p.rule_id}]`)}${mark}`);
        // The directory is part of what gets approved, so the approver sees it
        // whenever it isn't simply the project root.
        const where = workdirLabel(p.cwd);
        if (where)
            console.log(`            ${format_1.c.dim("in " + where)}`);
        const face = faceOf(p.session_id);
        const about = (0, sessionFace_1.aboutOf)(face, p.session_id);
        console.log(`            ${format_1.c.dim("from " + (0, sessionFace_1.headOf)(face, p.session_id) + (about ? " · " + about : ""))}`);
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
/** Where a proposal was made, relative to the project when it is inside it.
 *  Empty for the project root itself, and for entries that predate the field. */
function workdirLabel(cwd) {
    if (!cwd)
        return "";
    const rel = path.relative((0, holds_1.proposalWorkdir)((0, paths_1.resolveProjectDir)()), cwd);
    if (rel === "")
        return "";
    if (rel.startsWith("..") || path.isAbsolute(rel))
        return cwd;
    return rel + path.sep;
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
    const done = (0, holdActions_1.approveHold)(found, "human-cli");
    console.log(format_1.c.green(`✓ Approved ${format_1.c.bold(done.id)}`) + format_1.c.dim(` (${done.tool}: ${(0, util_1.truncate)(done.summary, 80)})`));
    if (done.resume) {
        // The call is parked inside Claude Code's own transcript; nothing runs
        // until that session is resumed. Say so, and hand over the exact command —
        // an approval the human thinks landed but that nobody resumes is the
        // quietest possible failure.
        console.log(format_1.c.dim("  The original call is parked in the session. Resume it to run:") + "\n    " + format_1.c.cyan(done.resume));
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
    const done = (0, holdActions_1.denyHold)(found, steerMsg || undefined, "human-cli");
    console.log(format_1.c.red(`✗ Refused ${format_1.c.bold(done.id)}`) + format_1.c.dim(` (${done.tool}: ${(0, util_1.truncate)(done.summary, 80)})`));
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
