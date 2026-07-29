"use strict";
// Did the guard actually stop anything?
//
// Six weeks of captured runs in a real repo answered "no". Sixteen denials,
// and in five of the five cases where the agent still wanted the outcome, it
// reran a trivially-altered command that sailed through — median gap eleven
// seconds. The most common edit was dropping a flag:
//
//     14:34:21  DENIED   rm -f src/app/harness/page.tsx && rmdir src/app/harness
//     14:34:30  ALLOWED  rm    src/app/harness/page.tsx && rmdir src/app/harness
//
// A single denial is not news — it's the guard doing its job. A denial that is
// undone seconds later is news, because it means one of two things and the
// human needs to know which: the rule is wrong and is fighting legitimate work,
// or it is right and is not holding. Both are worth interrupting for; neither is
// visible today.
//
// This is REPORTING, never enforcement. Detection happens in PostToolUse, from
// the far side of execution — the call already ran. Nothing here may influence
// a gate decision, and the state lives in a plain file rather than the DB so it
// keeps working where SQLite doesn't (capture is optional; this isn't).
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
exports.BYPASS_WINDOW_MS = exports.BYPASS_SIMILARITY = void 0;
exports.fingerprint = fingerprint;
exports.containment = containment;
exports.recordDenial = recordDenial;
exports.findBypass = findBypass;
exports.markBypassed = markBypassed;
exports.summarizeSession = summarizeSession;
exports.clearSession = clearSession;
exports.formatSummary = formatSummary;
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const paths_1 = require("./paths");
/** How much of the denied command must reappear before it counts as a retry. */
exports.BYPASS_SIMILARITY = 0.8;
/** Floor on shared tokens, so a two-word command can't match on one accident. */
const MIN_SHARED_TOKENS = 2;
/** How long a denial stays "recent" enough for a retry to be attributed to it. */
exports.BYPASS_WINDOW_MS = 15 * 60 * 1000;
/** Cap on the ledger so a long-running project can't grow it without bound. */
const MAX_RECORDS = 300;
function ledgerPath(cwd) {
    return path.join((0, paths_1.reinsDir)(cwd), "denials.jsonl");
}
/**
 * Reduce a command to the tokens that carry its INTENT, discarding the parts an
 * agent rewrites when it's working around a veto.
 *
 * Flags are dropped outright, which looks aggressive until you notice that
 * every observed bypass was precisely a flag edit: `rm -rf x` → `rm -r x` →
 * `rm x`. What survives is the verb and the targets, which is what actually
 * determines whether the same thing happened.
 */
