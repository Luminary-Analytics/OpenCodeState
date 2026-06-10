// Codebase-intelligence provider seam (RFC 0005). The engine depends only on
// this interface and never names a specific tool; adapters (fallow.ts) plug in
// behind it. Absence is a normal state, not an error: with no provider the
// package simply carries no analysis evidence and `ocs finish` still works.

export interface AnalysisProvenance {
  provider_id: string;
  provider_version: string;
  analyzed_oid: string; // tree analyzed (the finish tree)
  scope: string; // e.g. "changed-since:<sha>"
  timestamp: string;
}

export interface SarifResultSummary {
  rule_id: string;
  level: string; // SARIF: error | warning | note
  path: string | null;
  line: number | null;
  message: string;
}

export interface ValidationRecord {
  type: string; // "audit"
  format: string; // "sarif" | "json"
  status: "passed" | "issues" | "error" | "skipped";
  rule_counts: Record<string, number>;
  results: SarifResultSummary[];
  provenance: AnalysisProvenance;
}

export type Severity = "note" | "warn" | "error";

export interface RiskSignal {
  kind: string; // dead-code | complexity | duplication | inherited-debt | ...
  severity: Severity;
  target: string | null; // path, or null = whole package
  rationale: string;
  introduced: boolean | null; // true = this session caused it
}

// Introduced-vs-inherited attribution: the package-native form of the finish
// rule "interrupt only on what this work made worse, not pre-existing debt".
export interface Attribution {
  gate: string;
  dead_code_introduced: number;
  dead_code_inherited: number;
  complexity_introduced: number;
  complexity_inherited: number;
  duplication_introduced: number;
  duplication_inherited: number;
}

export interface ProviderResult {
  verdict: "pass" | "fail" | null;
  validation: ValidationRecord[];
  risk_signals: RiskSignal[];
  attribution: Attribution | null;
  notes: string[];
}

export interface CodebaseIntelligenceProvider {
  id: string;
  // Cheap language gate: does this provider have anything to say about these paths?
  appliesTo(changedPaths: string[]): boolean;
  // Runs at `ocs finish` only — never on the checkpoint hot path.
  analyze(opts: { repoRoot: string; baselineRef: string; analyzedOid: string }): ProviderResult;
}
