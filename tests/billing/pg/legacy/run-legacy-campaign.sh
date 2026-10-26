#!/bin/sh
# Campagne de migration HÉRITÉE synthétique (mandat Codex §4.C.2) — bases JETABLES uniquement, jamais une base réelle.
# Usage : TEST_PG_ADMIN_URL=postgresql://postgres@127.0.0.1:54329/postgres sh tests/billing/pg/legacy/run-legacy-campaign.sh <scenario>
#   coherent      : schéma antérieur au Lot C → fixtures héritées → migrations C1–C5 + correctives → postchecks (rôle applicatif)
#   cross-company : fixtures + lien devis inter-sociétés → la migration 20261026050000 DOIT s'arrêter (BILLING_FIX_PRECHECK)
#   stale-match   : C1–C5 appliquées, réservation MATCHED orpheline → la migration 20261026051000 DOIT s'arrêter
#   deduction-orphan : correctives appliquées jusqu'à 061000, solde émis avec liaison d'acompte sans ligne → la migration 20261026062000 DOIT s'arrêter
#   cancelled-final  : correctives appliquées jusqu'à 063000, solde émis avec acompte déduit puis annulé par avoir total (cas T1) → la reprise 20261026064000 DOIT libérer la déduction (check-cancelled-final.ts)
set -eu
SCENARIO="${1:?scenario : coherent | cross-company | stale-match | deduction-orphan | cancelled-final}"
ADMIN="${TEST_PG_ADMIN_URL:-}"; [ -n "$ADMIN" ] || { echo "REFUS : TEST_PG_ADMIN_URL absent" >&2; exit 2; }
HOST=$(printf '%s' "$ADMIN" | sed -E 's#^[a-z]+://([^@/]*@)?([^:/?]+).*#\2#'); PORT=$(printf '%s' "$ADMIN" | sed -nE 's#^[a-z]+://([^@/]*@)?[^:/?]+:([0-9]+).*#\2#p'); PORT="${PORT:-5432}"
ok=0; for h in ${TEST_PG_ALLOWED_HOSTS:-127.0.0.1 localhost}; do [ "$h" = "$HOST" ] && ok=1; done; [ "$ok" = 1 ] || { echo "REFUS : hôte $HOST non autorisé" >&2; exit 3; }
ROOT=$(cd "$(dirname "$0")/../../../.." && pwd); cd "$ROOT"
MIG_ROOT="${LEGACY_REPO_ROOT:-$ROOT}" # checkout dont on rejoue la chaîne de migrations (défaut : celui-ci)
DB="pgtest_legacy_$(printf '%s' "$SCENARIO" | tr -c 'a-z0-9' '_')"
printf 'DROP DATABASE IF EXISTS "%s" WITH (FORCE);' "$DB" | npx prisma db execute --url "$ADMIN" --stdin >/dev/null
printf 'CREATE DATABASE "%s";' "$DB" | npx prisma db execute --url "$ADMIN" --stdin >/dev/null
export DATABASE_URL="${ADMIN%/*}/$DB"
PRE_C="20261025210000_billing_restrict_frozen_fks"; C5="20261026040000_accounting_c5"; R2_LAST="20261026061000_billing_fix_r2_same_family_uniques"; R3_LAST="20261026063000_billing_fix_s2_deposit_ceiling_trigger"
subset() { # subset <dernière migration incluse> : déploie uniquement les migrations jusqu'à ce nom (dossier temporaire)
  T=$(mktemp -d); mkdir -p "$T/migrations"; cp "$MIG_ROOT/prisma/schema.prisma" "$T/schema.prisma"; cp "$MIG_ROOT/prisma/migrations/migration_lock.toml" "$T/migrations/"
  for d in "$MIG_ROOT"/prisma/migrations/*/; do n=$(basename "$d"); cp -r "$d" "$T/migrations/$n"; [ "$n" = "$1" ] && break; done
  npx prisma migrate deploy --schema "$T/schema.prisma" >"$T/deploy.log" 2>&1 || { cat "$T/deploy.log"; return 1; }
  echo "  migrations appliquées jusqu'à $1 : $(grep -c 'Applying migration' "$T/deploy.log")"; rm -rf "$T"
}
echo "== scénario $SCENARIO — base $DB ($HOST:$PORT)"
subset "$PRE_C"
npx prisma db execute --url "$DATABASE_URL" --file tests/billing/pg/legacy/fixtures-pre-c.sql >/dev/null && echo "  fixtures héritées appliquées (schéma pré-C)"
case "$SCENARIO" in
  cross-company) npx prisma db execute --url "$DATABASE_URL" --file tests/billing/pg/legacy/fixtures-cross-company.sql >/dev/null && echo "  lien devis inter-sociétés inséré" ;;
  stale-match) subset "$C5"; npx prisma db execute --url "$DATABASE_URL" --file tests/billing/pg/legacy/fixtures-stale-match.sql >/dev/null && echo "  réservation MATCHED orpheline insérée (après C5)" ;;
  deduction-orphan) subset "$R2_LAST"; npx prisma db execute --url "$DATABASE_URL" --file tests/billing/pg/legacy/fixtures-deduction-orphan.sql >/dev/null && echo "  solde émis avec liaison d'acompte sans ligne de déduction inséré (après 061000)" ;;
  cancelled-final) subset "$R3_LAST"; npx prisma db execute --url "$DATABASE_URL" --file tests/billing/pg/legacy/fixtures-cancelled-final.sql >/dev/null && echo "  solde émis avec acompte déduit puis annulé par avoir total inséré (après 063000, déduction active immuable)" ;;
esac
LOG="${TMPDIR:-/tmp}/legacy-$DB.log"
if npx prisma migrate deploy --schema "$MIG_ROOT/prisma/schema.prisma" >"$LOG" 2>&1; then
  echo "  migrations complètes appliquées : $(grep -c 'Applying migration' "$LOG") (dont correctives)"
  if [ "$SCENARIO" = cancelled-final ]; then node --import tsx tests/billing/pg/legacy/check-cancelled-final.ts && { echo "RESULTAT LEGACY (cancelled-final): OK (reprise 064000 : déduction libérée, conservée)"; exit 0; }; echo "RESULTAT LEGACY (cancelled-final): ECHEC"; exit 1; fi
  [ "$SCENARIO" = coherent ] || { echo "ECHEC : la migration aurait dû s'arrêter sur le précontrôle"; exit 1; }
else
  if grep -q "BILLING_FIX_PRECHECK" "$LOG"; then
    echo "  ARRÊT ATTENDU sur précontrôle :"; grep -oE "BILLING_FIX_PRECHECK[^\"]*" "$LOG" | head -1 | sed 's/^/    /'
    grep -oE "Migration name: [^ ]+" "$LOG" | head -1 | sed 's/^/    /'
    [ "$SCENARIO" != coherent ] && { echo "RESULTAT LEGACY ($SCENARIO): OK (diagnostic explicite, aucune réparation)"; exit 0; }
  fi
  echo "ECHEC migration ($LOG) :"; grep -E "Migration name|Database error code|ERROR:" "$LOG" | head -3 | sed "s/^/    /"; exit 1
fi
# Rôle applicatif pour les postchecks.
APP_ROLE="${TEST_PG_APP_ROLE:-planificator_app_test}"
printf "DO \$\$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='%s') THEN CREATE ROLE %s LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT; END IF; END \$\$;" "$APP_ROLE" "$APP_ROLE" | npx prisma db execute --url "$ADMIN" --stdin >/dev/null
printf 'GRANT CONNECT ON DATABASE "%s" TO %s; GRANT USAGE ON SCHEMA public TO %s; GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO %s; GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO %s; GRANT EXECUTE ON FUNCTION accounting_post_entry(text, text, text), accounting_advance_fiscal_year(text, text, text, text) TO %s;' "$DB" "$APP_ROLE" "$APP_ROLE" "$APP_ROLE" "$APP_ROLE" "$APP_ROLE" | npx prisma db execute --url "$DATABASE_URL" --stdin >/dev/null
export DATABASE_URL_APP="postgresql://${APP_ROLE}@${HOST}:${PORT}/${DB}"
node --import tsx tests/billing/pg/legacy/postchecks.ts
