import * as fs from "node:fs";
import { configPath } from "./paths";

export interface ReinsConfig {
  /** Same tool+input repeated >= this many times triggers the loop alarm. */
  loopThreshold: number;
  /** How a hold rule stops a call (see src/defer.ts).
   *  "deny"  — always deny-and-queue; the transport that works everywhere.
   *            The default, because it is the only one that always holds.
   *  "auto"  — defer when print mode is confirmed, deny otherwise. Opt-in:
   *            Claude Code still ignores defer for a call made in parallel
   *            with others, and then the held action runs (reported
   *            afterwards as a HOLD BREACH).
   *  "defer" — always defer, skipping the environment check. */
  holdTransport: "auto" | "defer" | "deny";
  /** Say at Stop when a turn's edits were left failing, untested or unverified
   *  (see src/claim.ts). False silences that line; the cockpit, lastrun and
   *  the report still show the verdict. */
  claimCheck: boolean;
}

const DEFAULTS: ReinsConfig = {
  loopThreshold: 3,
  holdTransport: "deny",
  claimCheck: true,
};

export function loadConfig(payloadCwd?: string): ReinsConfig {
  try {
    const raw = fs.readFileSync(configPath(payloadCwd), "utf8");
    const parsed = JSON.parse(raw);
    return { ...DEFAULTS, ...parsed };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveConfig(config: ReinsConfig, payloadCwd?: string): void {
  fs.writeFileSync(configPath(payloadCwd), JSON.stringify(config, null, 2) + "\n");
}

export { DEFAULTS as DEFAULT_CONFIG };