function fingerprint(command) {
    const tokens = command
        .replace(/["']/g, " ")
        .split(/\s+/)
        .map((t) => t.trim().toLowerCase())
        .filter(Boolean)
        // Flags: the thing that gets edited to slip past a pattern.
        .filter((t) => !t.startsWith("-"))
        // Shell punctuation and redirections carry no intent.
        .filter((t) => !/^(?:&&|\|\||[;|&]|\d?>{1,2}&?\d?|<)$/.test(t))
        .filter((t) => !/^\d?>{1,2}/.test(t))
        // Normalize path noise so ./x, x and /abs/proj/x agree.
        .map((t) => t.replace(/^\.\//, "").replace(/\/+$/, ""));
    return Array.from(new Set(tokens)).sort();
}
/**
 * How much of the DENIED command reappears in the executed one: |A∩B| / |A|.
 *
 * Deliberately asymmetric, and that asymmetry is the whole design. The question
 * worth answering is "did the thing I vetoed happen anyway?", not "are these two
 * commands equally similar to each other". A symmetric measure (Jaccard) gets
 * this wrong on real data: one of the observed bypasses re-ran the denied
 * deletion with `&& echo removed` appended, and those two extra tokens dragged
 * the score below threshold — reporting no bypass for a command that plainly
 * was one. Growth in the retry is normal; shrinkage of the original is not.
 */
function containment(denied, executed) {
    const A = new Set(denied);
    if (A.size === 0)
        return 0;
    const B = new Set(executed);
    let shared = 0;
    for (const x of A)
        if (B.has(x))
            shared++;
    // A one-token overlap on a short command is coincidence, not a retry.
    if (shared < Math.min(MIN_SHARED_TOKENS, A.size))
        return 0;
    return shared / A.size;
}
function readLedger(cwd) {
    try {
        const raw = fs.readFileSync(ledgerPath(cwd), "utf8");
        const out = [];
        for (const line of raw.split("\n")) {
            if (!line.trim())
                continue;
            try {
                out.push(JSON.parse(line));
            }
            catch {
                // A torn line (concurrent append) is skipped, not fatal.
            }
        }
        return out;
    }
    catch {
        return [];
    }
}
function writeLedger(records, cwd) {
    (0, paths_1.ensureReinsDir)(cwd);
    const kept = records.slice(-MAX_RECORDS);
    fs.writeFileSync(ledgerPath(cwd), kept.map((r) => JSON.stringify(r)).join("\n") + "\n");
}
/** Append a denial to the ledger. Best-effort: never throws into the hook. */
function recordDenial(cwd, rec) {
    try {
        (0, paths_1.ensureReinsDir)(cwd);
        fs.appendFileSync(ledgerPath(cwd), JSON.stringify(rec) + "\n");
        // Trim opportunistically rather than on every call.
        const all = readLedger(cwd);
        if (all.length > MAX_RECORDS * 2)
            writeLedger(all, cwd);
    }
    catch {
        /* reporting is never allowed to break a run */
    }
}
/**
 * Did this executed command undo a recent denial in the same session?
 *
 * Scoped to one session on purpose: two developers hitting the same rule in
 * different runs is not a bypass, and cross-session attribution would produce
 * exactly the kind of confident-but-wrong claim that makes people stop reading
 * the output.
 */
function findBypass(cwd, sessionId, command, now = new Date()) {
    if (!sessionId || !command)
        return null;
    const fp = fingerprint(command);
    if (fp.length === 0)
        return null;
    let best = null;
    for (const denial of readLedger(cwd)) {
        if (denial.session_id !== sessionId)
            continue;
        if (denial.bypassed_ts)
            continue; // already reported once
        const gapMs = now.getTime() - Date.parse(denial.ts);
        if (!(gapMs >= 0 && gapMs <= exports.BYPASS_WINDOW_MS))
            continue;
        const score = containment(denial.fp ?? [], fp);
        if (score < exports.BYPASS_SIMILARITY)
            continue;
        if (!best || score > best.score)
            best = { denial, score, gapMs };
    }
    return best;
}
/** Mark a denial as bypassed so it is reported once, not on every later call. */
function markBypassed(cwd, hit, executedSummary, now = new Date()) {
    try {
        const all = readLedger(cwd);
        for (const r of all) {
            if (r.session_id === hit.denial.session_id && r.ts === hit.denial.ts && !r.bypassed_ts) {
                r.bypassed_ts = now.toISOString();
                r.bypassed_by = executedSummary;
                r.similarity = Math.round(hit.score * 100) / 100;
                break;
            }
        }
        writeLedger(all, cwd);
    }
    catch {
        /* best-effort */
    }
}
/** Roll up one session's guard activity — the input to the Stop-hook summary. */
function summarizeSession(cwd, sessionId) {
    const rows = readLedger(cwd).filter((r) => r.session_id === sessionId);
    const byRule = new Map();
    let bypassed = 0;
    let fastest = null;
    for (const r of rows) {
        const entry = byRule.get(r.rule_id) ?? { rule_id: r.rule_id, fired: 0, bypassed: 0 };
        entry.fired++;
        if (r.bypassed_ts) {
            entry.bypassed++;
            bypassed++;
            const gap = Date.parse(r.bypassed_ts) - Date.parse(r.ts);
            if (Number.isFinite(gap) && (fastest === null || gap < fastest))
                fastest = gap;
        }
        byRule.set(r.rule_id, entry);
    }
    return {
        fired: rows.length,
        bypassed,
        byRule: [...byRule.values()].sort((a, b) => b.fired - a.fired),
        fastestBypassMs: fastest,
    };
}
/** Drop a session's rows once its run is summarized, so the ledger stays small
 *  and a later session can't be told about a stale denial. */
function clearSession(cwd, sessionId) {
    try {
        const kept = readLedger(cwd).filter((r) => r.session_id !== sessionId);
        writeLedger(kept, cwd);
    }
    catch {
        /* best-effort */
    }
}
function human(ms) {
    return ms < 1000 ? `${ms}ms` : ms < 60000 ? `${Math.round(ms / 1000)}s` : `${Math.round(ms / 60000)}m`;
}
/**
 * The session summary. Written for the person who walked away and came back —
 * the per-event warning serves whoever is watching; this serves whoever isn't.
 *
 * It leads with the bypass count rather than the fire count because that's the
 * fact that changes what the reader should do. "3 guards fired" invites a nod;
 * "3 fired, 3 bypassed in under 15s" invites fixing the rules.
 */
function formatSummary(summary, heldCount) {
    if (summary.fired === 0 && heldCount === 0)
        return null;
    const parts = [];
    if (summary.fired > 0) {
        const rules = summary.byRule
            .map((r) => `${r.fired}× ${r.rule_id}${r.bypassed > 0 ? ` (${r.bypassed} bypassed)` : ""}`)
            .join(", ");
        parts.push(`${summary.fired} guard${summary.fired === 1 ? "" : "s"} fired: ${rules}.`);
        if (summary.bypassed > 0) {
            const fastest = summary.fastestBypassMs !== null ? `, the fastest after ${human(summary.fastestBypassMs)}` : "";
            parts.push(`${summary.bypassed} of them ${summary.bypassed === 1 ? "was" : "were"} worked around by a ` +
                `near-identical call that ran anyway${fastest}. Guards match the form of a command, not its ` +
                `intent — either these rules are too broad for this repo, or they need to be holds.`);
        }
    }
    if (heldCount > 0) {
        parts.push(`${heldCount} action${heldCount === 1 ? "" : "s"} still parked for approval — reins pending.`);
    }
    return "[reins] " + parts.join(" ");
}
