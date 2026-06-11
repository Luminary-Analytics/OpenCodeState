# ocs (TypeScript reference — v1)

The first OpenCodeState reference implementation: a **daemonless** CLI that
proves the loop `init → start → checkpoint → finish → export` end-to-end
(slice 1), splits a session into logical change units with deterministic
Tier-0 heuristics (slice 2), attaches codebase-intelligence evidence from
`fallow` to every package (slice 3), and interrupts the finish only when
judgment is required (slice 4). No AI in the loop. See
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

Slices 1–4 of the MVP. Deferred: richer interrupt actions (edit/split/merge
units at the prompt), configurable policy (what counts as interrupt-worthy),
secret scanning, the watcher daemon, agent-hook provenance (MCP), Tier-1
hunk-splitting, and the eventual Rust port of the hot paths.
