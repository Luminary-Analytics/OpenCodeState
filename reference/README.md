# Reference Implementation

This directory will hold the first OpenCodeState reference implementation. It is
a planning skeleton today — no code yet. The architecture is specified in
[RFC 0003 (MVP)](../rfcs/0003-mvp.md) and
[RFC 0005 (Codebase Intelligence Providers)](../rfcs/0005-codebase-intelligence-providers.md).

## Planned layout

The implementation is a **hybrid**, mirroring the shape of tools like `fallow`
(a Rust core distributed through an npm/MCP surface).

### Rust core — the engine

```
ocs-core      object model; session / checkpoint / package logic
ocs-store     content-addressed storage (gitoxide-backed)
ocs-engine    classify -> normalize -> group pipeline; diff; snapshot
ocs-git       Git export / import adapter
ocs-cli       the `ocs` binary (distributed via an npx wrapper)
```

Governed by `clippy` / `rustfmt` / `cargo test`. (A TS/JS analyzer such as
`fallow` cannot read Rust, so the core uses Rust-native tooling — the same limit
`fallow` accepts for its own Rust core.)

### TypeScript surface — integration, governed by `fallow`

```
ocs-mcp       MCP server so agents drive OCS and emit provenance
ocs-vscode    VS Code extension (first IDE integration)
ocs-fallow    the fallow CodebaseIntelligenceProvider adapter
oracle/       the "compared with fallow" calibration harness
```

This surface is itself a TS/JS codebase, so it is analyzed and gated by
`npx fallow` in CI, and OpenCodeState can ultimately manage it with `fallow` as
the provider — dogfooding the product.

## First milestone

The daemonless vertical slice defined in [RFC 0003](../rfcs/0003-mvp.md):
`ocs init / start / checkpoint / finish / restore / export`, Tier-0 grouping,
`fallow`-sourced validation and risk, and Git export.
