"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.sessionFace = sessionFace;
exports.faceReader = faceReader;
exports.shortId = shortId;
exports.addressOf = addressOf;
exports.headOf = headOf;
exports.aboutOf = aboutOf;
const db_1 = require("./db");
const names_1 = require("./names");
const sessionContext_1 = require("./sessionContext");
function sessionFace(id, custom, transcript) {
    const ctx = (0, sessionContext_1.readSessionContext)(transcript);
    const name = (0, names_1.displayName)(id, custom);
    return { name, label: (custom ?? "").trim() || ctx.title || name, asked: ctx.asked, branch: ctx.branch };
}
/** Look sessions up by id, once each. Without a DB every session gets its mnemonic. */
function faceReader(db) {
    const seen = new Map();
    let sql = null;
    return (id) => {
        let f = seen.get(id);
        if (f)
            return f;
        f = sessionFace(id);
        if (db) {
            try {
                sql ??= `SELECT ${(0, db_1.hasSessionNameColumn)(db) ? "name" : "NULL AS name"}, ${(0, db_1.hasSessionTranscriptColumn)(db) ? "transcript" : "NULL AS transcript"} FROM sessions WHERE id = ?`;
                const r = db.prepare(sql).get(id);
                if (r)
                    f = sessionFace(id, r.name, r.transcript);
            }
            catch {
                /* locked or older db: the mnemonic stands */
            }
        }
        seen.set(id, f);
        return f;
    };
}
function shortId(id) {
    return id.length > 8 ? id.slice(0, 8) : id;
}
/** The name and short id a human types to address the session. */
function addressOf(f, id) {
    return `${f.name} ${shortId(id)}`;
}
/** What leads a row: the label, or the address when there is no title to lead with. */
function headOf(f, id) {
    return f.label === f.name ? addressOf(f, id) : f.label;
}
/** The line under the head: the address (when a title took the head), branch and last prompt. */
function aboutOf(f, id, maxAsked = 70) {
    const asked = f.asked && f.asked.length > maxAsked ? f.asked.slice(0, maxAsked - 1) + "…" : f.asked;
    return [f.label === f.name ? "" : addressOf(f, id), f.branch ? `⎇ ${f.branch}` : "", asked ? `❯ ${asked}` : ""]
        .filter(Boolean)
        .join(" · ");
}
