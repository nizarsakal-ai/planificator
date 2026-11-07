#!/bin/sh
# Lanceur EXTERNE de la REPRISE du candidat devis (07/11/2026, PRÉPARÉ, NON EXÉCUTÉ ; copie du lanceur du harnais) : environnement
# VIDE (`env -i`) et liste blanche fixe ; la reprise revérifie cette liste. À lancer dans la VM, par l'utilisateur NON root de la campagne.
# Usage : sh lancer-reprise-devis-prod-vm-arm64.sh <média> <sha256-MANIFESTE-MEDIA> <arbre-reprise> <répertoire-campagne> <arbre-initial>
DIR=$(cd "$(dirname "$0")" && pwd)
exec env -i PATH="/opt/runtime/node/bin:/usr/lib/postgresql/17/bin:/usr/bin:/bin:/usr/sbin:/sbin" LANG="C.UTF-8" LC_ALL="C.UTF-8" TZ="UTC" \
  /bin/bash "$DIR/reprise-devis-prod-vm-arm64.sh" "$@"
