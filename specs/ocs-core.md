# OpenCodeState Core Specification

Status: Draft

## Purpose

This document defines the initial core model for OpenCodeState.

OpenCodeState is a software state management standard built around workspaces, sessions, checkpoints, change units, packages, provenance, validation, policy, integration, and release lines.

## Core Objects

- Repository
- Workspace
- Session
- Checkpoint
- Intent
- Change Unit
- Package
- Actor
- Provenance Record
- Validation Record
- Policy Rule
- Integration Record
- Release Line

## Design Rule

OpenCodeState should make source control mechanics disappear unless human judgment is required.

## Compatibility Rule

Git compatibility is important, but Git should be treated as an adapter rather than the core OpenCodeState model.
