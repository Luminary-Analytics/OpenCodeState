# OpenCodeState Events Specification

Status: Draft

## Purpose

Events describe meaningful activity inside an OpenCodeState repository or workspace.

OpenCodeState should maintain an event history so sessions, checkpoints, packages, validation, provenance, and integrations can be reconstructed and explained.

## Event Shape

An event should include:

- Event ID
- Event type
- Timestamp
- Actor ID
- Workspace ID
- Session ID when available
- Related object IDs
- Payload

## Initial Event Types

- workspace initialized
- session started
- session finished
- file created
- file modified
- file deleted
- checkpoint created
- package created
- validation recorded
- package exported
- integration attempted
- integration completed

## Design Notes

Events should be append-oriented. Corrections should generally be represented as new events rather than rewriting history.
