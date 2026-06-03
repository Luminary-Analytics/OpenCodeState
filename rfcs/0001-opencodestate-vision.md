# RFC 0001: OpenCodeState Vision

Status: Draft

## Summary

OpenCodeState is a new open standard for software state management in the AI-native development era.

It is not intended to be a prettier Git client. It is an attempt to rethink source control from first principles around continuous work capture, intent, sessions, checkpoints, packages, provenance, validation, and safe integration.

## Problem

Traditional source control is built around manual developer operations:

- Create a branch
- Stage files
- Commit changes
- Write messages
- Stash work
- Pull, merge, or rebase
- Resolve text conflicts
- Push to a remote
- Open a pull request
- Explain the work after the fact

This model assumes a human developer is the primary unit of code creation and that the human should decide when and how work becomes history.

That assumption is increasingly incomplete.

Modern software work now includes:

- Human developers
- AI coding agents
- Code assistants
- Automated refactoring tools
- Test generation tools
- Security scanners
- Migration generators
- CI/CD systems
- Policy engines

These actors produce and modify software state continuously. The current source-control model does not natively represent sessions, intent, AI provenance, validation evidence, risk, or semantic integration.

## Vision

OpenCodeState should manage software work, not only file history.

The core developer experience should be:

```bash
ocs start
# work normally
ocs finish
```

At finish time, OpenCodeState should create a structured package of work that includes:

- What changed
- Why it likely changed
- Which changes belong together
- Who or what produced the changes
- What validation evidence exists
- What risks are present
- What needs human review
- How the work can be integrated or exported

## Non-Goals

OpenCodeState is not initially trying to:

- Replace all Git repositories overnight
- Build a GitHub clone first
- Solve semantic merge for every language immediately
- Hide all details from advanced users
- Remove human judgment from software delivery

## Goals

OpenCodeState should:

- Protect work continuously
- Represent developer work as sessions
- Group related changes into change units
- Package work with context, validation, and provenance
- Support human and AI contributors natively
- Enable semantic and policy-aware integration
- Provide Git compatibility as an adapter
- Remain open, local-first, and implementation-independent

## Core Thesis

> Git manages code history. OpenCodeState manages software work.

## Open Questions

- What is the minimal viable storage model?
- How much intelligence should be local versus server-side?
- How should AI provenance be represented without leaking sensitive data?
- How should package identity and signatures work?
- What is the right bridge between OpenCodeState packages and Git commits/branches?
