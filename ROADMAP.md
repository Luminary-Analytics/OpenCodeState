# OpenCodeState Roadmap

OpenCodeState is beginning as an architecture-first open-source project. The goal is to define a new standard before prematurely locking into implementation details.

## Milestone 0: Define the Standard

Purpose: make the idea clear, concrete, and contributable.

Deliverables:

- Project README
- Manifesto
- Core primitive model
- MVP architecture RFC
- Draft specifications for sessions, checkpoints, packages, provenance, policy, storage, and sync
- Example session and package objects
- Initial implementation backlog

Success criteria:

- A contributor can understand what OpenCodeState is, why it exists, and how it differs from Git.
- The core vocabulary is clear enough to debate and improve.
- The MVP is scoped tightly enough to build.

### Milestone 0 status (2026-06-06)

Drafted: README, manifesto, core primitives (RFC 0002), MVP architecture
(RFC 0003), change-grouping design (RFC 0004), codebase-intelligence providers
(RFC 0005), and specs for sessions, checkpoints, packages, and storage. Example
session and package objects live in `examples/`; the planned implementation
layout is in `reference/`; `ARCHITECTURE.md` ties the design together. Still
open: provenance, policy, and sync specs, and the implementation backlog beyond
the RFC 0003 phases.

## Milestone 1: Local Prototype

Purpose: prove the core workflow locally.

Target developer flow:

```bash
ocs init
ocs start
# code normally
ocs finish
```

Initial capabilities:

- Initialize an OpenCodeState workspace
- Start and finish work sessions
- Record workspace events
- Create automatic checkpoints
- Detect changed files
- Generate basic change units
- Produce a package JSON document
- Restore to a checkpoint
- Export a package to Git

Success criteria:

- A developer can work normally and finish a session.
- OpenCodeState produces a structured package describing what changed.
- The package can be reviewed by a human and exported to Git.

### Milestone 1 status (2026-06-12)

A TypeScript reference implementation lives in `reference/ocs-ts/` and covers
this milestone end to end: sessions, hook-fired actor-tagged checkpoints,
non-destructive restore, Tier-0 change grouping, packages carrying
validation/risk/attribution evidence (via the `fallow` provider), a judgment
interrupt at finish, human-vs-AI provenance, configurable policy with a
built-in secret scan, Git export (one commit per change unit), and an MCP
server so agents drive sessions natively. This repository self-hosts on it —
this very status update was packaged and exported by `ocs finish`. Still open
before M1 is closed: the continuous watcher variant of capture (capture is
hook-driven today) and richer interrupt actions at the finish prompt.

## Milestone 2: AI-Assisted Packaging

Purpose: make `ocs finish` feel materially better than manual source control.

Capabilities:

- Infer intent from diffs, filenames, tests, and ticket context
- Split unrelated work into separate change units
- Generate package summaries
- Suggest tests and validations
- Detect risky changes
- Highlight possible secrets or unsafe files
- Summarize human and AI contributions

Success criteria:

- OpenCodeState can turn a messy day of work into clean, explainable packages.
- The developer only needs to approve, edit, or reject the generated package plan.

## Milestone 3: Collaboration Server

Purpose: allow teams to share packages and integrate work.

Capabilities:

- Package registry
- Team workspaces
- Review workflow
- Integration previews
- Release lines
- Policy checks
- GitHub/GitLab/Azure DevOps adapters

Success criteria:

- Multiple developers can publish and review packages.
- The server can identify integration risk before merge time.

## Milestone 4: AI-Native Provenance

Purpose: make human, AI, and automated contributions explicit and auditable.

Capabilities:

- Actor model for humans, AI agents, scripts, and tools
- Prompt/action provenance
- Accepted/rejected AI changes
- Signed packages
- Policy enforcement for AI-generated code
- Audit history

Success criteria:

- Teams can understand who or what produced each change.
- AI-generated work can be governed without blocking innovation.

## Milestone 5: Semantic Integration

Purpose: move beyond line-based merging.

Capabilities:

- Language-aware change analysis
- AST-aware conflict detection
- Dependency graph analysis
- API contract awareness
- Database migration ordering
- Test-informed merge confidence
- Conservative automatic integration

Success criteria:

- OpenCodeState can distinguish safe merges from risky semantic conflicts.
- Humans are interrupted only when judgment is required.

## Implementation Bias

The first reference implementation is expected to use:

- Rust for CLI/daemon/storage-sensitive components
- SQLite for local metadata during prototyping
- JSON for initial object formats
- A pluggable AI provider model
- Git export/import as an adapter
- VS Code extension as the first IDE integration

These choices are not part of the permanent standard. They are practical defaults for early development.
