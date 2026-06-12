#!/usr/bin/env bash
# Acceptance tests for OpenCodeState v1.
#   Scenario 1 (slice 1): the daemonless loop — checkpoint / restore / finish / export.
#   Scenario 2 (slice 2): Tier-0 grouping — finish splits change units; export
#                         writes one commit per unit.
# Requires Node >= 23.6 and git.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
OCS="$HERE/../src/ocs.ts"
ocs() { node "$OCS" "$@"; }
fail() { echo "FAIL: $1"; exit 1; }

new_repo() { # copy the fixture into $1 and make the initial commit
  cp -R "$HERE/fixtures/sample/." "$1/"
  cd "$1"
  git init -q
  git config user.email t@example.com
  git config user.name tester
  git add -A
  git commit -qm "initial sample"
}

worktree_oid() { # tree oid of the current working tree (throwaway index)
  local tmpi
  tmpi="$(mktemp -u)"
  GIT_INDEX_FILE="$tmpi" git add -A
  GIT_INDEX_FILE="$tmpi" git write-tree
  rm -f "$tmpi"
}

W1="$(mktemp -d)"
W2="$(mktemp -d)"
W3="$(mktemp -d)"
W4="$(mktemp -d)"
trap 'rm -rf "$W1" "$W2" "$W3" "$W4"' EXIT

###############################################################################
echo "================ scenario 1: the loop ================"
# Scenarios 1-2 run provider-less (hermetic/offline) — which also exercises the
# degrade path: no provider, package carries no analysis evidence.
export OCS_PROVIDER=none
new_repo "$W1"

echo "== init ==";  ocs init
echo "== start =="; ocs start --intent "demo work"

# Two edits, then checkpoint 1.
printf '\nexport const ADDED = 1;\n' >> src/util.ts
sed -i.bak 's/return 1;/return 2;/' src/a.ts && rm -f src/a.ts.bak
echo "== checkpoint 1 =="; ocs checkpoint --label "edits"

# A third edit, then checkpoint 2.
printf '\n// note\n' >> src/b.ts
echo "== checkpoint 2 =="; ocs checkpoint

echo "== status =="; ocs status

# Make a destructive edit, then restore to checkpoint 2.
echo 'GARBAGE' > src/a.ts
echo "== restore 2 =="; ocs restore 2
if ! grep -q "return 2;" src/a.ts; then fail "restore did not bring back 'return 2;'"; fi
if grep -q "GARBAGE" src/a.ts; then fail "restore left GARBAGE in src/a.ts"; fi
echo "PASS: restore rolled the working tree back"

# More work, then finish. One clean unit, no introduced risk -> the silent
# path: no judgment interrupt, exit 0, no --yes needed.
printf '\nexport const MORE = 3;\n' >> src/util.ts
echo "== finish (clean -> silent) =="
F1OUT="$(mktemp)"
ocs finish | tee "$F1OUT"
grep -q "judgment" "$F1OUT" && fail "clean finish should not interrupt" || true
echo "PASS: clean finish stayed silent (no interrupt)"

PKG="$(ls .ocs/packages/*.json | head -1)"
node -e '
  const fs = require("fs");
  const p = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  const paths = p.content_changes.map(c => c.path).sort();
  console.log("package files:", paths.join(", "));
  for (const want of ["src/a.ts", "src/b.ts", "src/util.ts"]) {
    if (!paths.includes(want)) { console.error("MISSING " + want); process.exit(1); }
  }
  if (p.change_units.length !== 1) { console.error("expected 1 change unit, got " + p.change_units.length); process.exit(1); }
  if (p.validation.length !== 0) { console.error("expected no validation with OCS_PROVIDER=none"); process.exit(1); }
' "$PKG"
echo "PASS: package captured the session net changes in 1 change unit"

echo "== export =="; ocs export --branch ocs/demo
WT="$(worktree_oid)"
BR_TREE="$(git rev-parse 'refs/heads/ocs/demo^{tree}')"
if [ "$WT" != "$BR_TREE" ]; then fail "export branch tree ($BR_TREE) != working tree ($WT)"; fi
echo "PASS: export branch tree matches the working tree"

N_CKPT="$(git for-each-ref --format='%(refname)' 'refs/ocs/checkpoints/**' | wc -l | tr -d ' ')"
echo "checkpoint refs: $N_CKPT"
if [ "$N_CKPT" -lt 3 ]; then fail "expected >=3 checkpoint refs (2 explicit + 1 pre-restore)"; fi

