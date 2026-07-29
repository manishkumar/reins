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
exports.cmdScan = cmdScan;
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const guards_1 = require("../guards");
const paths_1 = require("../paths");
const scan_1 = require("../scan");
const format_1 = require("./format");
function suggestedPath(cwd) {
    return path.join((0, paths_1.reinsDir)(cwd), "suggested.json");
}
/**
 * `reins scan` — propose rules aimed at what THIS repo can destroy.
 *
 * Two steps by design. The scan writes proposals to .reins/suggested.json and
 * changes nothing; `reins scan --accept` moves them into the active policy.
 * Making the review structural rather than advisory is the point: the first
 * generated rule that breaks someone's build is the last generated rule they
 * ever trust, so nothing here may activate itself.
 */
function cmdScan(args) {
    const accept = args.includes("--accept");
    const guards = (0, guards_1.loadGuards)();
    const result = (0, scan_1.scanRepo)(undefined, guards.rules);
    if (result.detections.length === 0) {
        console.log(format_1.c.dim("No known stacks detected in ") + result.root);
        console.log(format_1.c.dim("reins scan reads manifests only (package.json, prisma/, *.tf, k8s/, .env, …)."));
        return 0;
    }
    console.log(format_1.c.bold("reins scan") + format_1.c.dim("  " + result.root));
    console.log("");
    console.log(format_1.c.bold("Detected"));
    for (const d of result.detections) {
        console.log(`  ${format_1.c.green("•")} ${d.id.padEnd(14)} ${format_1.c.dim(d.evidence)}`);
    }
    if (result.newRules.length === 0) {
        console.log("");
        console.log(`${format_1.c.green("✓")} Every suggested rule is already in your policy.`);
        return 0;
    }
    console.log("");
    console.log(format_1.c.bold(`Proposed (${result.newRules.length})`));
    for (const r of result.newRules) {
        console.log(`  ${format_1.c.yellow(r.action ?? "hold")} ${r.id.padEnd(28)} ${format_1.c.dim(r.reason)}`);
        console.log(format_1.c.dim(`      ${r.pattern}`));
    }
    if (result.alreadyPresent.length > 0) {
        console.log(format_1.c.dim(`  (${result.alreadyPresent.length} already present: ${result.alreadyPresent.join(", ")})`));
    }
    console.log("");
    console.log(format_1.c.dim("These are proposals, not rules. Nothing is enforced until you accept them.\n" +
        "None is a `deny` — a generated rule is a guess, and a wrong veto in your own\n" +
        "run costs more than a missed pattern. Promote one to deny yourself if you mean it."));
    if (!accept) {
        writeSuggestions(result.newRules);
        console.log("");
        console.log(`Wrote ${format_1.c.bold(".reins/suggested.json")} — review it, then:`);
        console.log(format_1.c.dim("  reins scan --accept        add them all to your policy"));
        console.log(format_1.c.dim("  (or copy the ones you want into .reins/policy.json by hand)"));
        return 0;
    }
    const next = [...result.newRules, ...guards.rules];
    (0, guards_1.saveGuards)({ ...guards, rules: next });
    try {
        fs.rmSync(suggestedPath(), { force: true });
    }
    catch {
        /* the staging file is a convenience, not state */
    }
    console.log("");
    console.log(`${format_1.c.green("✓")} Added ${result.newRules.length} rule(s) to .reins/policy.json`);
    console.log(format_1.c.dim("  Review with `reins guard list`; remove any with `reins guard remove <id>`."));
    return 0;
}
function writeSuggestions(rules) {
    try {
        (0, paths_1.ensureReinsDir)();
        fs.writeFileSync(suggestedPath(), JSON.stringify({ rules }, null, 2) + "\n");
    }
    catch (e) {
        console.error(format_1.c.yellow("! could not write .reins/suggested.json: ") + String(e));
    }
}
