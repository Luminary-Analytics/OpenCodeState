# OpenCodeState

**Software state management for the AI-native era.**

OpenCodeState is an open-source, AI-native software state management standard designed around workspaces, sessions, checkpoints, intent, packages, provenance, validation, and semantic integration.

Traditional source control was designed around files, commits, branches, merges, remotes, and manual developer ceremony. OpenCodeState starts from a different premise:

> Developers create software. OpenCodeState manages software state.

## Why OpenCodeState?

Git changed software development by making distributed version control fast, reliable, and open. But software development has changed again.

Today, code is produced by humans, AI coding agents, refactoring tools, test generators, security scanners, migration tools, and automation systems. These contributors can produce changes faster than traditional source-control workflows can organize, explain, validate, and integrate them.

OpenCodeState is an attempt to rethink source control from first principles for this new world.

## North Star

> Source control should be invisible until human judgment is required.

OpenCodeState should automate the mechanical work of state capture, checkpointing, change grouping, validation, documentation, and integration while stopping only when judgment, risk, or ambiguity requires a human decision.

## Core Ideas

- Continuous checkpoints instead of manual save points
- Work sessions instead of branch-first workflows
- Intent-aware change grouping instead of manual staging
- Packages instead of plain commits
- Provenance for human, AI, and automated contributions
- Semantic integration instead of text-only merging
- Validation evidence attached to every package
- Git compatibility as a bridge, not the foundation

## OpenCodeState is not a Git client

OpenCodeState is a new source-control architecture designed for continuous, intent-aware, AI-native software development.

Git compatibility matters, but Git should be an adapter, not the core model.

## Early Project Status

This repository is starting as an architecture-first open-source effort.

Initial focus:

1. Define the standard.
2. Publish the core primitives and architecture RFCs.
3. Build a local prototype that supports sessions, checkpoints, packages, and Git export.
4. Expand into collaboration, semantic integration, AI provenance, and policy-driven workflows.

## Initial Developer Flow

```bash
ocs init
ocs start
# code normally
ocs finish
```

The goal is that `ocs finish` can analyze a work session, create safe checkpoints, group related changes, generate one or more packages, attach validation evidence, and prepare the work for review or integration.

## Repository Structure

```text
rfcs/       Proposed architecture and design decisions
specs/      Formal-ish protocol and object model drafts
examples/   Example sessions, packages, and workflows
reference/  Future reference implementation components
```

## License

OpenCodeState is licensed under the Apache License 2.0.