###############################################################################
echo
echo "================ scenario 2: grouping ================"
new_repo "$W2"
echo "# Sample" > README.md
git add README.md && git commit -qm "add readme"

ocs init
ocs start --intent "multi work"

# Stream A: a new feature with its test (path + import + test-stem signals).
mkdir -p src/feature
cat > src/feature/calc.ts <<'EOF'
export function calc(n: number): number {
  return n * 2;
}
EOF
cat > src/feature/calc.test.ts <<'EOF'
import { calc } from "./calc";

if (calc(2) !== 4) {
  throw new Error("calc broken");
}
EOF
ocs checkpoint --label feature

# Stream B: unrelated docs edit.
printf '\nMore docs.\n' >> README.md
ocs checkpoint --label docs

# Stream C: dependency bump (manifest + lockfile must travel together).
node -e '
const fs = require("fs");
const p = JSON.parse(fs.readFileSync("package.json", "utf8"));
p.dependencies = { leftpad: "1.0.0" };
fs.writeFileSync("package.json", JSON.stringify(p, null, 2) + "\n");
'
cat > package-lock.json <<'EOF'
{ "name": "sample", "lockfileVersion": 3, "packages": {} }
EOF
ocs checkpoint --label deps

echo "== finish --dry-run =="
DR="$(mktemp)" # outside the repo — a file inside it would (correctly) be detected as a session change
ocs finish --dry-run | tee "$DR"
grep -q "DRY RUN" "$DR" || fail "dry-run did not print a plan"
[ -z "$(ls -A .ocs/packages)" ] || fail "dry-run wrote a package"
echo "PASS: dry-run previews without packaging"

echo "== finish (multi-unit -> interrupt) =="
F2OUT="$(mktemp)"
set +e
ocs finish > "$F2OUT" 2>&1
RC=$?
set -e
cat "$F2OUT"
[ "$RC" = "3" ] || fail "expected exit 3 (judgment required), got $RC"
grep -q "judgment required" "$F2OUT" || fail "missing judgment banner"
grep -q "change units — review the split" "$F2OUT" || fail "missing multi-unit reason"
[ -z "$(ls -A .ocs/packages)" ] || fail "interrupted finish wrote a package"
ocs status | grep -q "\[active\]" || fail "session should remain active after interrupted finish"
echo "PASS: non-interactive interrupt paused finish (exit 3, nothing written, session active)"

echo "== finish --yes =="
ocs finish --yes
PKG2="$(ls .ocs/packages/*.json | head -1)"
node -e '
const fs = require("fs");
const p = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const units = p.change_units;
if (units.length !== 3) {
  console.error("expected 3 units, got " + units.length + ": " + units.map(u => u.kind + ":" + u.paths.join("/")).join(" | "));
  process.exit(1);
}
const k = Object.fromEntries(units.map(u => [u.kind, u]));
if (!k.deps || !k.docs || !k.change) { console.error("expected kinds deps/docs/change, got " + units.map(u => u.kind)); process.exit(1); }
const dp = k.deps.paths.slice().sort().join(",");
if (dp !== "package-lock.json,package.json") { console.error("deps unit wrong: " + dp); process.exit(1); }
if (k.docs.paths.join(",") !== "README.md") { console.error("docs unit wrong: " + k.docs.paths); process.exit(1); }
const fp = k.change.paths.slice().sort().join(",");
if (fp !== "src/feature/calc.test.ts,src/feature/calc.ts") { console.error("feature unit wrong: " + fp); process.exit(1); }
if (typeof units[0].confidence !== "number") { console.error("missing confidence"); process.exit(1); }
console.log("units:", units.map(u => "[" + u.kind + "] " + u.title).join(" | "), "| confidence", units[0].confidence);
' "$PKG2"
echo "PASS: 3 change units, lockfile attached to its manifest's unit"

echo "== export =="
ocs export --branch ocs/multi
# 4 commits: a labeled pre-session commit (ocs init created .gitignore before
# start, so the tree was dirty) + one commit per unit.
N="$(git rev-list --count HEAD..refs/heads/ocs/multi)"
[ "$N" = "4" ] || fail "expected 4 export commits (pre-session + 3 units), got $N"
git log --format=%s HEAD..refs/heads/ocs/multi | grep -q "Pre-session working tree state" \
  || fail "missing labeled pre-session commit"
