#!/usr/bin/env bash
# Acceptance test for OpenCodeState v1 (slice 1).
# Runs the build-contract scenario against a throwaway copy of the fixture and
# asserts restore / finish / export behavior. Requires Node >= 23.6 and git.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
OCS="$HERE/../src/ocs.ts"
ocs() { node "$OCS" "$@"; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
cp -R "$HERE/fixtures/sample/." "$WORK/"
cd "$WORK"

git init -q
git config user.email t@example.com
git config user.name tester
git add -A
git commit -qm "initial sample"

fail() { echo "FAIL: $1"; exit 1; }

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
  if (p.change_units.length !== 1) { console.error("expected 1 change unit"); process.exit(1); }
' "$PKG"
echo "PASS: package captured the session net changes in 1 change unit"

echo "== export =="; ocs export --branch ocs/demo

# Branch tree must equal the current working tree (excluding .ocs).
TMPI="$(mktemp -u)"
GIT_INDEX_FILE="$TMPI" git add -A
WT="$(GIT_INDEX_FILE="$TMPI" git write-tree)"
rm -f "$TMPI"
BR_TREE="$(git rev-parse 'refs/heads/ocs/demo^{tree}')"
if [ "$WT" != "$BR_TREE" ]; then fail "export branch tree ($BR_TREE) != working tree ($WT)"; fi
echo "PASS: export branch tree matches the working tree"

# Checkpoint refs exist in the object db.
N_CKPT="$(git for-each-ref --format='%(refname)' 'refs/ocs/checkpoints/**' | wc -l | tr -d ' ')"
echo "checkpoint refs: $N_CKPT"
if [ "$N_CKPT" -lt 3 ]; then fail "expected >=3 checkpoint refs (2 explicit + 1 pre-restore)"; fi

echo
echo "ALL ACCEPTANCE CHECKS PASSED"
