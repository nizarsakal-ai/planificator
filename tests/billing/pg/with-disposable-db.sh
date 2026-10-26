#!/bin/sh
# Base PostgreSQL JETABLE pour une campagne de tests. Refuse tout hôte hors liste autorisée (jamais une base réelle).
# Usage : TEST_PG_ADMIN_URL=postgresql://postgres@127.0.0.1:54329/postgres sh with-disposable-db.sh <nom> <commande...>
# Effet : DROP + CREATE de la base "pgtest_<nom>", `prisma migrate deploy`, création du rôle applicatif de test
# (DML seulement, non propriétaire) puis exécution de la commande avec DATABASE_URL (propriétaire) et DATABASE_URL_APP (rôle applicatif).
set -eu
NAME="${1:?nom de base}"; shift
ADMIN="${TEST_PG_ADMIN_URL:-}"
[ -n "$ADMIN" ] || { echo "REFUS : TEST_PG_ADMIN_URL absent (instance PostgreSQL jetable locale obligatoire)" >&2; exit 2; }
HOST=$(printf '%s' "$ADMIN" | sed -E 's#^[a-z]+://([^@/]*@)?([^:/?]+).*#\2#')
PORT=$(printf '%s' "$ADMIN" | sed -nE 's#^[a-z]+://([^@/]*@)?[^:/?]+:([0-9]+).*#\2#p'); PORT="${PORT:-5432}"
ALLOWED="${TEST_PG_ALLOWED_HOSTS:-127.0.0.1 localhost}"
ok=0; for h in $ALLOWED; do [ "$h" = "$HOST" ] && ok=1; done
[ "$ok" = 1 ] || { echo "REFUS : hôte « $HOST » hors de la liste autorisée ($ALLOWED)" >&2; exit 3; }
case "$NAME" in ""|*[!a-z0-9_]*) echo "REFUS : nom de base invalide « $NAME » (a-z 0-9 _)" >&2; exit 2;; esac
case "${DATABASE_URL:-}" in "") ;; *) echo "DATABASE_URL préexistant ignoré (remplacé par la base jetable)";; esac
DB="pgtest_${NAME}"
BASE="${ADMIN%/*}"
APP_ROLE="${TEST_PG_APP_ROLE:-planificator_app_test}"
LOG="${TMPDIR:-/tmp}/migrate-$DB.log"
printf 'DROP DATABASE IF EXISTS "%s" WITH (FORCE);' "$DB" | npx prisma db execute --url "$ADMIN" --stdin >/dev/null
printf 'CREATE DATABASE "%s";' "$DB" | npx prisma db execute --url "$ADMIN" --stdin >/dev/null
export DATABASE_URL="$BASE/$DB"
if ! npx prisma migrate deploy >"$LOG" 2>&1; then echo "MIGRATION ECHEC ($LOG)"; tail -30 "$LOG"; exit 1; fi
N=$(grep -cE "^Applying migration " "$LOG" || true)   # une ligne « Applying migration <nom> » par migration réellement appliquée
echo "base jetable $DB ($HOST:$PORT) : migrations appliquées = $N"
# Rôle applicatif NON propriétaire (docs/runbooks/DB-APP-ROLE.md) : DML seulement, EXECUTE sur les fonctions SECURITY DEFINER du moteur A1.
printf "DO \$\$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='%s') THEN CREATE ROLE %s LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT; END IF; END \$\$;" "$APP_ROLE" "$APP_ROLE" | npx prisma db execute --url "$ADMIN" --stdin >/dev/null
printf 'GRANT CONNECT ON DATABASE "%s" TO %s; GRANT USAGE ON SCHEMA public TO %s; GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO %s; GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO %s; GRANT EXECUTE ON FUNCTION accounting_post_entry(text, text, text), accounting_advance_fiscal_year(text, text, text, text) TO %s;' "$DB" "$APP_ROLE" "$APP_ROLE" "$APP_ROLE" "$APP_ROLE" "$APP_ROLE" | npx prisma db execute --url "$DATABASE_URL" --stdin >/dev/null
export DATABASE_URL_APP="postgresql://${APP_ROLE}@${HOST}:${PORT}/${DB}"
export PGTEST_DB="$DB"
exec "$@"