EXPECTED_SETS=$'.gitignore\nREADME.md\npackage-lock.json,package.json\nsrc/feature/calc.test.ts,src/feature/calc.ts'
for c in $(git rev-list HEAD..refs/heads/ocs/multi); do
  S="$(git show --format= --name-only "$c" | sort | paste -sd, -)"
  echo "  commit $(git rev-parse --short "$c") → $S"
  echo "$EXPECTED_SETS" | grep -qxF "$S" || fail "unexpected commit file set: $S"
done
WT2="$(worktree_oid)"
[ "$WT2" = "$(git rev-parse 'refs/heads/ocs/multi^{tree}')" ] || fail "export tree != working tree"
echo "PASS: one commit per unit; final tree matches the working tree"

###############################################################################
echo
echo "================ scenario 3: provider evidence (fallow) ================"
unset OCS_PROVIDER
if ! npx --yes fallow --version >/dev/null 2>&1; then
  echo "SKIP: fallow unavailable (offline npx cache?) — provider path not exercised"
else
  new_repo "$W3"
  # Pre-existing (inherited) debt: an unused export committed BEFORE the session.
  printf '\nexport function oldUnused(): number {\n  return 0;\n}\n' >> src/util.ts
  git add -A && git commit -qm "legacy unused export"

  ocs init
  ocs start --intent "auth fix"

  # Session work: one benign edit + two INTRODUCED dead-code issues.
  sed -i.bak 's/return 1;/return 7;/' src/a.ts && rm -f src/a.ts.bak
  printf '\nexport function newUnused(): number {\n  return 3;\n}\n' >> src/util.ts
  cat > src/orphan.ts <<'EOF'
export function orphan(): number {
  return 42;
}
EOF
  ocs checkpoint --label work

  echo "== finish (introduced issues -> interrupt) =="
  FOUT="$(mktemp)"
  set +e
  ocs finish > "$FOUT" 2>&1
  RC=$?
  set -e
  cat "$FOUT"
  [ "$RC" = "3" ] || fail "expected exit 3 (judgment required), got $RC"
  grep -q "judgment required" "$FOUT" || fail "missing judgment banner"
  grep -q "issue(s) introduced by this session" "$FOUT" || fail "interrupt reason should cite introduced issues"
  grep -q "provider fallow@" "$FOUT" || fail "finish did not report provider evidence"
  [ -z "$(ls -A .ocs/packages)" ] || fail "interrupted finish wrote a package"
  echo "PASS: introduced issues interrupted the finish (exit 3, nothing written)"

  echo "== finish --yes =="
  ocs finish --yes
  PKG3="$(ls .ocs/packages/*.json | head -1)"
  node -e '
const fs = require("fs");
const p = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const a = p.attribution;
if (!a || a.gate !== "new-only") { console.error("missing/unexpected attribution: " + JSON.stringify(a)); process.exit(1); }
if (a.dead_code_introduced < 2) { console.error("expected >=2 introduced dead-code, got " + a.dead_code_introduced); process.exit(1); }
if (a.dead_code_inherited < 1) { console.error("expected >=1 inherited dead-code, got " + a.dead_code_inherited); process.exit(1); }
const v = p.validation[0];
if (!v || v.format !== "sarif" || v.status !== "issues") { console.error("bad validation record: " + JSON.stringify(v && {format: v.format, status: v.status})); process.exit(1); }
if (!(v.rule_counts["fallow/unused-file"] >= 1)) { console.error("expected a fallow/unused-file finding, got " + JSON.stringify(v.rule_counts)); process.exit(1); }
if (v.provenance.provider_id !== "fallow") { console.error("bad provenance id"); process.exit(1); }
if (v.provenance.analyzed_oid !== p.tree) { console.error("analyzed_oid != package tree"); process.exit(1); }
if (!v.provenance.scope.startsWith("changed-since:")) { console.error("bad scope: " + v.provenance.scope); process.exit(1); }
const rs = p.risk_signals;
if (!rs.some(r => r.kind === "dead-code" && r.severity === "error" && r.introduced === true)) { console.error("missing introduced dead-code risk signal"); process.exit(1); }
if (!rs.some(r => r.kind === "inherited-debt" && r.introduced === false)) { console.error("missing inherited-debt signal"); process.exit(1); }
const risky = p.change_units.find(u => u.paths.includes("src/orphan.ts"));
if (!risky || risky.risk !== "error") { console.error("unit containing orphan.ts should carry risk=error, got " + (risky && risky.risk)); process.exit(1); }
console.log("attribution:", JSON.stringify(a));
console.log("rule_counts:", JSON.stringify(v.rule_counts));
' "$PKG3"
  echo "PASS: package carries SARIF validation, attribution, risk signals, and per-unit risk"
