# Reference Implementation

This directory holds the first OpenCodeState reference implementation:
[`ocs-ts/`](ocs-ts/) is the TypeScript walking skeleton (slice 1: the daemonless
loop; slice 2: Tier-0 change grouping). The Rust core port comes later. The
architecture is specified in
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

## Status

- **Slice 1 (done):** the daemonless loop — `ocs init / start / checkpoint /
  restore / finish / export` in [`ocs-ts/`](ocs-ts/).
- **Slice 2 (done):** Tier-0 change grouping — `ocs finish` splits a session
  into change units per [RFC 0004](../rfcs/0004-change-grouping.md) and
  `ocs export` writes one commit per unit.
- **Slice 3 (done):** the `fallow` codebase-intelligence provider
  ([RFC 0005](../rfcs/0005-codebase-intelligence-providers.md)) — packages now
  carry SARIF validation records, risk signals, per-unit risk, and
  introduced-vs-inherited attribution, all wrapped in analysis provenance.
- **Slice 4 (done):** the judgment interrupt — `ocs finish` auto-packages
  silently when clean and pauses (TTY prompt, or exit 3 non-interactively)
  on multiple units, low grouping confidence, or session-introduced issues.
  Inherited debt never interrupts.
- **Next:** hook-fired agent provenance (`ocs checkpoint --actor ai:<name>`
  via MCP / Claude Code hooks), richer interrupt actions (edit/split/merge),
  configurable policy, and the watcher daemon (Phase 2 of RFC 0003).
