#!/bin/sh
# Planificator V2, lots A à H : fabrication de l'ISO du média VM ARM64 à partir d'un dossier support/ DÉJÀ PRÉPARÉ
# (05/11/2026). PRÉPARÉ, NON EXÉCUTÉ par Claude. À lancer par Codex Mac SUR LE MAC. Aucun téléchargement : sert aussi à
# RECONSTRUIRE l'ISO depuis media-v1/support sans retélécharger les archives.
#
# Correctif du premier lancement réel (05/11/2026) : l'ISO « -iso -joliet » a été lue sous Linux en ISO9660 de base
# (casse perdue, noms tronqués) ; MANIFESTE-MEDIA.sha256 était donc introuvable. Désormais : ISO HYBRIDE
# ISO9660 + Joliet + UDF, noms de volume explicites. Sous Linux : montage UDF (`mount -t udf -o ro`), repli Joliet
# (`mount -t iso9660 -o ro,iocharset=utf8` ; tous les noms du média font 64 caractères au plus).
# Contrôles AVANT livraison (aucun relâché) : empreinte du manifeste attendue ; chaque fichier conforme au manifeste ;
# puis l'image est montée en lecture seule sur le Mac : liste EXACTE des noms (casse comprise) identique à support/,
# manifeste revérifié depuis l'image, empreinte du manifeste lu dans l'image identique ; puis détachement.
#
# Usage : sh fabriquer-iso-mac.sh <dossier-support> <iso-de-sortie-neuve> <sha256-attendu-de-MANIFESTE-MEDIA.sha256>
set -eu
[ "$(uname -s)" = "Darwin" ] || { echo "REFUS : script réservé au Mac" >&2; exit 10; }
[ $# -eq 3 ] || { echo "usage : fabriquer-iso-mac.sh <support> <iso-neuve> <sha256-manifeste>" >&2; exit 10; }
SUP="$1"; ISO="$2"; MSHA="$3"
[ -f "$SUP/MANIFESTE-MEDIA.sha256" ] || { echo "REFUS : $SUP/MANIFESTE-MEDIA.sha256 absent" >&2; exit 11; }
[ ! -e "$ISO" ] || { echo "REFUS : ISO de sortie déjà existante (aucun écrasement)" >&2; exit 11; }
case "$ISO" in "$SUP"/*) echo "REFUS : ISO de sortie à l'intérieur de support/" >&2; exit 11;; esac
[ "$(shasum -a 256 "$SUP/MANIFESTE-MEDIA.sha256" | cut -d' ' -f1)" = "$MSHA" ] || { echo "REFUS : empreinte du manifeste différente de celle attendue" >&2; exit 12; }
( cd "$SUP" && shasum -a 256 -c --strict MANIFESTE-MEDIA.sha256 > /dev/null ) || { echo "REFUS : support/ non conforme à son manifeste" >&2; exit 13; }
TRAV="$(mktemp -d /tmp/planif-iso.XXXXXX)"
( cd "$SUP" && find . -type f | LC_ALL=C sort ) > "$TRAV/noms-support.txt"
n_man="$(wc -l < "$SUP/MANIFESTE-MEDIA.sha256" | tr -d ' ')"; n_sup="$(wc -l < "$TRAV/noms-support.txt" | tr -d ' ')"
[ "$n_sup" -eq $((n_man + 1)) ] || { echo "REFUS : fichiers de support/ hors manifeste ($n_sup fichiers, $n_man entrées)" >&2; exit 13; }
( cd "$SUP" && find . | sed 's#.*/##' | awk 'length($0) > 64 { print; bad=1 } END { exit bad }' ) || { echo "REFUS : nom de plus de 64 caractères (limite Joliet)" >&2; exit 14; }

hdiutil makehybrid -iso -joliet -udf \
  -iso-volume-name PLANIF_V2_AH -joliet-volume-name PLANIF_V2_AH -udf-volume-name PLANIF_V2_AH \
  -o "$ISO" "$SUP" > "$TRAV/makehybrid.log" 2>&1 || { echo "ÉCHEC makehybrid (voir $TRAV/makehybrid.log)" >&2; exit 20; }

MNT="$TRAV/montage"; mkdir -p "$MNT"
hdiutil attach -readonly -nobrowse -mountpoint "$MNT" "$ISO" > "$TRAV/attach.log" 2>&1 || { echo "ÉCHEC montage de contrôle" >&2; exit 21; }
controle() {
  mount | grep " on $MNT " > "$TRAV/type-montage.txt" || true
  ( cd "$MNT" && find . -type f | LC_ALL=C sort ) > "$TRAV/noms-iso.txt"
  diff "$TRAV/noms-support.txt" "$TRAV/noms-iso.txt" > "$TRAV/ecarts-noms.txt" || return 1
  ( cd "$MNT" && shasum -a 256 -c --strict MANIFESTE-MEDIA.sha256 > /dev/null ) || return 2
  [ "$(shasum -a 256 "$MNT/MANIFESTE-MEDIA.sha256" | cut -d' ' -f1)" = "$MSHA" ] || return 3
}
rc=0; controle || rc=$?
hdiutil detach "$MNT" > /dev/null 2>&1 || hdiutil detach -force "$MNT" > /dev/null 2>&1 || true
[ "$rc" -eq 0 ] || { echo "ÉCHEC contrôle de l'image (code $rc ; écarts de noms : $TRAV/ecarts-noms.txt)" >&2; exit 22; }
echo "noms exacts : $n_sup fichiers identiques (casse comprise) ; montage de contrôle : $(cat "$TRAV/type-montage.txt")"
echo "manifeste du média (inchangé) : $MSHA"
echo "ISO : $(shasum -a 256 "$ISO" | cut -d' ' -f1)  $ISO"
echo "Dans la VM (root) : mount -t udf -o ro /dev/sr1 <montage>   ; repli : mount -t iso9660 -o ro,iocharset=utf8 /dev/sr1 <montage>"
echo "Puis vérifier que <montage>/MANIFESTE-MEDIA.sha256 existe sous ce nom exact ; sinon arrêt et rapport (aucun contournement)."
