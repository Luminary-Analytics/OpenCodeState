# RFC 0002: Core Primitives

Status: Draft

## Summary

OpenCodeState replaces Git-era branch/commit-first thinking with a model based on software work, state, intent, provenance, validation, and integration.

This RFC defines the initial vocabulary.

## Primitive Overview

| Primitive | Meaning |
|---|---|
| Repository | The complete codebase and its OpenCodeState history |
| Workspace | A developer or agent's active working environment |
| Session | A bounded period of work with context and activity |
| Checkpoint | An automatic restore point |
| Intent | What the work is trying to accomplish |
| Change Unit | A logical group of related changes |
| Package | A reviewable, shareable, validated unit of work |
| Provenance | Who or what produced a change |
| Validation | Evidence that a change is safe or unsafe |
| Integration | The process of safely combining packages |
| Release Line | A deployable stream of product state |
| Policy | Rules that govern package, integration, and release behavior |

## Repository

A repository is the complete OpenCodeState-managed codebase and its state history.

It includes:

- Content objects
- Event history
- Workspace metadata
- Sessions
- Checkpoints
- Packages
- Provenance records
- Validation records
- Policy configuration
- Sync metadata

A repository may be backed by OpenCodeState-native storage, Git, or another adapter during transition.

## Workspace

A workspace is a developer or agent's active working environment.

A workspace may be local, remote, ephemeral, or automated.

Examples:

- Rich's laptop checkout
- A cloud development environment
- A CI agent workspace
- An AI coding agent sandbox
- A migration generation tool workspace

## Session

A session is a bounded period of work.

A session answers:

- Who or what worked?
- When did work happen?
- What files and objects changed?
- What context was attached?
- What checkpoints exist?
- What intent was inferred or declared?
- What package resulted?

Sessions are the primary human-facing work primitive.

## Checkpoint

A checkpoint is an automatic restore point.

Unlike Git commits, checkpoints do not require the developer to decide that work is clean, meaningful, or ready for history.

A checkpoint exists to protect work and enable recovery.

## Intent

Intent describes what the work is trying to accomplish.

Intent may be:

- Declared by a human
- Inferred from tickets, files, tests, prompts, or diffs
- Proposed by an AI system
- Updated during package review

Intent is not required to be perfect. It is a living explanation attached to a session or package.

## Change Unit

A change unit is a logical group of related changes.

Examples:

- Auth bug fix
- Logging cleanup
- Database migration
- Unit test addition
- Dependency upgrade
- Documentation update

Change units are used to split messy work into understandable parts.

## Package

A package is the proposed successor to the commit/pull-request hybrid.

A package contains:

- One or more change units
- Intent summary
- File/content changes
- Provenance
- Validation evidence
- Risk signals
- Policy status
- Integration status
- Review notes
- Rollback strategy

A package is what teams review, approve, integrate, and release.

## Provenance

Provenance records who or what produced a change.

Actors may include:

- Human developers
- AI coding agents
- IDE assistants
- Refactoring tools
- Test generators
- Scripts
- CI/CD systems

OpenCodeState should represent human and AI contributions clearly without turning provenance into surveillance.

## Validation

Validation is evidence attached to work.

Examples:

- Unit tests passed
- Integration tests failed
- Lint passed
- Secret scan passed
- Security scan found issues
- Migration safety check failed
- Human review approved

Validation should be package-native.

## Integration

Integration is the process of combining packages into another state.

Integration should be:

- Semantic when possible
- Conservative when uncertain
- Policy-aware
- Test-informed
- Human-reviewed when needed

## Release Line

A release line is a deployable stream of product state.

It is similar to a branch in some ways, but the abstraction should be higher level and product-oriented.

Examples:

- production
- staging
- v2-maintenance
- customer-specific-release

## Policy

Policy defines rules around packaging, validation, integration, and release.

Examples:

- Block packages with secrets
- Require tests for high-risk paths
- Require human review for payment code
- Require AI provenance disclosure
- Require migration approval

## Open Questions

- Should packages be immutable after creation?
- Should sessions be manually named or primarily inferred?
- How much provenance should be required by default?
- Should release lines map one-to-one with Git branches in compatibility mode?
