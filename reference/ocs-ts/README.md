# ocs (TypeScript reference — v1)

The first OpenCodeState reference implementation: a **daemonless** CLI that
proves the loop `init → start → checkpoint → finish → export` end-to-end
(slice 1), splits a session into logical change units with deterministic
Tier-0 heuristics (slice 2), attaches codebase-intelligence evidence from
`fallow` to every package (slice 3), interrupts the finish only when
judgment is required (slice 4), records human-vs-AI authorship from
actor-tagged checkpoints (slice 5), enforces configurable policy with a
built-in secret scan (slice 6), and exposes it all to agents over MCP
(slice 7). See
[RFC 0003](../../rfcs/0003-mvp.md), [RFC 0004](../../rfcs/0004-change-grouping.md),
and [RFC 0005](../../rfcs/0005-codebase-intelligence-providers.md).

## Run

No build step. Requires **Node ≥ 23.6** (runs TypeScript directly via type
stripping) and **git**.

```bash
node src/ocs.ts init
node src/ocs.ts start --intent "fix the thing"
# ...edit code...
node src/ocs.ts checkpoint --label "wip"
node src/ocs.ts status
node src/ocs.ts restore 1        # roll the working tree back to checkpoint #1
node src/ocs.ts finish --dry-run # preview the change-unit plan without packaging
node src/ocs.ts finish           # group changes into units and emit a package
node src/ocs.ts export --branch ocs/demo   # one commit per change unit
```

## Grouping (slice 2)

`ocs finish` runs the Tier-0 pipeline from
[RFC 0004](../../rfcs/0004-change-grouping.md) — deterministic and offline:

- **Classify/normalize pre-pass:** rename detection; whitespace-only changes
  bucket into a `reformat` unit; lockfiles attach to their manifest's unit;
  generated files attach to their nearest cause; changes matching commits made
  mid-session (pull/merge) are subtracted.
- **Five signals** weight file pairs: path proximity, import edges (regex over
  ts/js), historical co-change, checkpoint-window temporal proximity, and
  diff-similarity (so cross-cutting edits stay together).
- **Clustering** is connected components over a weight threshold, with a crude
  confidence score; low confidence falls back to a single unit instead of
  guessing — uncertainty interrupts, it never guesses silently.

`ocs export` writes **one commit per change unit** (plus a labeled pre-session
commit if the tree was dirty at `ocs start`); the final exported tree always
equals the working tree at finish.

## Provider evidence (slice 3)

At a real (non-dry) `ocs finish` on a repo with ts/js changes, the `fallow`
adapter ([RFC 0005](../../rfcs/0005-codebase-intelligence-providers.md)) runs
`fallow audit --changed-since <session-baseline>` against the working tree and
attaches to the package:

- `validation[]` — a SARIF-backed record (rule counts + per-finding locations),
  wrapped in analysis provenance (provider id + version, analyzed tree OID,
  scope, timestamp) so every datum is reproducible and attributable.
