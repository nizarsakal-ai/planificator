#!/usr/bin/env bash
# REPRISE de la campagne 02 du candidat devis (arbre initial 7e6038df) APRÈS le blocage sur l'invite de `next lint`.
# 07/11/2026. PRÉPARÉ, NON EXÉCUTÉ. À faire relire par Codex AVANT toute exécution en VM.
#
# But : poursuivre les contrôles restants (lint non interactif puis section 6 : contrôle applicatif et captures) SANS refaire
# npm ci, prisma generate ni la compilation, en réutilisant le répertoire de travail de la campagne 02, et SANS toucher aux preuves
# déjà acquises (gelées en lecture seule, montées en lecture seule dans le confinement, manifeste calculé AVANT la reprise).
# Refus avant action, empreintes T1, média en lecture seule et confinement : repris À L'IDENTIQUE du harnais.
# Le produit testé est vérifié fichier par fichier égal à celui de l'arbre de reprise ; seul le dossier du harnais diffère et il est
# monté, depuis l'arbre de reprise vérifié, par-dessus l'ancien dans le confinement (le répertoire de la campagne n'est pas modifié).
# Lancement : sh <média>/harnais-devis-prod/lancer-reprise-devis-prod-vm-arm64.sh <média> <sha256-MANIFESTE-MEDIA> <arbre-reprise> <répertoire-campagne> <arbre-initial>   (NON root)
set -euo pipefail
die() { echo "REFUS : $*" >&2; exit 10; }
blocked() { echo "BLOQUÉ : $*" >&2; exit 20; }

EXPECTED_PATH="/opt/runtime/node/bin:/usr/lib/postgresql/17/bin:/usr/bin:/bin:/usr/sbin:/sbin"
for v in $(env | sed 's/=.*//'); do
  case "$v" in PATH|LANG|LC_ALL|TZ|PWD|OLDPWD|SHLVL|_) ;; *) die "variable hors liste blanche : $v (lancer via lancer-reprise-devis-prod-vm-arm64.sh)";; esac
done
[ "$PATH" = "$EXPECTED_PATH" ] || die "PATH différent de celui du lanceur"
[ $# -eq 5 ] || die "usage : lancer-reprise-devis-prod-vm-arm64.sh <média> <sha256-MANIFESTE-MEDIA> <arbre-reprise> <répertoire-campagne> <arbre-initial>"
MEDIA="$1"; MSHA="$2"; TREE="$3"; WORK="$4"; TREE0="$5"
case "$MSHA" in *[!0-9a-f]*|"") die "empreinte de manifeste invalide";; esac; [ "${#MSHA}" -eq 64 ] || die "empreinte de manifeste invalide"
case "$TREE" in *[!0-9a-f]*|"") die "arbre invalide";; esac; [ "${#TREE}" -eq 40 ] || die "arbre invalide"

# ── 1. Identité de l'exécution et de la machine ──
[ "$(id -u)" -ne 0 ] || die "exécution en root interdite (utilisateur de test non root requis)"
case "$(hostname 2>/dev/null || true)" in srv2065452*) die "VPS aiteam";; esac
for p in /srv/hermes /srv/aiteam-exchange; do [ -e "$p" ] && die "marqueur du VPS aiteam présent ($p)"; done
[ "$(uname -m)" = "aarch64" ] || die "architecture $(uname -m) : aarch64 requis"
grep -q '^13\.' /etc/debian_version 2>/dev/null || die "Debian 13 requis ($(cat /etc/debian_version 2>/dev/null || echo inconnu))"

# ── 2. Aucun réseau dans la VM (Network=[]) : seule « lo », contrôlé avant tout ──
IFACES="$(node -e 'console.log(Object.keys(require("os").networkInterfaces()).sort().join(","))')"
[ "$IFACES" = "lo" ] || die "interfaces réseau de la VM : $IFACES (seule lo admise ; aucun réseau ne doit être ajouté)"

