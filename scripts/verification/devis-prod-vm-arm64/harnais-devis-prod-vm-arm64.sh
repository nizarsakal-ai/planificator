#!/usr/bin/env bash
# Planificator V2 : harnais du CANDIDAT DE PRODUCTION « devis » (main e952b2ec + destinataire des devis et bon de commande client, SANS les lots A à H) pour la même VM UTM
# Debian 13 ARM64 hors ligne. 06/11/2026. PRÉPARÉ, NON EXÉCUTÉ. À faire relire par Codex AVANT toute exécution en VM.
#
# Copie du harnais v6 (scripts/verification/v2-vm-arm64/harnais-vm-arm64.sh), dont il reprend À L'IDENTIQUE : refus avant
# toute action (root, VPS, liste blanche, aarch64/Debian 13, réseau limité à lo, empreintes T1 des outils), média en lecture
# seule et manifeste, arbre exact, confinement bubblewrap. Seuls changent : le répertoire de travail
# (/var/tmp/planificator-devis-prod.*), le contrôle d'identité du harnais lancé et la phase confinée appelée
# (phase-devis-vm-arm64.sh : suites devis-v2 et non-régression facturation, contrôle applicatif et captures des dialogues).
# Le harnais v6 et son support ne sont ni modifiés ni lus par ce harnais.
# Lancement : sh <média>/harnais-devis-prod/lancer-devis-prod-vm-arm64.sh <média> <sha256-MANIFESTE-MEDIA> <arbre-attendu>   (NON root)
set -euo pipefail
die() { echo "REFUS : $*" >&2; exit 10; }
blocked() { echo "BLOQUÉ : $*" >&2; exit 20; }

EXPECTED_PATH="/opt/runtime/node/bin:/usr/lib/postgresql/17/bin:/usr/bin:/bin:/usr/sbin:/sbin"
for v in $(env | sed 's/=.*//'); do
  case "$v" in PATH|LANG|LC_ALL|TZ|PWD|OLDPWD|SHLVL|_) ;; *) die "variable hors liste blanche : $v (lancer via lancer-devis-prod-vm-arm64.sh)";; esac
done
[ "$PATH" = "$EXPECTED_PATH" ] || die "PATH différent de celui du lanceur"
[ $# -eq 3 ] || [ $# -eq 4 ] || die "usage : lancer-devis-prod-vm-arm64.sh <média> <sha256-MANIFESTE-MEDIA> <arbre-attendu> [complet|cible]"
MEDIA="$1"; MSHA="$2"; TREE="$3"; MODE="${4:-complet}"
# v14 : « cible » = compilation, lint et section 6 (captures) sur arbre neuf, SANS les suites de la section 5 (justification écrite
# dans les preuves ; suites acquises de la campagne 02 pour un produit qui ne diffère que par des classes CSS de QuoteSendDialog.tsx).
case "$MODE" in complet|cible) ;; *) die "mode invalide : $MODE (complet ou cible)";; esac
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

