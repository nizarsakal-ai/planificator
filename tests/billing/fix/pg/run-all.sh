#!/bin/sh
# Suites PostgreSQL des correctifs Lot C : CHAQUE fichier s'exécute sur une base jetable neuve (fixtures et compteurs isolés).
# Usage : TEST_PG_ADMIN_URL=postgresql://postgres@127.0.0.1:54329/postgres sh tests/billing/fix/pg/run-all.sh [fichier ...]
# Sortie : une ligne par fichier (rc, pass, fail, skip) puis « RESULTAT FIX PG: OK | ECHEC ».
set -u
ROOT=$(cd "$(dirname "$0")/../../../.." && pwd); cd "$ROOT"
WDB="$ROOT/tests/billing/pg/with-disposable-db.sh"
FILES="${*:-p1-01-credit-note-deductions p1-02-vat-receipts p1-03-04-bank-reconciliation p1-05-p2-04-quote-token p1-06-draft-update-rollback p1-07-credit-ceiling p2-01-bank-import-identity p2-02-company-fks p2-03-document-snapshot fix-actions flags-autopost campaign-cross-fec flags-matrix}"
fail=0; total_pass=0; total_fail=0
for f in $FILES; do
  case "$f" in fix-actions|flags-autopost) FLAG="--experimental-test-module-mocks";; *) FLAG="";; esac
  log="${TMPDIR:-/tmp}/fixpg-$f.log"
  sh "$WDB" "fix_$(printf '%s' "$f" | tr -c 'a-z0-9' '_')" node --import tsx $FLAG --test --test-concurrency=1 "tests/billing/fix/pg/$f.pg.test.ts" >"$log" 2>&1; rc=$?
  pass=$(grep -E '^ℹ pass ' "$log" | tail -1 | awk '{print $3}'); failn=$(grep -E '^ℹ fail ' "$log" | tail -1 | awk '{print $3}'); skip=$(grep -E '^ℹ skipped ' "$log" | tail -1 | awk '{print $3}')
  printf '%-34s rc=%-2s pass=%-3s fail=%-3s skip=%-2s (%s)\n' "$f" "$rc" "${pass:--}" "${failn:--}" "${skip:--}" "$log"
  total_pass=$((total_pass + ${pass:-0})); total_fail=$((total_fail + ${failn:-0})); [ "$rc" = 0 ] || fail=1
done
echo "RESULTAT FIX PG: $([ $fail = 0 ] && echo OK || echo ECHEC) — pass=$total_pass fail=$total_fail"
exit $fail
