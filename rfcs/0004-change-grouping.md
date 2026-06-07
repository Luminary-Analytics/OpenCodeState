# RFC 0004: Change Grouping

Status: Draft

## Summary

Automatic grouping of a session's changes into logical **change units** is one of
the two things the MVP must do excellently (the other is the checkpoint safety
net; see [RFC 0003](0003-mvp.md)). This RFC defines the Tier-0 grouping model:
deterministic, offline, no AI.

A grouping that is *confidently wrong* is worse than no grouping. So the design
goal is not maximal cleverness — it is to produce trustworthy units when signals
are strong, and to **degrade safely to "one package, you sort it"** when they are
not.

## Problem

A developer (or agent) does several unrelated things in one session. The system
must split that into units a human would recognize — "auth fix", "logging
cleanup", "dependency bump" — without manual hunk staging, and without an AI in
the loop for the MVP (local-first; must work offline).

## Pipeline

```
1. INGEST    changed files + diffs + git history + checkpoint timeline
2. CLASSIFY & NORMALIZE  (deterministic pre-pass)
     - rename / move detection (gitoxide)        -> collapse moves
     - trivial-change detection (whitespace / import-order / comment-only)
     - generated / vendored / lockfile detection -> mark "dependent"
     - subtract upstream/merge changes           -> only THIS session's work
3. SIGNALS   per file-pair edge weights (see below)
4. CLUSTER   weighted graph + community detection, with:
     - cross-cutting override (diff-similarity collapses path-based splits)
     - dependent files attach to their cause
     - bias toward FEWER units when signals conflict
5. SCORE     calibrated confidence per partition
6. EMIT      units + confidence -> finish flow (auto if high + clean, else ask)
```

The **classify/normalize pre-pass** is structural: most apparent grouping
failures are really *input* problems (a rename that looks like 100 edits, a
formatter touching 200 files, a lockfile churned by a dependency bump). Cleaning
the input before clustering resolves them deterministically.

## The five signals

| Signal | Source | Notes |
|---|---|---|
| Path proximity | shared directory / module prefixes | over-merges co-located unrelated work; over-splits cross-cutting work |
| Historical co-change | gitoxide history | strong, but absent for new / agent-generated files |
| Temporal proximity | checkpoint timeline | strong for human pacing; collapses in fast agent bursts |
| Import / dependency edges | in-engine parse (tree-sitter); coarse module/cycle hints from the provider | see [RFC 0005](0005-codebase-intelligence-providers.md) |
| Diff-similarity | identical / near-identical hunk shape across files | **overrides** path to keep cross-cutting renames as one unit |

Two signals (co-change, temporal) are weakest exactly in greenfield and
agent-authored work — which is OpenCodeState's core use case. The
**structural** signals (path, import-edges, diff-similarity) are regime-robust,
so Tier-0 leans on them.

## Adversarial analysis

The grouper was red-teamed against pathological change sets. Verdict key:
✅ survives · ⚠️ degrades safely · ❌ breaks without the listed mitigation.

| Case | Failure mode | Verdict | Mitigation |
|---|---|---|---|
| Cross-cutting rename across many files | path + co-change both say "split" (inverted) | ❌→✅ | diff-similarity signal |
| Two tasks interleaved in one file | file granularity can't separate | ❌ | **hard floor** — needs Tier-1 / hunk granularity |
| Mass reformat + one real fix | needle in 200-file haystack | ⚠️→✅ | trivial-change classifier |
| Generated / lockfile churn | spurious standalone unit | ⚠️→✅ | dependent-file attach |
| Mass file move | looks like N deletes + N adds | ❌→✅ | rename detection |
| Agent burst (many new files, instant) | temporal + co-change both absent | ⚠️/❌ | structural signals only; Tier-1 sooner |
| Co-located unrelated features | path over-merges | ⚠️ | under-splits (safe); human splits |
| Pull / merge mid-session | attributes others' code to you | ❌→✅ | upstream subtraction in pre-pass |
| No-checkpoint session | zero temporal signal | ⚠️ | degrade to structural signals; temporal is a bonus |

## File-granularity floor

The MVP groups at **file** granularity. Two distinct tasks interleaved in one
file cannot be separated this way; clean separation requires hunk-level grouping,
which in turn benefits from intent-reading (Tier-1). This is a documented
limit, not a tuning problem: the demo splits cleanly only when distinct tasks
touch distinct files.

## Confidence and fallback

The clusterer emits calibrated confidence. **Low grouping confidence is itself a
judgment-interrupt trigger**: rather than guess, `ocs finish` falls back to a
single package and asks the human. Uncertainty is a reason to interrupt, which is
consistent with the north star.

## Tier-0 vs Tier-1 boundary

- **Tier-0 (MVP):** the deterministic pipeline above. Always available, offline.
- **Tier-1 (later):** an AI layer that *refines* Tier-0 — reads diffs to split
  interleaved sub-file work, names units, and handles agent bursts where
  structural signals alone under-perform. Tier-1 never replaces Tier-0; it
  re-ranks and subdivides its output, so the system always degrades gracefully
  to the heuristic spine.

## Hunk-level splitting and verification (Tier-1)

Tier-1 may subdivide a file's changes into separate units at **hunk**
granularity. A change unit's membership is therefore a set of hunks (path + line
ranges); whole-file membership is the common Tier-0 case.

Sub-file splitting is only safe under conditions established empirically:

- **L0 — coupling precondition (cheap, deterministic):** hunks that share a
  defined or mutated symbol, or that have data flow between them, are not split.
  This alone catches the common cross-cutting rename (both sides reference the
  same symbol) and most obvious entanglement, before any build runs.
- **Verification of the survivors:** a proposed sub-file split is trusted only if
  each unit is **materialized as its own tree and analyzed** — type-checked
  (e.g. `tsc`), then tested where mapped tests exist. A provider's line-scoping
  flag (`fallow --diff-stdin`) scopes *attribution*, not correctness, and cannot
  verify a split; see [RFC 0005](0005-codebase-intelligence-providers.md).

If a split cannot be verified — no type checker, no covering tests, or the units
form a dependency cycle — the conservative rule applies: **do not sub-split; keep
the file whole.** Sub-file splitting is thus opt-in, verified, and always
reversible to the file-granularity floor. Export order follows unit dependencies
(see [ocs-storage](../specs/ocs-storage.md)).

Residual risk: hunks that compile apart but are behaviorally coupled (ordering,
units, shared state) with no covering test are caught only by human review — the
judgment gate remains load-bearing for that residue.

## Open questions

- What is the right default community-detection threshold, and how is confidence calibrated?
- Should `depends_on` (lockfile → dependency bump) be modeled as an edge or as a unit relation?
- When does an agent-authored session warrant Tier-1 even in an otherwise Tier-0 build?
