# OpenCodeState Packages Specification

Status: Draft

## Purpose

A package is the reviewable, shareable, validated unit of work — the proposed
successor to the commit/pull-request hybrid. It is what teams review, approve,
integrate, and release. This document defines the package object and its parts.

A worked example lives at [examples/example-package.json](../examples/example-package.json).

## Package object

A package should include:

- Package ID (content-addressed)
- Session ID and Repository ID
- Created-at timestamp
- Intent (declared and/or inferred summary)
- One or more change units
- Content changes (path, status, before/after object IDs)
- Provenance records
- Validation records
- Risk signals
- Attribution (introduced vs. inherited; see below)
- Policy status
- Integration status
- Review notes
- Rollback strategy (e.g. restore to a checkpoint)

## Change Unit

A change unit is a logical group of related changes (see
[RFC 0004](../rfcs/0004-change-grouping.md)). It should include:

- Change Unit ID
- Title and intent
- Member paths
- Grouping `confidence`
- `kind` (`feature`, `fix`, `reformat`, `reorg`, `deps`, `generated`, …)
- `depends_on` (other units it derives from, e.g. a lockfile unit depending on a dependency-bump unit)
- Risk signals scoped to the unit

## Provenance record

Provenance records who or what produced a change. Provenance is **per-record**,
and a single change unit may aggregate multiple actors (e.g. an AI-generated,
human-edited module). Grouping (logical) and provenance (authorship) are
orthogonal axes and must not drive each other. A record should include:

- Actor (e.g. `human:rich`, `ai:claude-code`, `tool:rustfmt`, `ci:pipeline`)
- Contribution type (`edit`, `generated`, `refactor`, `review`, …)
- Optional prompt/transcript reference (opt-in; provenance is not surveillance)
- Accepted/rejected status for proposed AI changes

## Validation record

Validation is evidence attached to work, expressed as **SARIF** where possible
(see [RFC 0005](../rfcs/0005-codebase-intelligence-providers.md)). A record
should include:

- Type (tests, lint, dead-code, duplication, complexity, secret-scan, security, human-review, …)
- Status / severity (`error`, `warn`, `off`/`note`)
- Locations (path + region)
- Evidence reference
- Analysis provenance (which provider + version produced it, and the analyzed tree OID)

## Risk signal and attribution

Risk signals annotate change units (`pr-risk`, `complexity`, `security`,
`churn`, …) with a severity and rationale. Crucially, packages carry
**attribution** distinguishing issues the work *introduced* from those it
*inherited*, so review and policy can focus on what this work made worse rather
than on pre-existing debt.

## Immutability

Packages are **immutable and content-addressed**. Review, integration, and
release state are tracked as events that *reference* a package (append-oriented,
consistent with [ocs-events](ocs-events.md)), never as mutations of it. Editing a
package produces a new package.

## Design notes

- A package must be reviewable by a human and exportable to Git.
- Every datum that comes from analysis carries its provider provenance, so a
  reviewer can tell human-sourced evidence from tool-sourced evidence.
- A package should always declare a rollback strategy; in the MVP this is a
  reference to a checkpoint (see [ocs-checkpoints](ocs-checkpoints.md)).