# ── 3. Outils : présence, version et empreinte identiques aux preuves T1 (A1-EXECUTABLES, NAVIGATEUR-A1) ──
check_sha() { [ -x "$1" ] || [ -f "$1" ] || blocked "absent : $1"; [ "$(sha256sum "$1" | cut -d' ' -f1)" = "$2" ] || die "empreinte différente des preuves T1 : $1"; }
check_sha /opt/runtime/node/bin/node b4855de8c4781130b722ceaec9718fed77cca3eed2e5cfc5455e267c0b9ee3b0
check_sha /usr/bin/bwrap b3b829e18a7d43ee589dc37e351cb9480ff7301b493d8227b8c754294638b976
check_sha /usr/lib/postgresql/17/bin/initdb 59dc58361d59ca78da42f703acc8e5cbdb2204febe41217334a27c7cc55d3a01
check_sha /usr/lib/postgresql/17/bin/pg_ctl 9537984844e9d770c0aa78df7bd5c9a86055a218dc0f962f9be0caf5fdebb838
check_sha /usr/lib/postgresql/17/bin/postgres 70b043e4a3730ec58f82b1f94ded7704a80e436762a67f990bb305770414501b
check_sha /usr/lib/chromium/chromium-headless-shell 2d76a7795be77d62aa1e1b6f03f68ba85ffdb8dc422aa3e50125979062d5cf35
PUP=/opt/runtime/pilote-navigateur/node_modules/puppeteer-core
[ "$(node -p "require('$PUP/package.json').version")" = "25.16.0" ] || blocked "puppeteer-core 25.16.0 absent de /opt/runtime/pilote-navigateur"
node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22||(a===22&&b>=3)?0:1)' || blocked "Node ≥ 22.3 requis"
[ "$(initdb --version | sed -E 's/^[^0-9]*([0-9]+).*/\1/')" = "17" ] || blocked "PostgreSQL 17 requis"
for t in npm npx sha256sum tar gzip findmnt; do command -v "$t" >/dev/null 2>&1 || blocked "outil absent : $t"; done
command -v pgrep >/dev/null 2>&1 || blocked "outil absent : pgrep"
case "$TREE0" in *[!0-9a-f]*|"") die "arbre initial invalide";; esac; [ "${#TREE0}" -eq 40 ] || die "arbre initial invalide"

