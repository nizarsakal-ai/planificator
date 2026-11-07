#!/usr/bin/env bash
# Phase confinée du harnais du CANDIDAT DE PRODUCTION devis (main + destinataire/BC) (PRÉPARÉE, NON EXÉCUTÉE). Sections 0 à 4 copiées À L'IDENTIQUE de la
# phase v6 (preuves d'isolation, installation hors ligne, moteurs Prisma, polices et compilation, PostgreSQL 17 NEUF et
# attestation AVANT tout DDL). Sections 5 et 6 propres au lot : suites devis-v2, non-régression facturation, contrôle
# applicatif sur base dédiée et captures des deux dialogues (bureau/mobile, clair/sombre). Arrêt au premier échec.
set -euo pipefail
WORK="$1"; MODE="${2:-complet}"; P="$WORK/preuves"; R="$WORK/repo"; S=/support; cd "$R"
[ "$WORK" = "/travail" ] || { echo "REFUS : répertoire de travail interne attendu /travail" >&2; exit 40; }
case "$MODE" in complet|cible) ;; *) echo "REFUS : mode invalide : $MODE" >&2; exit 40;; esac
fail() { echo "ÉCHEC : $*" >&2; exit 40; }
t() { local name="$1"; shift; echo "▶ $name"; "$@" > "$P/$name.log" 2>&1 || { echo "ÉCHEC : $name" >&2; tail -40 "$P/$name.log" >&2; exit 50; }; }

# ── 0. Preuves d'isolation (avant toute installation et tout DDL) ──
node -e 'const s=require("net").connect({host:"1.1.1.1",port:443,timeout:3000});s.on("connect",()=>process.exit(0));s.on("error",()=>process.exit(1));s.on("timeout",()=>process.exit(1))' && fail "connexion sortante réussie : confinement réseau absent"
node -e 'require("dns").lookup("registry.npmjs.org",(e)=>process.exit(e?1:0))' && fail "résolution DNS réussie : confinement réseau absent"
IF="$(node -e 'console.log(Object.keys(require("os").networkInterfaces()).sort().join(","))')"
case "$IF" in ""|lo) ;; *) fail "interfaces visibles : $IF";; esac
for p in /attest /campagne /root /home /mnt /media /srv /var /opt/sondes /opt/f10ar-depot; do [ -e "$p" ] && fail "chemin interdit visible : $p"; done
touch /support/.essai-ecriture 2>/dev/null && fail "média accessible en écriture"
{ echo "sonde_tcp_sortante=refusee"; echo "dns=refuse"; echo "interfaces=${IF:-aucune}"; echo "chemins_interdits=absents"; echo "media=lecture_seule"; echo "horodatage=$(date -u +%FT%TZ)"; } > "$P/isolation.txt"

# ── 1. Installation hors ligne : archives du média vers un cache local, puis npm ci --offline ──
t 11-npm-cache-add sh -c 'cut -f1 /support/npm/INDEX.tsv | sed "s#^#/support/npm/#" | xargs -n 50 npm cache add'
t 12-npm-ci npm ci --offline --ignore-scripts --no-audit --no-fund
for m in @next/swc-linux-arm64-gnu @esbuild/linux-arm64 @img/sharp-linux-arm64 @img/sharp-libvips-linux-arm64 @unrs/resolver-binding-linux-arm64-gnu; do
  [ -d "node_modules/$m" ] || fail "liaison native ARM64 absente : $m"
done
if find node_modules -maxdepth 2 -type d \( -name '*-x64*' -o -name '*-darwin*' -o -name '*-win32*' \) | grep -q .; then fail "paquet natif d'une autre plateforme installé"; fi
echo "liaisons natives ARM64 présentes ; aucune autre plateforme" > "$P/natifs.txt"

# ── 2. Moteurs Prisma 5.22.0 linux-arm64-openssl-3.0.x depuis le média (empreintes publiées revérifiées) ──
mkdir -p "$WORK/prisma"
grep -v '^#' /support/moteurs-prisma-5.22.0-linux-arm64-openssl-3.0.x.tsv | while IFS="$(printf '\t')" read -r url sgz fichier sdec; do
  [ "$(sha256sum "/support/prisma/$fichier.gz" | cut -d' ' -f1)" = "$sgz" ] || fail "archive Prisma $fichier"
  gzip -dc "/support/prisma/$fichier.gz" > "$WORK/prisma/$fichier"
  [ "$(sha256sum "$WORK/prisma/$fichier" | cut -d' ' -f1)" = "$sdec" ] || fail "moteur Prisma décompressé $fichier"
