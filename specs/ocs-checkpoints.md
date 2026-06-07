# OpenCodeState Checkpoints Specification

Status: Draft

## Purpose

A checkpoint is an automatic restore point. Unlike a Git commit, it does not
require the developer to decide that work is clean, meaningful, or ready for
history. Checkpoints exist to protect work continuously and to enable recovery,
and they form the timeline that grouping and provenance build on.

## A checkpoint is a hook-fired event

In the MVP there is no always-on daemon. A checkpoint is a cheap,
content-addressed, actor-tagged event fired by activity that already happens:

- explicit `ocs checkpoint`
- a wrapped command, `ocs run <cmd>` (e.g. a test run)
- an editor save (VS Code extension)
- an agent edit (`ocs checkpoint --actor ai:<name>` from a Claude Code hook)

This produces a timeline, per-checkpoint provenance, and a temporal grouping
signal without a watcher. A continuous watcher (later milestone) simply fires the
same checkpoint path automatically.

## Checkpoint fields

A checkpoint should include:

- Checkpoint ID
- Session ID
- Parent checkpoint ID (checkpoints form a chain within a session)
- Timestamp
- Trigger (explicit, command, save, agent, …)
- Actor ID (human by default; an agent when fired by an agent hook)
- Tree reference (the content-addressed snapshot)
- Changed paths since the parent

## Storage and restore

Checkpoints are stored as content-addressed trees referenced under
`refs/ocs/checkpoints/<session>/*` so ordinary Git operations never disturb them
and garbage collection never reclaims them (see [ocs-storage](ocs-storage.md)).
Because storage is content-addressed, an unchanged file costs nothing across
checkpoints.

`ocs restore <checkpoint>` materializes a checkpoint's tree into the working
directory. Restore is itself safe: the current state is checkpointed before being
replaced, so a restore is never destructive.

## Design notes

- Checkpoints are append-oriented; recovery never requires rewriting history.
- Finishing a session must not destroy checkpoints; checkpoint history survives
  packaging.
- Provider analysis (risk/validation) is deliberately *not* run on the checkpoint
  hot path; it runs at `ocs finish`.