# ── 4. Média : lecture seule, manifeste attendu, chaque fichier conforme ──
[ -d "$MEDIA" ] || die "média introuvable : $MEDIA"
case ",$(findmnt -no OPTIONS --target "$MEDIA")," in *,ro,*) ;; *) die "média non monté en lecture seule";; esac
[ "$(sha256sum "$MEDIA/MANIFESTE-MEDIA.sha256" | cut -d' ' -f1)" = "$MSHA" ] || die "empreinte de MANIFESTE-MEDIA.sha256 différente de celle attendue"
WORK="$(mktemp -d /var/tmp/planificator-devis-prod.XXXXXX)"
mkdir -p "$WORK/preuves" "$WORK/repo" "$WORK/home" "$WORK/tmp" "$WORK/npm-cache" "$WORK/etc"
( cd "$MEDIA" && sha256sum -c --strict MANIFESTE-MEDIA.sha256 ) > "$WORK/preuves/media-verification.txt" 2>&1 || die "média non conforme (voir $WORK/preuves/media-verification.txt)"
SELF="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"
case "$SELF" in "$MEDIA"/*) ;; *) die "le harnais doit être lancé depuis le média vérifié";; esac

# ── 5. Arbre source : extraction depuis le média, contenu exact ──
SRC_TAR="$MEDIA/source/SOURCE-ARBRE-$TREE.tar"; SRC_LIST="$MEDIA/source/FICHIERS-SHA256-$TREE.txt"
[ -f "$SRC_TAR" ] && [ -f "$SRC_LIST" ] || die "source de l'arbre $TREE absente du média"
tar -xf "$SRC_TAR" -C "$WORK/repo" --no-same-owner
( cd "$WORK/repo" && sha256sum -c --strict --quiet "$SRC_LIST" ) || die "fichiers de l'arbre non conformes"
[ "$(cd "$WORK/repo" && find . -type f | wc -l)" -eq "$(wc -l < "$SRC_LIST")" ] || die "fichiers en trop ou manquants dans l'arbre extrait"
if command -v git >/dev/null 2>&1; then ( cd "$WORK/repo" && git init -q && git add -A && [ "$(git write-tree)" = "$TREE" ] ) || die "arbre Git recalculé différent de $TREE"; echo "arbre_git_recalcule=$TREE" >> "$WORK/preuves/versions.txt"; else echo "git absent : contenu vérifié par FICHIERS-SHA256 seulement" >> "$WORK/preuves/versions.txt"; fi
if find "$WORK/repo" -name '.env*' | grep -q .; then die "fichier .env dans l'arbre"; fi
[ "$(sha256sum "$SELF" | cut -d' ' -f1)" = "$(sha256sum "$WORK/repo/scripts/verification/devis-prod-vm-arm64/harnais-devis-prod-vm-arm64.sh" | cut -d' ' -f1)" ] || die "le harnais lancé diffère de celui de l'arbre vérifié"
{ echo "arbre=$TREE"; echo "machine=$(uname -srm)"; echo "debian=$(cat /etc/debian_version)"; echo "node=$(node --version)"; echo "npm=$(npm --version)"; echo "initdb=$(initdb --version)"; echo "bwrap=$(bwrap --version)"; echo "puppeteer-core=25.16.0"; echo "manifeste_media=$MSHA"; echo "mode=$MODE"; echo "date_utc=$(date -u +%FT%TZ)"; } >> "$WORK/preuves/versions.txt"

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
run() { # run <nom-preuve> <commande…>
  local name="$1"; shift; echo "▶ $name"
  if ! bwrap "${B[@]}" -- /usr/bin/env PATH="$EXPECTED_PATH" LANG=C.UTF-8 LC_ALL=C.UTF-8 TZ=UTC HOME=/travail/home TMPDIR=/travail/tmp \
      npm_config_cache=/travail/npm-cache npm_config_offline=true NEXT_TELEMETRY_DISABLED=1 CHECKPOINT_DISABLE=1 "$@" > "$WORK/preuves/$name.log" 2>&1; then
    echo "ÉCHEC : $name (voir $WORK/preuves/$name.log)" >&2; tail -40 "$WORK/preuves/$name.log" >&2; exit 30
  fi
}
run 10-phase-devis-prod bash /travail/repo/scripts/verification/devis-prod-vm-arm64/phase-devis-prod-vm-arm64.sh /travail "$MODE"

# ── 8. Manifeste des preuves ──
( cd "$WORK/preuves" && find . -type f ! -name MANIFESTE-SHA256.txt -print0 | sort -z | xargs -0 sha256sum > MANIFESTE-SHA256.txt )
echo "Terminé. Preuves : $WORK/preuves (MANIFESTE-SHA256.txt). Serveur de contrôle arrêté ; aucune URL produite."