fi

###############################################################################
echo
echo "================ scenario 4: agent provenance ================"
export OCS_PROVIDER=none
new_repo "$W4"
ocs init
ocs start --intent "pair session"

# Human edit -> default checkpoint (actor human, trigger explicit).
sed -i.bak 's/return 1;/return 5;/' src/a.ts && rm -f src/a.ts.bak
ocs checkpoint --label "human edit"

# Agent edits -> actor-tagged checkpoint: EXACTLY the command the Claude Code
# hook fires after Edit/Write tool calls. Touches a.ts too (multi-actor file).
printf '\nexport const AI_ADDED = true;\n' >> src/a.ts
printf '\nexport const AI_UTIL = 1;\n' >> src/util.ts
ocs checkpoint --actor ai:claude-code --label "agent edit"
ocs log | grep -q "agent  ai:claude-code" || fail "agent checkpoint should carry trigger=agent + actor"

# Trailing human edit after the last checkpoint (final window -> human).
printf '\n// reviewed\n' >> src/b.ts

echo "== finish (1 unit, clean -> silent) =="
F4OUT="$(mktemp)"
ocs finish | tee "$F4OUT"
if grep -q "judgment" "$F4OUT"; then fail "clean single-unit finish should not interrupt"; fi
grep -q "provenance: ai:claude-code" "$F4OUT" || fail "plan should summarize provenance"

PKG4="$(ls .ocs/packages/*.json | head -1)"
node -e '
const fs = require("fs");
const p = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const byActor = Object.fromEntries(p.provenance.map(r => [r.actor, r]));
const h = byActor["human"], ai = byActor["ai:claude-code"];
if (!h || !ai) { console.error("expected human + ai provenance records, got " + Object.keys(byActor)); process.exit(1); }
if (ai.contribution !== "generated") { console.error("ai contribution should be generated"); process.exit(1); }
for (const want of ["src/a.ts", "src/util.ts"]) if (!ai.paths.includes(want)) { console.error("ai paths missing " + want); process.exit(1); }
for (const want of ["src/a.ts", "src/b.ts"]) if (!h.paths.includes(want)) { console.error("human paths missing " + want); process.exit(1); }
if (h.paths.includes("src/util.ts")) { console.error("human should not be credited with the ai-only file"); process.exit(1); }
const u = p.change_units[0];
if (JSON.stringify(u.actors) !== JSON.stringify(["ai:claude-code", "human"])) { console.error("unit actors wrong: " + JSON.stringify(u.actors)); process.exit(1); }
console.log("provenance:", p.provenance.map(r => r.actor + "=" + r.paths.join("+")).join(" | "));
' "$PKG4"
echo "PASS: package shows human-vs-AI authorship (multi-actor file carries both)"

echo "== hooks install / idempotency / remove =="
ocs hooks install claude
ocs hooks install claude
node -e '
const fs = require("fs");
const s = JSON.parse(fs.readFileSync(".claude/settings.json", "utf8"));
const entries = (s.hooks && s.hooks.PostToolUse || []).filter(e => JSON.stringify(e).includes("agent-hook"));
if (entries.length !== 1) { console.error("expected exactly 1 ocs hook entry after double install, got " + entries.length); process.exit(1); }
const e = entries[0];
if (!/Edit/.test(e.matcher)) { console.error("bad matcher: " + e.matcher); process.exit(1); }
if (!e.hooks[0].command.includes("checkpoint --actor ai:claude-code")) { console.error("bad command: " + e.hooks[0].command); process.exit(1); }
console.log("hook command:", e.hooks[0].command.slice(0, 80) + "...");
'
ocs hooks remove claude
node -e '
const fs = require("fs");
const s = JSON.parse(fs.readFileSync(".claude/settings.json", "utf8"));
const left = JSON.stringify(s).includes("agent-hook");
if (left) { console.error("ocs hook entry survived removal"); process.exit(1); }
'
echo "PASS: hook install is idempotent and removable"

echo
echo "ALL ACCEPTANCE CHECKS PASSED"
