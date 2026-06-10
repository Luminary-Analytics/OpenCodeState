# ocs (TypeScript reference — v1)

The first OpenCodeState reference implementation: a **daemonless** CLI that
proves the loop `init → start → checkpoint → finish → export` end-to-end
(slice 1) and splits a session into logical change units with deterministic
Tier-0 heuristics (slice 2). No AI, no provider yet — the `fallow` provider
arrives in slice 3. See [RFC 0003](../../rfcs/0003-mvp.md) and
[RFC 0004](../../rfcs/0004-change-grouping.md).

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

Slices 1–2 of the MVP. Deferred: the fallow provider (slice 3), the watcher
daemon, Tier-1 hunk-splitting, and the eventual Rust port of the hot paths.
