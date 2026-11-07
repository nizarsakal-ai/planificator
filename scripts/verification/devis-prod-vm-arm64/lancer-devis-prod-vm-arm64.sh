#!/bin/sh
# Lanceur EXTERNE du harnais du CANDIDAT DE PRODUCTION devis (main + destinataire/BC) (PRÉPARÉ, NON EXÉCUTÉ ; copie du lanceur v6) : environnement VIDE (`env -i`) et liste blanche fixe ;
# le harnais revérifie cette liste et refuse toute autre variable. À lancer dans la VM, par un utilisateur NON root.
# Usage : sh lancer-devis-prod-vm-arm64.sh <point-de-montage-du-média> <sha256-du-MANIFESTE-MEDIA> <arbre-attendu>
DIR=$(cd "$(dirname "$0")" && pwd)
exec env -i PATH="/opt/runtime/node/bin:/usr/lib/postgresql/17/bin:/usr/bin:/bin:/usr/sbin:/sbin" LANG="C.UTF-8" LC_ALL="C.UTF-8" TZ="UTC" \
  /bin/bash "$DIR/harnais-devis-prod-vm-arm64.sh" "$@"
