import * as fs from "node:fs";
import { configPath } from "./paths";

export interface ReinsConfig {
  /** Same tool+input repeated >= this many times triggers the loop alarm. */
  loopThreshold: number;
  /** How a hold rule stops a call (see src/defer.ts).
   *  "auto"  — defer where Claude Code honors it, deny everywhere else.
   *  "deny"  — always deny-and-queue; the transport that works everywhere.
   *  "defer" — always defer, skipping the environment check. */
  holdTransport: "auto" | "defer" | "deny";
}

const DEFAULTS: ReinsConfig = {
  loopThreshold: 3,
  holdTransport: "auto",
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