done
chmod 0555 "$WORK/prisma/schema-engine-linux-arm64-openssl-3.0.x"
export PRISMA_QUERY_ENGINE_LIBRARY="$WORK/prisma/libquery_engine-linux-arm64-openssl-3.0.x.so.node"
export PRISMA_SCHEMA_ENGINE_BINARY="$WORK/prisma/schema-engine-linux-arm64-openssl-3.0.x"
export PRISMA_ENGINES_CHECKSUM_IGNORE_MISSING=1
t 13-prisma-generate npx --no-install prisma generate
t 14-prisma-version npx --no-install prisma --version

# ── 3. Polices hors ligne (mécanisme NEXT_FONT_GOOGLE_MOCKED_RESPONSES de next 15.5.18), puis compilation ──
t 15-polices node scripts/verification/devis-prod-vm-arm64/generer-mock-polices.cjs /support "$WORK/polices"
LOCAL_AUTH_SECRET="$(node -e 'console.log(require("crypto").randomBytes(32).toString("hex"))')"
t 16-build env NEXT_FONT_GOOGLE_MOCKED_RESPONSES="$WORK/polices/mock.cjs" DATABASE_URL="postgresql://build@127.0.0.1:1/build" AUTH_SECRET="$LOCAL_AUTH_SECRET" npm run build

# ── 4. PostgreSQL 17 NEUF (utilisateur non root), attestation AVANT tout DDL ──
PGDATA="$WORK/pg"; PORT=54329
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

# ── 5. Suites du lot devis-v2 et non-régression facturation (premiers DDL ici, bases jetables du cluster neuf) ──
export TEST_PG_ADMIN_URL="$ADMIN" RESEND_API_KEY="re_test_dummy"
D="sh tests/billing/pg/with-disposable-db.sh"
if [ "$MODE" = complet ]; then
  t navigation npm run test:navigation
  t devis-v2 npm run test:devis-v2
  t devis-v2-actions npm run test:devis-v2:actions
  t devis-v2-pg $D vm_devis_v2 npm run test:devis-v2:pg
  t billing-c1 npm run test:billing:c1;   t billing-c1-pg $D vm_billing_c1 npm run test:billing:c1:pg
  t billing-c2 npm run test:billing:c2;   t billing-c2-pg $D vm_billing_c2 npm run test:billing:c2:pg
  t billing-c3 npm run test:billing:c3;   t billing-c3-pg $D vm_billing_c3 npm run test:billing:c3:pg
  t billing-pdf npm run test:billing:pdf
  # H1 (revue Codex) : régressions des chemins modifiés (jeton de signature, rollback de brouillon, snapshot, horloge de décision,
  # déductions d'acomptes du devis, ordre des verrous, réallocation d'acomptes à la conversion) : une base jetable DISTINCTE par
  # fichier, arrêt au premier échec, journal conservé (même commande que tests/billing/fix/pg/run-all.sh pour ces fichiers).
  for f in p1-05-p2-04-quote-token p1-06-draft-update-rollback p2-03-document-snapshot r3-decision-clock r7-s1-deductions-quote r8-s2-lock-order r12-t1-deposit-reallocation; do
    t "fix-$f" $D "fix_$(printf '%s' "$f" | tr -c 'a-z0-9' '_')" node --import tsx --test --test-concurrency=1 "tests/billing/fix/pg/$f.pg.test.ts"
  done
else
  # v14 (mode cible) : produit = 7e6038df (suites 262/262 en campagne 02) + classes CSS de src/components/devis/QuoteSendDialog.tsx.
  # Aucun fichier de tests/ n'importe ce composant ni src/components/devis/ : suites non rejouées, justification consignée.
  { echo "suites_section_5=non_rejouees (mode cible)"
    echo "raison=seul src/components/devis/QuoteSendDialog.tsx change (classes CSS) ; aucun fichier de tests/ n'importe src/components/devis/"
    echo "imports_tests_composants_devis=$(grep -rlE 'components/devis/|QuoteSendDialog' tests | wc -l)"
    echo "acquis=campagne 02 (arbre 7e6038df) : 262 tests, 262 réussis, 0 échec (18 journaux)"; } > "$P/suites-non-rejouees.txt"
  [ "$(grep -rlE 'components/devis/|QuoteSendDialog' tests | wc -l)" -eq 0 ] || fail "un test importe un composant devis : mode cible inapplicable, lancer le mode complet"
fi
# Lint (07/11/2026) : `npm run lint` ouvrait l'assistant interactif de next lint (main n'a aucune configuration ESLint) et bloquait
# la campagne 02 de 7e6038df. Contrôle non interactif, bloquant sur les fichiers du lot : voir controle-lint.sh.
t lint bash scripts/verification/devis-prod-vm-arm64/controle-lint.sh "$P"

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
