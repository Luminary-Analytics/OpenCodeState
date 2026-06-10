// fallow adapter for the CodebaseIntelligenceProvider seam (RFC 0005).
//
// Verified contract (fallow 2.89, probed empirically):
// - `fallow audit --changed-since <ref>` analyzes the WORKING TREE scoped to
//   files changed since <ref> — uncommitted session work is seen, and a raw
//   commit sha (our session baseline commit) is a valid ref.
// - JSON gives verdict + attribution (introduced vs inherited, gate new-only).
// - SARIF needs a second run with --format sarif (--sarif-file is ignored by
//   audit); fallow's incremental cache makes the rerun cheap.
// - Exit 0 = clean, 1 = issues found (a result, not a failure) with intact
//   stdout, 2 = tool error (structured {"error":true,...} JSON on stdout).

import { execFileSync } from "node:child_process";

import type {
  Attribution,
  CodebaseIntelligenceProvider,
  ProviderResult,
  RiskSignal,
  SarifResultSummary,
  ValidationRecord,
} from "./provider.ts";

const TSJS = /\.[cm]?[jt]sx?$/;

function runFallow(args: string[], cwd: string): { code: number; stdout: string } {
  try {
    const stdout = execFileSync("npx", ["--yes", "fallow", ...args], {
      cwd,
      encoding: "utf8",
      maxBuffer: 1024 * 1024 * 64,
      timeout: 180_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, stdout };
  } catch (e) {
    const err = e as { status?: number | null; stdout?: string | Buffer };
    return { code: err.status ?? 2, stdout: err.stdout?.toString() ?? "" };
  }
}

interface FallowAudit {
  version?: string;
  verdict?: "pass" | "fail";
  attribution?: Attribution;
  summary?: { max_cyclomatic?: number };
  error?: boolean;
  message?: string;
}

function parseSarif(stdout: string): SarifResultSummary[] {
  const doc = JSON.parse(stdout) as {
    runs?: { results?: unknown[] }[];
  };
  const raw = (doc.runs?.[0]?.results ?? []) as {
    ruleId?: string;
    level?: string;
    message?: { text?: string };
    locations?: { physicalLocation?: { artifactLocation?: { uri?: string }; region?: { startLine?: number } } }[];
  }[];
  return raw.map((r) => ({
    rule_id: r.ruleId ?? "unknown",
    level: r.level ?? "warning",
    path: r.locations?.[0]?.physicalLocation?.artifactLocation?.uri ?? null,
    line: r.locations?.[0]?.physicalLocation?.region?.startLine ?? null,
    message: r.message?.text ?? "",
  }));
}

export const fallowProvider: CodebaseIntelligenceProvider = {
  id: "fallow",

  appliesTo: (changedPaths) => changedPaths.some((p) => TSJS.test(p)),

  analyze({ repoRoot, baselineRef, analyzedOid }) {
    const notes: string[] = [];
    const scope = `changed-since:${baselineRef}`;
    const provenance = (version: string) => ({
      provider_id: "fallow",
      provider_version: version,
      analyzed_oid: analyzedOid,
      scope,
      timestamp: new Date().toISOString(),
    });
    const errorResult = (msg: string): ProviderResult => ({
      verdict: null,
      validation: [
        {
          type: "audit",
          format: "json",
          status: "error",
          rule_counts: {},
          results: [],
          provenance: provenance("unknown"),
        },
      ],
      risk_signals: [],
      attribution: null,
      notes: [`fallow analysis failed: ${msg}`],
    });

    const j = runFallow(["audit", "--changed-since", baselineRef, "--format", "json", "--quiet"], repoRoot);
    if (!j.stdout) return errorResult(`no output (exit ${j.code})`);
    let audit: FallowAudit;
    try {
      audit = JSON.parse(j.stdout) as FallowAudit;
    } catch {
      return errorResult(`unparseable output (exit ${j.code})`);
    }
    if (audit.error) return errorResult(audit.message ?? "unknown error");
    const version = audit.version ?? "unknown";

    const s = runFallow(["audit", "--changed-since", baselineRef, "--format", "sarif", "--quiet"], repoRoot);
    let results: SarifResultSummary[] = [];
    if (s.stdout) {
      try {
        results = parseSarif(s.stdout);
      } catch {
        notes.push("fallow SARIF output was unparseable — validation carries counts only");
      }
    }
    const rule_counts: Record<string, number> = {};
    for (const r of results) rule_counts[r.rule_id] = (rule_counts[r.rule_id] ?? 0) + 1;

    const validation: ValidationRecord[] = [
      {
        type: "audit",
        format: "sarif",
        status: results.length || audit.verdict === "fail" ? "issues" : "passed",
        rule_counts,
        results,
        provenance: provenance(version),
      },
    ];

    const a = audit.attribution ?? null;
    const risk_signals: RiskSignal[] = [];
    if (a) {
      if (a.dead_code_introduced > 0)
        risk_signals.push({
          kind: "dead-code",
          severity: "error",
          target: null,
          rationale: `${a.dead_code_introduced} dead-code issue(s) introduced by this session`,
          introduced: true,
        });
      if (a.complexity_introduced > 0)
        risk_signals.push({
          kind: "complexity",
          severity: "warn",
          target: null,
          rationale: `${a.complexity_introduced} complexity finding(s) introduced by this session`,
          introduced: true,
        });
      if (a.duplication_introduced > 0)
        risk_signals.push({
          kind: "duplication",
          severity: "warn",
          target: null,
          rationale: `${a.duplication_introduced} duplication group(s) introduced by this session`,
          introduced: true,
        });
      const inherited = a.dead_code_inherited + a.complexity_inherited + a.duplication_inherited;
      if (inherited > 0)
        risk_signals.push({
          kind: "inherited-debt",
          severity: "note",
          target: null,
          rationale: `${inherited} pre-existing issue(s) in touched files (not this session's work)`,
          introduced: false,
        });
    }

    return { verdict: audit.verdict ?? null, validation, risk_signals, attribution: a, notes };
  },
};
