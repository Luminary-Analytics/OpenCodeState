# The OpenCodeState Manifesto

Software development has changed. Source control has not.

Git transformed software collaboration by making distributed version control fast, reliable, and open. It was the right tool for its time, and it remains one of the most important developer tools ever created.

But the world Git was designed for is no longer the only world developers live in.

Modern software is created by humans, AI agents, code assistants, refactoring tools, test generators, security scanners, migration tools, and automation systems. Work happens continuously. Changes are created quickly. Context is scattered across tickets, prompts, conversations, test runs, deployments, and review comments.

Traditional source control asks developers to manually manage low-level mechanics: staging files, naming branches, writing commits, rebasing, stashing, merging, pushing, pulling, and reconstructing intent after the fact.

OpenCodeState exists because the next generation of source control should be different.

## Our belief

> Developers create software. OpenCodeState manages software state.

Source control should protect work continuously. It should understand sessions, intent, context, validation, provenance, risk, and collaboration. It should turn messy human and AI activity into clean, explainable, reviewable packages of work.

It should be invisible until human judgment is required.

## What needs to change

Git is built around commits and branches.

OpenCodeState is built around workspaces, sessions, checkpoints, intent, change units, packages, provenance, validation, integration, and release lines.

A commit says:

> Here is a snapshot and a message.

A package should say:

> Here is a complete, explainable, validated unit of work with context, authorship, risk, test evidence, and integration readiness.

That is the shift.

## Principles

### 1. Human-first, not command-first

The system should match how developers work, not force developers to memorize source-control mechanics.

### 2. Continuous protection

Work should be checkpointed automatically and recoverable at all times.

### 3. Intent over syntax

The system should understand why work happened, not only what lines changed.

### 4. Packages over commits

Reviewable units of work should include context, validation, provenance, risk, and rollback strategy.

### 5. Semantic integration

Combining work should use code understanding, structure, dependency graphs, tests, and policy, not only text diffs.

### 6. AI-native provenance

Human, AI, and automated contributions should be tracked clearly and honestly.

### 7. Local-first by default

Developers should own their local work and be able to work offline.

### 8. Open protocol

The standard should be open, inspectable, extensible, and implementation-independent.

### 9. Git bridge, not Git dependence

Git compatibility matters, but Git should not dictate the OpenCodeState model.

### 10. Interrupt only for judgment

The system should automate mechanics and ask humans only when the decision actually matters.

## The future

The future of software development will include humans and AI agents working together across the same codebases. Source control must become more than a history of files.

It must become a system for managing software state, intent, validation, provenance, collaboration, and trust.

That is OpenCodeState.