- `attribution` — issues **introduced** by this session vs **inherited** from
  touched files (fallow's `new-only` gate). This is the package-native form of
  the finish rule: only introduced issues would ever interrupt; inherited debt
  never blocks.
- `risk_signals[]` — package-level signals (dead-code/complexity/duplication
  introduced; inherited-debt as a note), plus a per-unit `risk` field derived
  from finding locations.

Degradation is normal and explicit: `OCS_PROVIDER=none` disables the provider,
non-ts/js sessions get a "no evidence" note, provider errors produce an
`error`-status validation record — `finish` never breaks for lack of analysis.
Checkpoints never invoke the provider (hot path stays cheap).

## The judgment interrupt (slice 4)

The RFC 0003 decide step, live: **silent when clean, stop when it matters.**

A finish auto-packages without interruption when there is one change unit,
high grouping confidence, and no introduced issues. It pauses when judgment is
required:

- multiple change units (the split deserves a look),
- low grouping confidence (the grouper refuses to guess), or
- issues **introduced** by this session (from provider attribution).
  Inherited debt never interrupts — only what this session made worse.

Behavior by context:

- **Interactive (TTY):** shows the reasons and the plan, then asks
  `approve and package? [y/N]`. Declining writes nothing; the session stays
  active.
- **Non-interactive (CI, pipes):** prints the reasons and plan, writes
  nothing, and exits with code **3** (`0` success, `1` error, `3` judgment
  required). `ocs finish --yes` approves explicitly.
- **Dry-run:** reports `would interrupt: …` or `would auto-package (clean)`.

## Agent provenance (slice 5)

Checkpoints are actor-tagged, and attribution falls out of the timeline:
changes in each checkpoint window belong to the actor who fired that
checkpoint; the final window (last checkpoint → finish) belongs to whoever
runs finish. Every net-changed path is covered, and a file touched by both a
human and an agent honestly carries **both** actors. Packages gain real
`provenance[]` records (actor, contribution, paths) and each change unit
lists its `actors`. AI contributions are recorded as `generated`; only actor +
paths are captured — no prompts, no transcripts (provenance is not
surveillance; transcript refs are a future opt-in).

To capture agent edits automatically in Claude Code:

```bash
node src/ocs.ts hooks install claude   # writes a PostToolUse hook into .claude/settings.json
node src/ocs.ts hooks remove claude
```

The hook fires `ocs checkpoint --actor ai:claude-code` after every Edit/Write
tool call (the same pattern fallow's `setup-hooks` uses for its commit gate).
It swallows all failures — no active session, no workspace — so it never
blocks the agent, and install/remove are idempotent.

## Policy + secret scan (slice 6)

`ocs init` writes `.ocs/config.json` — the first real implementation of the
Policy primitive (RFC 0002). Policy decides what is **interrupt-worthy**; it
never decides what gets **recorded** (evidence is always captured):

```jsonc
{
  "provider": "fallow",            // or "none"; OCS_PROVIDER env overrides
  "policy": {
    "interrupt_on_multiple_units": true,
    "interrupt_on_low_confidence": true,
    "interrupt_on_introduced_issues": true,
    "interrupt_on_secrets": true,
    "secret_scan": true,
    "secret_allow_patterns": []    // regexes to suppress false positives
  }
}
```

The built-in secret scanner runs at finish (and in dry-run — it is local and
cheap) over the session's **added lines**, so a finding is introduced-by-
definition. High-precision token formats (AWS, GitHub, Slack, Stripe, npm,
Google, private-key headers) are error-level and interrupt under default
policy; keyword/value assignments are warn-level and never interrupt alone.
Findings become a `secret-scan` validation record, `secret` risk signals, and
per-unit risk — **always redacted**: the raw match never reaches stdout, the
plan, or the package JSON.

## MCP server (slice 7)

`src/mcp.ts` is a stdio MCP server so agents drive OpenCodeState natively
instead of via shell hooks. Register it in Claude Code:

```bash
claude mcp add ocs -- node /path/to/reference/ocs-ts/src/mcp.ts
```

Tools: `ocs_init`, `ocs_start`, `ocs_checkpoint`, `ocs_status`, `ocs_log`,
`ocs_restore`, `ocs_finish_plan`, `ocs_finish`, `ocs_export`.

Agent-first semantics, by design:

- `ocs_checkpoint` defaults to **actor `ai:claude-code`** (the MCP caller is an
  agent — the CLI's human default inverts here), so provenance is correct
  without the caller thinking about it.
- **The judgment interrupt crosses the protocol.** `ocs_finish` without
  `approve: true` returns `status: judgment_required` (not an error) and
  writes nothing — an agent cannot silently bypass the human gate. The agent
  is instructed to surface the plan and only re-call with `approve: true`
  after a human approves. `ocs_finish_plan` previews cheaply.

Implementation: a tools-only server hand-rolled over newline-delimited
JSON-RPC (zero runtime dependencies — swap for the official SDK when the
surface grows beyond tools). Each tool shells the `ocs` CLI — the tested
contract — mapping exit codes `0/3/other` to `ok / judgment_required / error`.
The acceptance test drives the real protocol over stdio
([test/mcp_client.mjs](test/mcp_client.mjs)).

## How it stores state

- Content is snapshotted into the repo's own git object database via plumbing
  (`add` into a throwaway index → `write-tree` → `commit-tree`).
- OCS refs live under `refs/ocs/baseline/*` and `refs/ocs/checkpoints/*`; export
  writes an ordinary branch under `refs/heads/*`.
- Session/package metadata is in `.ocs/state.json`; packages are also written to
  `.ocs/packages/<id>.json`.

Operates inside an existing git repo and never touches your working index. See
[specs/ocs-storage.md](../../specs/ocs-storage.md).

## Test

```bash
npm run acceptance
```

Runs the scripted scenario from the build contract against a throwaway copy of
`test/fixtures/sample` and asserts restore, finish, and export behavior.

## Status

Slices 1–7 of the MVP. Deferred: richer interrupt actions (edit/split/merge
units at the prompt), the watcher daemon, opt-in transcript provenance,
Tier-1 hunk-splitting, the VS Code extension, and the eventual Rust port of
the hot paths.
