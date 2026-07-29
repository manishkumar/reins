"use strict";
// What is actually dangerous in THIS repo?
//
// The shipped denylist is the same eight rules everywhere, which means it is
// aimed at no one in particular. Measured against six weeks of real work in a
// Next.js + Prisma + Supabase repo, it spent its entire budget of user goodwill
// blocking `rm -rf .next` — sixteen times, wrongly — while `npx prisma …` ran
// unguarded, `.env` was read unguarded, and a remote branch was deleted
// unguarded. The blast radius was in the database and the deploy path. The
// guards were pointed at the filesystem.
//
// So: read the manifests, and propose rules aimed at what this repo can
// actually destroy. Three constraints make this safe to ship:
//
//   1. DETERMINISTIC. Evidence is a file that exists or a dependency that is
//      declared. No model, no network, no new dependency — the badges stay
//      true and the same input always produces the same proposals.
//   2. NEVER AUTO-ACTIVATED. Proposals land in .reins/suggested.json and do
//      nothing until a human moves them across. "Human reviewed" has to be
//      structural, not a line in the docs.
//   3. NEVER `deny`. A hand-written deny is a considered veto; a generated one
//      is a guess. Guesses get `hold` or `ask`, and the human promotes them if
//      they mean it. This is the direct lesson of the false-positive data.
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
exports.scanRepo = scanRepo;
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const paths_1 = require("./paths");
function buildContext(root) {
    const deps = new Set();
    try {
        const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
        for (const d of Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }))
            deps.add(d);
    }
    catch {
        /* no package.json, or unreadable — not an error, just no evidence */
    }
    return {
        root,
        deps,
        has: (rel) => {
            try {
                return fs.existsSync(path.join(root, rel));
            }
            catch {
                return false;
            }
        },
    };
}
/** Any file in `root` matching a predicate, one level deep — enough for *.tf. */
function hasFileMatching(root, re) {
    try {
        return fs.readdirSync(root).some((f) => re.test(f));
    }
    catch {
        return false;
    }
}
const suggested = (r) => ({ ...r, origin: "suggested" });
const DETECTORS = [
    {
        id: "prisma",
        detect: (c) => c.deps.has("prisma") || c.deps.has("@prisma/client")
            ? "prisma in package.json"
            : c.has("prisma/schema.prisma")
                ? "prisma/schema.prisma"
                : null,
        rules: [
            suggested({
                // The exact shape of the incident that prompted this: `migrate diff`
                // reads as read-only, and the destruction is a side effect of Prisma
                // resetting whatever --shadow-database-url points at.
                id: "prisma-shadow-db",
                type: "bash",
                pattern: "prisma\\b[^\\n]*--shadow-database-url",
                action: "hold",
                reason: "Prisma --shadow-database-url resets the database it points at. Held by reins for approval.",
            }),
            suggested({
                id: "prisma-destructive-migrate",
                type: "bash",
                pattern: "prisma\\s+(?:migrate\\s+reset|db\\s+push\\b[^\\n]*--force-reset|db\\s+execute)",
                action: "hold",
                reason: "Destructive Prisma migration command. Held by reins for approval.",
            }),
        ],
    },
    {
        id: "supabase",
        detect: (c) => c.deps.has("@supabase/supabase-js") || c.deps.has("@supabase/ssr")
            ? "@supabase/* in package.json"
            : c.has("supabase/config.toml")
                ? "supabase/"
                : null,
        rules: [
            suggested({
                id: "supabase-db-reset",
                type: "bash",
                pattern: "supabase\\s+db\\s+(?:reset|remote\\s+commit)",
                action: "hold",
                reason: "supabase db reset drops and recreates the database. Held by reins for approval.",
            }),
        ],
    },
    {
        id: "drizzle",
        detect: (c) => (c.deps.has("drizzle-kit") ? "drizzle-kit in package.json" : null),
        rules: [
            suggested({
                id: "drizzle-push",
                type: "bash",
                pattern: "drizzle-kit\\s+(?:push|drop)\\b",
                action: "hold",
                reason: "drizzle-kit push/drop alters the live schema. Held by reins for approval.",
            }),
        ],
    },
    {
        id: "django",
        detect: (c) => (c.has("manage.py") ? "manage.py" : null),
        rules: [
            suggested({
                id: "django-destructive",
                type: "bash",
                pattern: "manage\\.py\\s+(?:flush|sqlflush|reset_db)\\b",
                action: "hold",
                reason: "Django flush/reset_db empties the database. Held by reins for approval.",
            }),
        ],
    },
    {
        id: "alembic",
        detect: (c) => (c.has("alembic.ini") ? "alembic.ini" : null),
        rules: [
            suggested({
                id: "alembic-downgrade",
                type: "bash",
                pattern: "alembic\\s+downgrade\\b",
                action: "hold",
                reason: "alembic downgrade rolls back schema and can drop data. Held by reins for approval.",
            }),
        ],
    },
    {
        id: "terraform",
        detect: (c) => hasFileMatching(c.root, /\.tf$/) ? "*.tf in project root" : c.has("terraform") ? "terraform/" : null,
        rules: [
            suggested({
                id: "terraform-destroy",
                type: "bash",
                pattern: "terraform\\s+(?:destroy\\b|apply\\b[^\\n]*-auto-approve)",
                action: "hold",
                reason: "terraform destroy / auto-approved apply changes real infrastructure. Held by reins.",
            }),
        ],
    },
    {
        id: "kubernetes",
        detect: (c) => (c.has("k8s") ? "k8s/" : c.has("helm") ? "helm/" : null),
        rules: [
            suggested({
                id: "kubectl-delete",
                type: "bash",
                pattern: "kubectl\\s+delete\\b",
                action: "hold",
                reason: "kubectl delete removes live cluster resources. Held by reins for approval.",
            }),
        ],
    },
    {
        id: "dotenv",
        detect: (c) => (c.has(".env") ? ".env" : c.has(".env.production") ? ".env.production" : null),
        rules: [
            suggested({
                // Deliberately `ask`, not `hold` or `deny`. Reading .env to check a var
                // name is routine, and the captured data showed how expensive an
                // over-eager rule is. This one exists because the shipped write-guard
                // watches the wrong direction: secrets leave by being read.
                id: "dotenv-read",
                type: "bash",
                pattern: "(?:\\bcat\\b|\\bless\\b|\\bhead\\b|\\btail\\b|\\bgrep\\b)[^\\n]*\\.env(?:\\.[\\w.-]+)?(?:\\s|$)",
                action: "ask",
                reason: "Reading a .env file surfaces secrets — reins is asking first.",
            }),
        ],
    },
    {
        id: "npm-publish",
        detect: (c) => {
            try {
                const pkg = JSON.parse(fs.readFileSync(path.join(c.root, "package.json"), "utf8"));
                return pkg.private === true || !pkg.name ? null : "publishable package.json";
            }
            catch {
                return null;
            }
        },
        rules: [
            suggested({
                id: "npm-publish",
                type: "bash",
                pattern: "npm\\s+publish\\b|yarn\\s+publish\\b|pnpm\\s+publish\\b",
                action: "hold",
                reason: "Publishing to a registry is irreversible. Held by reins for approval.",
            }),
        ],
    },
];
function scanRepo(cwd, existing) {
    const root = (0, paths_1.resolveProjectDir)(cwd);
    const ctx = buildContext(root);
    const have = new Set(existing.map((r) => r.id));
    const detections = [];
    const newRules = [];
    const alreadyPresent = [];
    for (const d of DETECTORS) {
        let evidence = null;
        try {
            evidence = d.detect(ctx);
        }
        catch {
            continue; // a detector must never break the scan
        }
        if (!evidence)
            continue;
        detections.push({ id: d.id, evidence, rules: d.rules });
        for (const rule of d.rules) {
            if (have.has(rule.id))
                alreadyPresent.push(rule.id);
            else
                newRules.push(rule);
        }
    }
    return { root, detections, newRules, alreadyPresent };
}
