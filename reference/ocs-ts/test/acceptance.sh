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
trap 'rm -rf "$W1" "$W2"' EXIT

###############################################################################
echo "================ scenario 1: the loop ================"
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

# More work, then finish.
printf '\nexport const MORE = 3;\n' >> src/util.ts
echo "== finish =="; ocs finish

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

echo "== finish =="
ocs finish
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

echo
echo "ALL ACCEPTANCE CHECKS PASSED"
