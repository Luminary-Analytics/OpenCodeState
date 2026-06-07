# OpenCodeState Storage Specification

Status: Draft

## Purpose

This document defines the storage model for the reference implementation. The
OpenCodeState standard is storage-agnostic; what follows is the pragmatic backend
used for the MVP.

## Model

OpenCodeState content is **content-addressed**: files are stored as blobs and
trees keyed by hash, so identical content is stored once and an unchanged file
costs nothing across checkpoints. The reference implementation uses
**gitoxide** (pure-Rust Git) as the content store. This reuses a battle-tested
object database and makes Git export nearly free, while the OpenCodeState object
model remains defined independently of Git.

## Layout

The MVP operates **inside an existing Git repository**:

```
.git/objects/…              content objects (reused; one object store)
refs/ocs/checkpoints/<ses>/* checkpoint chains (content-addressed trees)
refs/ocs/packages/*          package objects
.ocs/state.db                SQLite: sessions, change units, events, validation, provenance
.ocs/config                  validators, risk rules, policy, provider config
```

Consequences:

- A stray user `git` command cannot touch `refs/ocs/*`, and OpenCodeState
  checkpoints never appear on the user's branches.
- Because OpenCodeState refs reference the objects, Git garbage collection will
  not reclaim them.

## Object types

- Blob — file content
- Tree — a directory snapshot (the unit a checkpoint references)
- Checkpoint record — metadata referencing a tree (see [ocs-checkpoints](ocs-checkpoints.md))
- Package object — an immutable, content-addressed package (see [ocs-packages](ocs-packages.md))

Session, event, validation, and provenance metadata live in `.ocs/state.db`,
referencing object IDs.

## Git export and import

Because content objects already live in the repository's object database,
`ocs export` synthesizes ordinary commits and a branch from objects that are
already present — effectively instant. The default mapping is **one commit per
change unit**, preserving logical grouping, with the package summary embedded in
commit messages and the full package object stored in Git notes or under
`.ocs/packages/`. A unit that owns only part of a file is applied as a partial set
of hunks; commits are emitted in unit-dependency (topological) order, and a
dependency cycle between units means they cannot be cleanly separated and are
coalesced into one. Import (round-trip) is a later milestone.

## Future: standalone backend

Operating inside `.git` is an implementation convenience, not part of the
standard. A standalone object store (no `.git` present) is a future backend; the
object model above does not depend on Git.

## Compatibility rule

Git compatibility is important, but Git is treated as an adapter and a storage
backend, not as the core OpenCodeState model.
