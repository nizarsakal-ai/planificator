#!/usr/bin/env bash
# Phase confinée de la REPRISE du candidat devis (07/11/2026, PRÉPARÉE, NON EXÉCUTÉE). Réutilise node_modules, client Prisma,
# moteurs Prisma et compilation .next de la campagne interrompue sur le lint (aucun npm ci, aucun prisma generate, aucun build).
# Section 0 (preuves d'isolation) et section 6 (contrôle applicatif et captures) copiées À L'IDENTIQUE de la phase ; la section 4
# (PostgreSQL 17 NEUF et attestation AVANT tout DDL) aussi, sur un cluster NEUF distinct (pg-<tentative>, port 54330).
# Preuves écrites dans /travail/preuves-<tentative> (preuves-reprise, puis preuves-reprise-2…) ; les preuves acquises (/travail/preuves) sont montées en lecture seule.
set -euo pipefail
WORK="$1"; REP="${2:-}"; MODE="${3:-complet}"; LINT_ACQUIS="${4:-}"; P="$WORK/preuves-$REP"; R="$WORK/repo"; S=/support; cd "$R"
[ "$WORK" = "/travail" ] || { echo "REFUS : répertoire de travail interne attendu /travail" >&2; exit 40; }
case "$REP" in reprise|reprise-[2-5]) ;; *) echo "REFUS : tentative de reprise invalide : $REP" >&2; exit 40;; esac
case "$MODE" in complet) ;; captures) case "$LINT_ACQUIS" in reprise|reprise-[2-5]) [ -f "$WORK/preuves-$LINT_ACQUIS/lint-lot.txt" ] || { echo "REFUS : preuve de lint acquise absente" >&2; exit 40; };; *) echo "REFUS : tentative portant le lint acquis invalide" >&2; exit 40;; esac;; *) echo "REFUS : mode invalide : $MODE" >&2; exit 40;; esac
fail() { echo "ÉCHEC : $*" >&2; exit 40; }
t() { local name="$1"; shift; echo "▶ $name"; "$@" > "$P/$name.log" 2>&1 < /dev/null || { echo "ÉCHEC : $name" >&2; tail -40 "$P/$name.log" >&2; exit 50; }; }

# ── 0. Preuves d'isolation (avant toute installation et tout DDL) ──
node -e 'const s=require("net").connect({host:"1.1.1.1",port:443,timeout:3000});s.on("connect",()=>process.exit(0));s.on("error",()=>process.exit(1));s.on("timeout",()=>process.exit(1))' && fail "connexion sortante réussie : confinement réseau absent"
node -e 'require("dns").lookup("registry.npmjs.org",(e)=>process.exit(e?1:0))' && fail "résolution DNS réussie : confinement réseau absent"
IF="$(node -e 'console.log(Object.keys(require("os").networkInterfaces()).sort().join(","))')"
case "$IF" in ""|lo) ;; *) fail "interfaces visibles : $IF";; esac
for p in /attest /campagne /root /home /mnt /media /srv /var /opt/sondes /opt/f10ar-depot; do [ -e "$p" ] && fail "chemin interdit visible : $p"; done
touch /support/.essai-ecriture 2>/dev/null && fail "média accessible en écriture"
{ echo "sonde_tcp_sortante=refusee"; echo "dns=refuse"; echo "interfaces=${IF:-aucune}"; echo "chemins_interdits=absents"; echo "media=lecture_seule"; echo "horodatage=$(date -u +%FT%TZ)"; } > "$P/isolation.txt"

touch /travail/preuves/.essai-ecriture 2>/dev/null && fail "preuves acquises accessibles en écriture"
echo "preuves_acquises=lecture_seule" >> "$P/isolation.txt"

# ── R. Réutilisation contrôlée de la campagne (rien n'est réinstallé ni recompilé) ──
[ -f .next/BUILD_ID ] || fail "compilation .next absente"
[ -d node_modules/.prisma/client ] || fail "client Prisma généré absent"
for m in @next/swc-linux-arm64-gnu @esbuild/linux-arm64 @img/sharp-linux-arm64 @img/sharp-libvips-linux-arm64 @unrs/resolver-binding-linux-arm64-gnu; do
  [ -d "node_modules/$m" ] || fail "liaison native ARM64 absente : $m"
done
if find node_modules -maxdepth 2 -type d \( -name '*-x64*' -o -name '*-darwin*' -o -name '*-win32*' \) | grep -q .; then fail "paquet natif d'une autre plateforme installé"; fi
grep -v '^#' /support/moteurs-prisma-5.22.0-linux-arm64-openssl-3.0.x.tsv | while IFS="$(printf '\t')" read -r url sgz fichier sdec; do
  [ "$(sha256sum "$WORK/prisma/$fichier" | cut -d' ' -f1)" = "$sdec" ] || fail "moteur Prisma de la campagne $fichier"
