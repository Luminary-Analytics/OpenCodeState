# Examples

Illustrative OpenCodeState objects. These are hand-written to make the object
model concrete and reviewable; they are not generated output and the field set
will track the specs as they evolve.

- [example-session.json](example-session.json) — a finished, packaged session
  with a hook-fired checkpoint timeline (including one `ai:claude-code`
  checkpoint) that produced three packages. See
  [specs/ocs-sessions.md](../specs/ocs-sessions.md).
- [example-package.json](example-package.json) — the `pkg_auth_fix` package from
  that session: one change unit, mixed human/AI provenance, SARIF-shaped
  validation from the `fallow` provider, risk signals, and introduced-vs-inherited
  attribution. See [specs/ocs-packages.md](../specs/ocs-packages.md).

The two files are linked: the package's `session_id` and `rollback.checkpoint_ref`
refer back to the session and its final checkpoint.

- [self-hosted-package.json](self-hosted-package.json) — **a real package**, not
  hand-written: produced by `ocs finish` running on this repository itself
  (session `ses_mqauw05daa424c`, 2026-06-12). Three change units grouped at
  confidence 1, all-AI provenance (`ai:claude-code`), passing secret-scan and
  `fallow` audit evidence with `0 introduced / 11 inherited` attribution. The
  three commits it exported are in this repo's history (`fc9288e`, `7929636`,
  `089f8f1`).
