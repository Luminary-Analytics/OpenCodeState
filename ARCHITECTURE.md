# Architecture Overview

A read-first map of how OpenCodeState fits together. For rationale see `rfcs/`;
for the object model see `specs/`. This document is the connective tissue between
them.

## The shape of the idea

OpenCodeState replaces Git's commit/branch ceremony with a continuous,
intent-aware pipeline: work is captured as cheap **checkpoints**, bounded into
**sessions**, grouped into **change units**, and emitted as validated
**packages** that a human reviews and exports to Git. The system stays silent
while work is clean and interrupts only when judgment is required.

It rests on two complementary halves:

- **OpenCodeState** is the *stateful timeline* — sessions, checkpoints, packages,
  provenance — of how a codebase came to be.
- A **codebase-intelligence provider** (`fallow` first) supplies *stateless,
  deterministic analysis* at decision moments.

> The provider sees the code. OpenCodeState remembers the work.

## Data flow

```
ocs init                      register an OCS workspace inside the repo
   │
ocs start                     open a session; record baseline tree + HEAD     [ocs-sessions]
   │
   ├─ checkpoint  (hook-fired: save / `ocs run` / agent / explicit)           [ocs-checkpoints]
   ├─ checkpoint  …            cheap, content-addressed, actor-tagged          [ocs-storage]
   │
ocs finish
   │  1. diff baseline → working tree  (+ checkpoint timeline)
   │  2. classify / normalize  (rename, trivial, generated, upstream-subtract) [RFC 0004]
   │  3. group into change units  (Tier-0 heuristics, with confidence)         [RFC 0004]
   │  4. provider: risk + validation evidence, change-scoped                    [RFC 0005]
   │  5. DECIDE:
   │       clean + high-confidence + nothing introduced → package silently
   │       else → interrupt: approve / edit / split / merge / reject
   │
   ├─ package(s)               immutable, content-addressed, with evidence      [ocs-packages]
   │
ocs export                     synthesize commits + branch (near-free)          [ocs-storage]
```

Every checkpoint, package, and validation datum carries **provenance** — which
actor (human, AI, tool) produced it, and for analysis, which provider and tree.

## Implementation shape (hybrid)

A Rust core plus a TypeScript surface, mirroring the shape of `fallow` itself
(a Rust core distributed through an npm/MCP surface):

- **Rust core** — `ocs-core`, `ocs-store` (gitoxide), `ocs-engine` (the grouping
  pipeline), `ocs-git`, `ocs-cli`. Systems work where Rust is strongest.
- **TypeScript surface** — MCP server, VS Code extension, and the `fallow`
  provider adapter. The agent/IDE/analysis ecosystem where TS is strongest; this
  surface is itself `fallow`-governed.

See [reference/](reference/) for the planned layout.

## Storage in one picture

OpenCodeState operates inside an existing Git repository, reusing its object
database for content, keeping its own refs out of the user's way, and tracking
metadata in SQLite:

```
.git/objects/…                content (reused — one object store)
refs/ocs/checkpoints/<ses>/*  checkpoint chains
refs/ocs/packages/*           package objects
.ocs/state.db                 sessions, change units, events, validation, provenance
```

Because content already lives in the object store, `ocs export` is effectively
instant. See [specs/ocs-storage.md](specs/ocs-storage.md).

## Where to go deeper

| Topic | Document |
|---|---|
| Why this exists | [MANIFESTO.md](MANIFESTO.md), [rfcs/0001](rfcs/0001-opencodestate-vision.md) |
| Vocabulary | [rfcs/0002](rfcs/0002-core-primitives.md), [specs/ocs-core.md](specs/ocs-core.md) |
| The MVP | [rfcs/0003](rfcs/0003-mvp.md) |
| Grouping | [rfcs/0004](rfcs/0004-change-grouping.md) |
| Providers / fallow | [rfcs/0005](rfcs/0005-codebase-intelligence-providers.md) |
| Object model | [specs/](specs/) — sessions, checkpoints, packages, storage, events |
| Concrete objects | [examples/](examples/) |

## Status

Design-stage; no code yet. The implementation begins with the daemonless vertical
slice in [RFC 0003](rfcs/0003-mvp.md).
