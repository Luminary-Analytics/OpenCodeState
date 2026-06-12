// Deterministic secret scanner over a session's ADDED lines. Offline, no
// dependencies. Secrets in added lines are introduced-by-definition, so an
// error-level finding is a judgment interrupt under default policy.
//
// REDACTION IS LOAD-BEARING: findings carry a redacted excerpt only. The raw
// match must never reach stdout, the plan, or .ocs/packages/*.json — evidence
// that republishes the leak is worse than no evidence.

export interface SecretFinding {
  path: string;
  line: number;
  rule: string;
  severity: "error" | "warn";
  redacted: string;
}

// High-precision token formats -> error (near-certain secrets).
const ERROR_PATTERNS: [string, RegExp][] = [
  ["aws-access-key-id", /\bAKIA[0-9A-Z]{16}\b/],
  ["github-token", /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b/],
  ["github-fine-grained-pat", /\bgithub_pat_[A-Za-z0-9_]{22,}\b/],
  ["slack-token", /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/],
  ["stripe-secret-key", /\bsk_live_[A-Za-z0-9]{24,}\b/],
  ["npm-token", /\bnpm_[A-Za-z0-9]{36}\b/],
  ["google-api-key", /\bAIza[0-9A-Za-z_-]{35}\b/],
  ["private-key", /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY(?: BLOCK)?-----/],
];

// Keyword = quoted-value assignments -> warn (possible secrets, lower precision).
const WARN_PATTERNS: [string, RegExp][] = [
  ["credential-assignment", /\b(?:api[_-]?key|apikey|secret|token|passwd|password)\b\s*[:=]\s*["'][^"']{12,}["']/i],
];

// Obvious non-secrets: docs examples, placeholders, templates.
const PLACEHOLDER = /example|placeholder|sample|dummy|your[_-]|x{4,}|test[_-]key|fake|redacted|<[^>]*>/i;

export function redactSecret(match: string): string {
  return `${match.slice(0, 4)}…[redacted ${match.length} chars]`;
}

export function scanAddedLines(
  path: string,
  lines: { line: number; text: string }[],
  allow: RegExp[],
): SecretFinding[] {
  const out: SecretFinding[] = [];
  for (const { line, text } of lines) {
    if (allow.some((re) => re.test(text))) continue;
    let errored = false;
    for (const [rule, re] of ERROR_PATTERNS) {
      const m = re.exec(text);
      if (!m || PLACEHOLDER.test(m[0])) continue;
      out.push({ path, line, rule, severity: "error", redacted: redactSecret(m[0]) });
      errored = true;
    }
    if (errored) continue; // an error finding subsumes warn-level noise on the same line
    for (const [rule, re] of WARN_PATTERNS) {
      const m = re.exec(text);
      if (!m || PLACEHOLDER.test(m[0])) continue;
      out.push({ path, line, rule, severity: "warn", redacted: redactSecret(m[0]) });
    }
  }
  return out;
}
