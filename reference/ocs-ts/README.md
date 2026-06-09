# ocs (TypeScript reference — v1 slice 1)

The first OpenCodeState reference implementation: a **daemonless walking
skeleton** that proves the loop `init → start → checkpoint → finish → export`
end-to-end, with no grouping and no provider (those arrive in slices 2 and 3).
See [RFC 0003](../../rfcs/0003-mvp.md) and the v1 build contract.

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
node src/ocs.ts finish           # emit one whole-session package
node src/ocs.ts export --branch ocs/demo
```

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

Slice 1 of the MVP. Deferred: Tier-0 grouping (slice 2), the fallow provider
(slice 3), the watcher daemon, Tier-1 hunk-splitting, and the eventual Rust port
of the hot paths.
