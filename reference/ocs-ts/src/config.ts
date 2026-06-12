// Workspace configuration — the first real implementation of the Policy
// primitive (RFC 0002). Lives at .ocs/config.json (written with defaults by
// `ocs init`); policy decides what is interrupt-worthy at finish, it never
// decides what gets RECORDED — evidence is always captured.

import * as fs from "node:fs";

export interface PolicyConfig {
  interrupt_on_multiple_units: boolean;
  interrupt_on_low_confidence: boolean;
  interrupt_on_introduced_issues: boolean;
  interrupt_on_secrets: boolean;
  secret_scan: boolean;
  secret_allow_patterns: string[]; // regexes; matching lines are not flagged
}

export interface OcsConfig {
  provider: string; // "fallow" | "none" — OCS_PROVIDER env var overrides
  policy: PolicyConfig;
}

export const DEFAULT_CONFIG: OcsConfig = {
  provider: "fallow",
  policy: {
    interrupt_on_multiple_units: true,
    interrupt_on_low_confidence: true,
    interrupt_on_introduced_issues: true,
    interrupt_on_secrets: true,
    secret_scan: true,
    secret_allow_patterns: [],
  },
};

export function loadConfig(configPath: string): OcsConfig {
  if (!fs.existsSync(configPath)) return structuredClone(DEFAULT_CONFIG);
  let raw: Partial<OcsConfig> & { policy?: Partial<PolicyConfig> };
  try {
    raw = JSON.parse(fs.readFileSync(configPath, "utf8")) as typeof raw;
  } catch (e) {
    throw new Error(`invalid ${configPath}: ${(e as Error).message}`);
  }
  return {
    provider: raw.provider ?? DEFAULT_CONFIG.provider,
    policy: { ...DEFAULT_CONFIG.policy, ...(raw.policy ?? {}) },
  };
}
