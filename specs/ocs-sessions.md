# OpenCodeState Sessions Specification

Status: Draft

## Purpose

A session represents a bounded period of software work.

Sessions are one of the primary differences between OpenCodeState and commit-first source control. A developer or agent should be able to start a session, work naturally, and finish the session without manually organizing low-level source-control mechanics.

## Session Fields

A session should include:

- Session ID
- Repository ID
- Workspace ID
- Actor ID
- Start time
- Finish time when completed
- Declared intent when available
- Inferred intent when available
- Associated events
- Associated checkpoints
- Changed paths
- Generated packages
- Validation records

## Session States

- active
- paused
- finished
- abandoned
- packaged

## Design Notes

Sessions should be recoverable, inspectable, and safe to finish multiple times. Finishing a session should not destroy work or remove checkpoint history.