done
export PRISMA_QUERY_ENGINE_LIBRARY="$WORK/prisma/libquery_engine-linux-arm64-openssl-3.0.x.so.node"
export PRISMA_SCHEMA_ENGINE_BINARY="$WORK/prisma/schema-engine-linux-arm64-openssl-3.0.x"
export PRISMA_ENGINES_CHECKSUM_IGNORE_MISSING=1
t 14-prisma-version npx --no-install prisma --version
{ echo "reutilise=node_modules,node_modules/.prisma/client,.next (BUILD_ID $(cat .next/BUILD_ID)),moteurs Prisma (empreintes revérifiées)"; echo "non_refait=npm ci,prisma generate,next build"; } > "$P/reutilisation.txt"
LOCAL_AUTH_SECRET="$(node -e 'console.log(require("crypto").randomBytes(32).toString("hex"))')"

# ── Lint non interactif (bloquant sur les fichiers du lot) ──
if [ "$MODE" = complet ]; then
  t lint bash scripts/verification/devis-prod-vm-arm64/controle-lint.sh "$P"
else
  # v12 : lint déjà RÉUSSI dans la tentative $LINT_ACQUIS (vérifié hors confinement, preuves gelées en lecture seule) : non rejoué.
  echo "lint=acquis dans preuves-$LINT_ACQUIS : $(tail -1 "$WORK/preuves-$LINT_ACQUIS/lint-lot.txt")" > "$P/lint-acquis.txt"
fi

# ── 4. PostgreSQL 17 NEUF (utilisateur non root), attestation AVANT tout DDL ──
PGDATA="$WORK/pg-$REP"; PORT=54330; [ ! -e "$PGDATA" ] || fail "cluster de reprise déjà présent"
initdb -D "$PGDATA" -A trust -U harnais --no-instructions > "$P/initdb.log" 2>&1
pg_ctl -D "$PGDATA" -o "-c listen_addresses=127.0.0.1 -p $PORT -k $WORK/tmp" -l "$P/postgres.log" -w start > /dev/null
trap 'pg_ctl -D "$PGDATA" -m fast stop >/dev/null 2>&1 || true' EXIT
ADMIN="postgresql://harnais@127.0.0.1:$PORT/postgres"
npx --no-install prisma db execute --url "$ADMIN" --stdin > "$P/pg-attestation.txt" 2>&1 <<'SQL'
DO $$ BEGIN
  IF current_setting('server_version_num')::int / 10000 <> 17 THEN RAISE EXCEPTION 'PostgreSQL 17 requis'; END IF;
  IF (SELECT count(*) FROM pg_database WHERE datname NOT IN ('postgres','template0','template1')) <> 0 THEN RAISE EXCEPTION 'instance non neuve'; END IF;
END $$;
SQL
echo "cluster neuf créé par initdb dans $PGDATA, utilisateur $(id -un) (uid $(id -u)), 127.0.0.1:$PORT ; preuves d'isolation : isolation.txt" >> "$P/pg-attestation.txt"

# ── 6. Contrôle applicatif (base dédiée, seed, données devis synthétiques) et captures des dialogues ──
printf 'CREATE DATABASE "controle_devis";' | npx --no-install prisma db execute --url "$ADMIN" --stdin
# v12 : `next start` tourne avec NODE_ENV=production et hors Vercel ; @auth/core 0.41.2 ne fait alors confiance à l'hôte que si
# AUTH_URL ou AUTH_TRUST_HOST est défini (NEXTAUTH_URL ne compte pas) : sans cela, UntrustedHost sur /api/auth/* et connexion
# impossible (échec des captures de la reprise n° 2). Serveur confiné sur la boucle locale, sans réseau : hôte de confiance explicite.
export DATABASE_URL="postgresql://harnais@127.0.0.1:$PORT/controle_devis" AUTH_SECRET="$LOCAL_AUTH_SECRET" NEXTAUTH_URL="http://127.0.0.1:3100" AUTH_TRUST_HOST=true
export BILLING_COMPLETE_ENABLED=true
t controle-migrate npx --no-install prisma migrate deploy
t controle-seed npx --no-install prisma db seed
t controle-devis env DEVIS_IDS_FILE="$P/devis-synthetique.json" npx --no-install tsx scripts/verification/devis-prod-vm-arm64/seed-synthetique-devis.ts
npx --no-install next start -H 127.0.0.1 -p 3100 > "$P/controle-serveur.log" 2>&1 &
SRV=$!
trap 'kill $SRV 2>/dev/null || true; pg_ctl -D "$PGDATA" -m fast stop >/dev/null 2>&1 || true' EXIT
for i in $(seq 1 90); do node -e 'require("http").get("http://127.0.0.1:3100/login",r=>process.exit(r.statusCode<500?0:1)).on("error",()=>process.exit(1))' && break; sleep 1; [ "$i" -eq 90 ] && fail "serveur de contrôle non prêt"; done
t captures-devis env PREVIEW_URL="http://127.0.0.1:3100" PREUVES="$P/captures-devis" DEVIS_IDS_FILE="$P/devis-synthetique.json" node scripts/verification/devis-prod-vm-arm64/captures-devis-puppeteer.mjs
echo "Contrôles réussis ; serveur arrêté à la fin de la phase ; aucune URL utilisable (espace de noms réseau isolé)." > "$P/serveur-controle.txt"