# ── 4. Média : lecture seule, manifeste attendu, chaque fichier conforme ──
[ -d "$MEDIA" ] || die "média introuvable : $MEDIA"
case ",$(findmnt -no OPTIONS --target "$MEDIA")," in *,ro,*) ;; *) die "média non monté en lecture seule";; esac
[ "$(sha256sum "$MEDIA/MANIFESTE-MEDIA.sha256" | cut -d' ' -f1)" = "$MSHA" ] || die "empreinte de MANIFESTE-MEDIA.sha256 différente de celle attendue"
SELF="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"
case "$SELF" in "$MEDIA"/*) ;; *) die "la reprise doit être lancée depuis le média vérifié";; esac

# ── R1. Répertoire de la campagne interrompue : identité, arrêt effectif, interruption sur le lint, aucune reprise antérieure ──
case "$WORK" in /var/tmp/planificator-devis-prod.??????) ;; *) die "répertoire de campagne inattendu : $WORK";; esac
[ -d "$WORK" ] && [ ! -L "$WORK" ] && [ -O "$WORK" ] || die "répertoire de campagne absent ou non possédé : $WORK"
for d in preuves repo repo/node_modules repo/.next prisma; do [ -d "$WORK/$d" ] || die "campagne incomplète : $d absent"; done
[ -f "$WORK/repo/.next/BUILD_ID" ] || die "compilation de la campagne absente (.next/BUILD_ID)"
# Tentatives de reprise (v11) : la 1re utilise preuves-reprise / reprise-arbre / pg-reprise, la k-ième (k ≥ 2) le suffixe -k.
# Une nouvelle tentative n'est admise que si CHAQUE tentative précédente a été (A) refusée AVANT le confinement, ou (B, v12) a réussi
# le lint du lot puis échoué à captures-devis : la nouvelle tentative rejoue alors seulement la section 6 (base neuve, données, captures)
# sans lint. Les preuves des tentatives précédentes sont conservées, gelées, montées en lecture seule, jamais écrasées.
REP=""; PREV=()
for k in 1 2 3 4 5; do
  if [ "$k" -eq 1 ]; then s=reprise; else s="reprise-$k"; fi
  if [ ! -e "$WORK/preuves-$s" ] && [ ! -e "$WORK/$s-arbre" ] && [ ! -e "$WORK/pg-$s" ]; then REP="$s"; break; fi
  [ -d "$WORK/preuves-$s" ] && [ -f "$WORK/preuves-$s/MANIFESTE-PREUVES-CAMPAGNE-INITIALE.txt" ] || die "tentative $s incohérente (preuves ou manifeste initial absents) : demander une décision"
  [ ! -e "$WORK/preuves-$s/MANIFESTE-SHA256.txt" ] || die "la tentative $s est allée à son terme (manifeste final présent) : ne pas retenter"
  if [ ! -e "$WORK/pg-$s" ] && [ ! -e "$WORK/preuves-$s/20-phase-reprise.log" ]; then
    : # (A) refusée AVANT le confinement : rien n'a été exécuté
  else
    # (B) v12 : lint du lot RÉUSSI, puis échec à l'étape captures-devis (seule étape admise à être rejouée, avec sa préparation).
    PL="$WORK/preuves-$s/20-phase-reprise.log"
    [ -f "$PL" ] && [ "$(grep '^▶ ' "$PL" | tail -1)" = "▶ captures-devis" ] && grep -qx 'ÉCHEC : captures-devis' "$PL" \
      || die "la tentative $s n'a échoué ni avant le confinement ni à l'étape captures-devis : ne pas retenter, demander une décision"
    # Lint : réussi DANS cette tentative, ou acquis d'une tentative antérieure déjà validée (mode captures).
    if grep -Eqx 'fichiers=19 erreurs=0 avertissements=[0-9]+ erreurs_fatales=0 code_eslint=0' "$WORK/preuves-$s/lint-lot.txt" 2>/dev/null && ! grep -q 'ÉCART' "$WORK/preuves-$s/lint-lot.txt"; then
      [ -s "$WORK/preuves-$s/lint.log" ] || die "tentative $s : preuve lint.log absente"
      LA="$s"
    elif grep -qx 'mode=captures' "$WORK/preuves-$s/tentative.txt" 2>/dev/null && [ -n "${LINT_ACQUIS:-}" ] && grep -qx "lint_acquis=$LINT_ACQUIS" "$WORK/preuves-$s/tentative.txt" && [ -s "$WORK/preuves-$s/lint-acquis.txt" ]; then
      LA="$LINT_ACQUIS"
    else
      die "la tentative $s n'a pas de lint du lot réussi ni acquis : ne pas retenter, demander une décision"
    fi
    for n in controle-migrate controle-seed controle-devis; do [ -s "$WORK/preuves-$s/$n.log" ] || die "tentative $s : preuve $n.log absente"; done
    # Rejeu admis seulement pour une cause DIAGNOSTIQUÉE et corrigée (pas de reprise à l'aveugle) :
    #  v12 : hôte non approuvé par Auth.js (UntrustedHost dans controle-serveur.log) ;
    #  v13 : captures évaluées (8 résultats) dont TOUS les problèmes relèvent du ciblage du premier [role="dialog"] (tiroir MobileNav)
    #        ou de la saisie par triple clic en émulation tactile, corrigés dans captures-devis-puppeteer.mjs.
    if grep -q 'UntrustedHost' "$WORK/preuves-$s/controle-serveur.log" 2>/dev/null; then
      CAUSE="UntrustedHost"
    elif node -e '
      const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))
      const ok = new Set(["bouton de confirmation « Envoyer à … » absent", "caractère hors encodage non refusé (R2)"])
      const pb = r.resultats.flatMap((x) => x.problems)
      process.exit(r.total === 8 && r.resultats.length === 8 && pb.length > 0 && pb.every((m) => ok.has(m) || m === "erreur : Waiting for selector `[role=\"dialog\"]` failed") ? 0 : 1)
    ' "$WORK/preuves-$s/captures-devis/resultats.json" 2>/dev/null; then
      CAUSE="ciblage-role-dialog"
    else
      die "tentative $s : cause de l'échec des captures non attestée (ni UntrustedHost, ni problèmes de ciblage du dialogue seuls) : ne pas retenter, transmettre les journaux"
    fi
    CAUSES="${CAUSES:-}cause_tentative_$s=$CAUSE"$'\n'
    LINT_ACQUIS="$LA"
  fi
  PREV+=("$s")
done
[ -n "$REP" ] || die "nombre maximal de tentatives de reprise atteint : demander une décision"
MODE=complet; [ -n "${LINT_ACQUIS:-}" ] && MODE=captures
# Campagne arrêtée : plus de confinement lié à ce répertoire ni de harnais en cours (ce script ne porte pas « --bind » dans sa ligne de commande).
pgrep -f -- "--bind $WORK /travail" >/dev/null 2>&1 && die "le confinement de la campagne est encore actif (pgrep -af -- '--bind $WORK /travail') : l'arrêter d'abord"
pgrep -f -- "harnais-devis-prod-vm-arm64\.sh" >/dev/null 2>&1 && die "un harnais devis est encore en cours (pgrep -af harnais-devis-prod-vm-arm64.sh)"
grep -qx "arbre=$TREE0" "$WORK/preuves/versions.txt" || die "la campagne n'a pas porté sur l'arbre initial $TREE0"
grep -qx "arbre_git_recalcule=$TREE0" "$WORK/preuves/versions.txt" || die "arbre Git recalculé de la campagne absent ou différent"
[ "$(grep '^▶ ' "$WORK/preuves/10-phase-devis-prod.log" | tail -1)" = "▶ lint" ] || die "la campagne ne s'est pas interrompue sur le lint"
for n in navigation devis-v2 devis-v2-actions devis-v2-pg billing-c1 billing-c1-pg billing-c2 billing-c2-pg billing-c3 billing-c3-pg billing-pdf \
  fix-p1-05-p2-04-quote-token fix-p1-06-draft-update-rollback fix-p2-03-document-snapshot fix-r3-decision-clock fix-r7-s1-deductions-quote fix-r8-s2-lock-order fix-r12-t1-deposit-reallocation; do
  [ -s "$WORK/preuves/$n.log" ] || die "preuve acquise absente : $n.log"
done
[ -e "$WORK/preuves/MANIFESTE-SHA256.txt" ] && die "la campagne a produit son manifeste final : elle n'est pas interrompue"

# ── R2. Média vérifié AVANT toute écriture ; gel des preuves acquises : manifeste, puis lecture seule ──
MV="$(cd "$MEDIA" && sha256sum -c --strict MANIFESTE-MEDIA.sha256 2>&1)" || { printf '%s\n' "$MV" | grep -v ': OK$' >&2; die "média non conforme"; }
MI="$(cd "$WORK/preuves" && find . -type f -print0 | sort -z | xargs -0 sha256sum)"
for s in ${PREV[@]+"${PREV[@]}"}; do
  [ "$MI" = "$(cat "$WORK/preuves-$s/MANIFESTE-PREUVES-CAMPAGNE-INITIALE.txt")" ] || die "preuves acquises modifiées depuis la tentative $s : demander une décision"
done
mkdir "$WORK/preuves-$REP"
printf '%s\n' "$MV" > "$WORK/preuves-$REP/media-verification.txt"
printf '%s\n' "$MI" > "$WORK/preuves-$REP/MANIFESTE-PREUVES-CAMPAGNE-INITIALE.txt"
{ echo "tentative=$REP"; echo "mode=$MODE"; printf '%s' "${CAUSES:-}"; echo "lint_acquis=${LINT_ACQUIS:-}"; echo "tentatives_precedentes=${PREV[*]+${PREV[*]}}"; } > "$WORK/preuves-$REP/tentative.txt"
chmod -R a-w "$WORK/preuves"
for s in ${PREV[@]+"${PREV[@]}"}; do chmod -R a-w "$WORK/preuves-$s"; done

# ── R3. Arbre de reprise : extraction depuis le média, contenu exact, identité du script lancé ──
SRC_TAR="$MEDIA/source/SOURCE-ARBRE-$TREE.tar"; SRC_LIST="$MEDIA/source/FICHIERS-SHA256-$TREE.txt"
[ -f "$SRC_TAR" ] && [ -f "$SRC_LIST" ] || die "source de l'arbre $TREE absente du média"
A="$WORK/$REP-arbre"; mkdir "$A"
tar -xf "$SRC_TAR" -C "$A" --no-same-owner
( cd "$A" && sha256sum -c --strict --quiet "$SRC_LIST" ) || die "fichiers de l'arbre de reprise non conformes"
[ "$(cd "$A" && find . -type f | wc -l)" -eq "$(wc -l < "$SRC_LIST")" ] || die "fichiers en trop ou manquants dans l'arbre de reprise"
if command -v git >/dev/null 2>&1; then ( cd "$A" && git init -q && git add -A && [ "$(git write-tree)" = "$TREE" ] ) || die "arbre Git recalculé différent de $TREE"; echo "arbre_reprise_git_recalcule=$TREE" >> "$WORK/preuves-$REP/versions.txt"; fi
[ "$(sha256sum "$SELF" | cut -d' ' -f1)" = "$(sha256sum "$A/scripts/verification/devis-prod-vm-arm64/reprise-devis-prod-vm-arm64.sh" | cut -d' ' -f1)" ] || die "la reprise lancée diffère de celle de l'arbre vérifié"

# ── R4. Produit testé = produit de l'arbre de reprise : sources identiques, artefacts PWA de CETTE compilation prouvés ──
# Sources : tout fichier listé hors dossier du harnais et hors artefacts PWA ⇒ empreinte identique ; TOUS les écarts sont listés.
# Artefacts PWA (v11) : @ducanh2912/next-pwa 10.2.9 (dest « public », next.config.ts) SUPPRIME puis RÉGÉNÈRE à chaque next build
# public/{workbox,fallback,swe-worker,worker}-*.js(.map) et public/sw.js(.map) (ses propres motifs de nettoyage). Leurs versions
# suivies dans l'arbre portent l'identifiant d'une compilation antérieure (public/sw.js suivi : k24O5WI8-VDvQRcWTQfMt). Ils ne sont
# admis différents que si leur génération par la compilation réutilisée est prouvée (journal 16-build, BUILD_ID, références).
HD="./scripts/verification/devis-prod-vm-arm64/"
ART='^\./public/((workbox|fallback|swe-worker|worker)-[^/]+\.js(\.map)?|sw\.js(\.map)?)$'
EC="$WORK/preuves-$REP/ecarts-produit.txt"; : > "$EC"
N=0; NA=0; KO=0
while read -r h f; do
  case "$f" in "$HD"*) continue;; esac
  c="absent"; [ -f "$WORK/repo/$f" ] && c="$(sha256sum "$WORK/repo/$f" | cut -d' ' -f1)"
  if printf '%s\n' "$f" | grep -Eq "$ART"; then echo "artefact_pwa $f suivi=$h campagne=$c" >> "$EC"; NA=$((NA+1)); continue; fi
  if [ "$c" = "$h" ]; then N=$((N+1)); else echo "SOURCE_DIFFERENTE $f suivi=$h campagne=$c" >> "$EC"; KO=$((KO+1)); fi
done < "$SRC_LIST"
[ "$KO" -eq 0 ] || { grep '^SOURCE_DIFFERENTE' "$EC" >&2; die "$KO fichier(s) source différent(s) entre la campagne et l'arbre de reprise (liste complète : $EC)"; }
[ "$N" -gt 0 ] || die "aucun fichier source comparé"
BID="$(cat "$WORK/repo/.next/BUILD_ID")"; case "$BID" in ""|*[!A-Za-z0-9_-]*) die "BUILD_ID de la campagne invalide";; esac
grep -qF "(pwa) Service worker: /travail/repo/public/sw.js" "$WORK/preuves/16-build.log" || die "journal 16-build : génération de public/sw.js par la compilation non attestée"
grep -qF "/_next/static/$BID/_buildManifest.js" "$WORK/repo/public/sw.js" || die "public/sw.js ne référence pas la compilation réutilisée ($BID)"
for a in $(grep -oE '[A-Za-z0-9_-]*(workbox|swe-worker|fallback|worker)-[0-9a-f]{6,}' "$WORK/repo/public/sw.js" | grep -E '^(workbox|swe-worker|fallback|worker)-[0-9a-f]+$' | sort -u); do
  [ -f "$WORK/repo/public/$a.js" ] || die "artefact référencé par public/sw.js absent : public/$a.js"
  echo "artefact_reference public/$a.js campagne=$(sha256sum "$WORK/repo/public/$a.js" | cut -d' ' -f1)" >> "$EC"
done
echo "provenance_pwa=journal 16-build (Service worker: /travail/repo/public/sw.js) ; BUILD_ID $BID référencé par public/sw.js" >> "$EC"
{ echo "arbre_reprise=$TREE"; echo "arbre_initial=$TREE0"; echo "campagne=$WORK"; echo "fichiers_source_identiques=$N (hors $HD et artefacts PWA)"; echo "artefacts_pwa_regeneres=$NA (voir ecarts-produit.txt)"; echo "machine=$(uname -srm)"; echo "node=$(node --version)"; echo "manifeste_media=$MSHA"; echo "date_utc=$(date -u +%FT%TZ)"; } >> "$WORK/preuves-$REP/versions.txt"
# ── 6. Fichiers /etc minimaux générés (aucune base de comptes réelle exposée) ──
printf '%s:x:%s:%s::/travail/home:/bin/sh\nnobody:x:65534:65534::/nonexistent:/usr/sbin/nologin\n' "$(id -un)" "$(id -u)" "$(id -g)" > "$WORK/etc/passwd"
printf '%s:x:%s:\nnogroup:x:65534:\n' "$(id -gn)" "$(id -g)" > "$WORK/etc/group"
printf '127.0.0.1 localhost\n::1 localhost\n' > "$WORK/etc/hosts"
printf 'passwd: files\ngroup: files\nhosts: files\n' > "$WORK/etc/nsswitch.conf"

# ── 7. Confinement bubblewrap : racine vide, liste blanche, tous espaces de noms isolés (réseau compris) ──
# Revue Codex : le répertoire de travail de l'hôte (/var/tmp/…) est monté sous le chemin INTERNE distinct /travail ;
# /var de l'hôte n'est jamais exposé, et le contrôle des chemins interdits (dont /var) reste strict.
B=(--tmpfs / --ro-bind /usr /usr)
for d in bin sbin lib lib64; do if [ -L "/$d" ]; then B+=(--symlink "$(readlink "/$d")" "/$d"); elif [ -d "/$d" ]; then B+=(--ro-bind "/$d" "/$d"); fi; done
B+=(--dir /etc)
for f in /etc/ld.so.cache /etc/localtime /etc/alternatives /etc/fonts; do [ -e "$f" ] && B+=(--ro-bind "$f" "$f"); done
for f in passwd group hosts nsswitch.conf; do B+=(--ro-bind "$WORK/etc/$f" "/etc/$f"); done
B+=(--ro-bind /opt/runtime/node /opt/runtime/node --ro-bind /opt/runtime/pilote-navigateur /opt/runtime/pilote-navigateur)
B+=(--ro-bind "$MEDIA" /support --bind "$WORK" /travail --dev /dev --tmpfs /dev/shm --proc /proc --tmpfs /tmp)
B+=(--unshare-all --die-with-parent --new-session --clearenv --chdir /travail/repo)
# Reprise : preuves acquises en LECTURE SEULE ; dossier du harnais de l'arbre de reprise vérifié monté par-dessus l'ancien.
B+=(--ro-bind "$WORK/preuves" /travail/preuves --ro-bind "$A/scripts/verification/devis-prod-vm-arm64" /travail/repo/scripts/verification/devis-prod-vm-arm64)
for s in ${PREV[@]+"${PREV[@]}"}; do B+=(--ro-bind "$WORK/preuves-$s" "/travail/preuves-$s"); done
run() { # run <nom-preuve> <commande…>
  local name="$1"; shift; echo "▶ $name"
  if ! bwrap "${B[@]}" -- /usr/bin/env PATH="$EXPECTED_PATH" LANG=C.UTF-8 LC_ALL=C.UTF-8 TZ=UTC HOME=/travail/home TMPDIR=/travail/tmp \
      npm_config_cache=/travail/npm-cache npm_config_offline=true NEXT_TELEMETRY_DISABLED=1 CHECKPOINT_DISABLE=1 "$@" > "$WORK/preuves-$REP/$name.log" 2>&1 < /dev/null; then
    echo "ÉCHEC : $name (voir $WORK/preuves-$REP/$name.log)" >&2; tail -40 "$WORK/preuves-$REP/$name.log" >&2; exit 30
  fi
}
run 20-phase-reprise bash /travail/repo/scripts/verification/devis-prod-vm-arm64/phase-reprise-devis-prod-vm-arm64.sh /travail "$REP" "$MODE" "${LINT_ACQUIS:-}"

# ── 8. Manifeste des preuves de la reprise (les preuves initiales gardent leur manifeste MANIFESTE-PREUVES-CAMPAGNE-INITIALE.txt) ──
( cd "$WORK/preuves-$REP" && find . -type f ! -name MANIFESTE-SHA256.txt -print0 | sort -z | xargs -0 sha256sum > MANIFESTE-SHA256.txt )
echo "Terminé. Preuves de la reprise : $WORK/preuves-$REP (MANIFESTE-SHA256.txt) ; preuves initiales et tentatives précédentes inchangées."
