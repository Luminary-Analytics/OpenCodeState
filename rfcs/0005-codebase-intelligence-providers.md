# RFC 0005: Codebase Intelligence Providers

Status: Draft

## Summary

OpenCodeState needs codebase intelligence — risk signals, dependency/architecture
structure, and quality/cleanup evidence — to populate a package's validation and
risk sections and to feed the grouping pipeline. Rather than reinvent this,
OpenCodeState defines a language-agnostic **`CodebaseIntelligenceProvider`**
interface and consumes existing analyzers behind it.

`fallow` (deterministic codebase intelligence for TypeScript/JavaScript) is the
first provider. The interface is designed so other languages' tools can implement
the same contract later, and so any tool that emits SARIF plugs into the
validation channel for free.

## The relationship: stateless analysis vs. stateful timeline

Providers and OpenCodeState do not overlap; they are complementary:

- A provider performs **stateless, deterministic analysis** of a working tree at
  one instant. It has no memory.
- OpenCodeState is the **stateful timeline** — sessions, checkpoints, packages,
  provenance — of how that tree came to be. It has no analysis of its own.

> The provider sees the code. OpenCodeState remembers the work.

OpenCodeState calls a provider at decision moments (primarily `ocs finish`) and
pins its verdict into the timeline, so every package carries a point-in-time,
attributed read of risk and quality.

## Hybrid language architecture

Because the premier provider (`fallow`) analyzes TypeScript/JavaScript, and
because the agent/IDE ecosystem (MCP, LSP, VS Code) is TS/JS-native, the
reference implementation is hybrid (see [RFC 0003](0003-mvp.md)): a Rust core
plus a `fallow`-governed TypeScript surface. A provider only helps for the
languages it supports, so it is modeled as a **pluggable provider** — premier for
some languages, absent for others — never a universal engine. For languages with
no provider, grouping degrades to the structural signals in
[RFC 0004](0004-change-grouping.md) and packages simply carry no provider-sourced
evidence.

## The interface

The Rust core depends only on this trait; it never names a specific provider.

```rust
trait CodebaseIntelligenceProvider {
    fn describe(&self) -> ProviderInfo;                       // capability discovery

    fn dependency_graph(&self, scope: Scope) -> Result<Option<Analysis<DependencyGraph>>>;
    fn architecture(&self,     scope: Scope) -> Result<Option<Analysis<Architecture>>>;
    fn risk(&self, scope: Scope, changes: &ChangeSet) -> Result<Analysis<Vec<RiskSignal>>>;
    fn findings(&self, scope: Scope, kinds: &[FindingKind]) -> Result<Analysis<Sarif>>;
}

enum Scope { Repo, ChangedSince(GitRef), Paths(Vec<PathBuf>) }

struct Analysis<T> { data: T, provenance: AnalysisProvenance }  // provider id+version, analyzed tree OID, scope, timestamp
```

Every result is wrapped in `Analysis<T>` so a package can prove the origin of
each datum (e.g. "this risk came from `fallow@2.89` on tree `abc123`"), keyed by
the analyzed tree OID for caching and reproducibility.

## SARIF as the native validation format

Findings flow as **SARIF**. SARIF is an open standard for static-analysis
results, so adopting it as OpenCodeState's validation-record format costs nothing
when the provider already emits it and turns the validation channel into an open
ecosystem (any SARIF-emitting tool becomes a provider). Only data SARIF cannot
model — dependency graphs, module boundaries — uses provider-structured JSON.

## The fallow adapter (verified)

Mapping confirmed by spike against `fallow@2.89.0`:

| Method | `fallow` invocation | Notes |
|---|---|---|
| `findings()` | `audit --changed-since <base> --format sarif` (+ `--diff-stdin` per unit) | combined dead-code + complexity + duplication, change-scoped; SARIF rule ids `fallow/<issue>` |
| `risk()` | `audit … --format json` | uses `verdict` + `attribution.*_introduced` + `max_cyclomatic`; `health` for per-function complexity |
| `dependency_graph()` | `dead-code --format json` | **cycles + boundary violations only** — no raw edge list; fine import edges are computed in-engine |
| `architecture()` | `dead-code` boundaries + `--group-by directory` | coarse module prior + comparison oracle |
| `describe()` | `schema` + `--version` | 13 dead-code rules, dupes, health; languages ts/js; scoped + incremental |

Key facts that shape the integration:

- **`audit` is the finish-time call.** Its JSON returns a `verdict` and an
  **`attribution`** block separating issues the change *introduced* from those it
  *inherited* (gate `new-only`). This maps directly to the finish rule: interrupt
  only when the session **introduced** error-level issues; stay silent on
  inherited debt.
- **`--diff-stdin`** scopes findings to exact changed lines, enabling
  **per-change-unit** attribution — not just per-session. It scopes *attribution*,
  not correctness: it filters findings on the real tree and does not evaluate a
  counterfactual "only this unit applied" tree, so it cannot by itself verify that
  a sub-file split is self-consistent. Verifying a split requires materializing
  the unit's tree and type-checking it (`fallow` is not a type checker); see
  [RFC 0004](0004-change-grouping.md).
- **`--save-baseline` / `--fail-on-regression --tolerance`** provide a native
  regression gate.
- Exit codes: `0` clean, `1` issues found (normal — not a tool failure), `2`
  tool error. Incremental caching is on by default.

## Caching, scope, and the hot path

Checkpoints never call a provider (the analysis cost must not be on the
hot path). At `ocs finish`, the engine runs the provider scoped to the session
baseline (`ChangedSince(baseline)` → `--changed-since`) and caches each
`Analysis<T>` by analyzed tree OID. Re-finishing unchanged content is free.

## The comparison oracle

"Compared with the provider" is realized as a calibration harness (CI, not the
live path): it runs OpenCodeState's own grouping/risk against the provider's
`architecture()` / `risk()` on the same repo and scores agreement (do change-unit
boundaries respect module boundaries? does OCS risk match provider risk?). This
doubles as the grouping test suite.

## Hooks

`ocs finish` runs the provider's change audit, so OpenCodeState **subsumes** a
provider's standalone git-commit gate — both must not install competing git
hooks. A provider's agent hook (e.g. `fallow`'s Claude Code PreToolUse hook) is
the proven pattern OpenCodeState mirrors to fire `ocs checkpoint --actor
ai:<name>` on agent edits.

## Open questions

- Should the provider interface expose a streaming/LSP mode, or remain batch-CLI for the MVP?
- Should OpenCodeState ship a thin in-engine import-edge extractor per language, or require providers to supply edges?
- How are multiple providers (e.g. per-language) merged for a polyglot repository?
