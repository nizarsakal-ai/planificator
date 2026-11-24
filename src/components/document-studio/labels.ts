// Lot G Planificator V2 : libellés du Document Studio (affichage seulement).
export const VERSION_STATUS_LABEL: Record<string, string> = { DRAFT: "brouillon", PUBLISHED: "publiée", RETIRED: "retirée" }
export const DOC_STATUS_LABEL: Record<string, string> = { PENDING_APPROVAL: "En attente de validation", ISSUED: "Émis", REJECTED: "Refusé" }
export const DOC_STATUS_CLASS: Record<string, string> = { PENDING_APPROVAL: "bg-amber-50 text-amber-700", ISSUED: "bg-green-50 text-green-700", REJECTED: "bg-red-50 text-red-600" }
/** Lot G2 : aide-mémoire de la mise en forme, affiché dans l'éditeur. */
export const SYNTAX_HELP: readonly (readonly [string, string])[] = [
  ["# Titre", "intertitre"],
  ["## Titre", "sous-titre"],
  ["**texte**", "gras"],
  ["- élément", "liste à puces"],
  ["1. élément", "liste numérotée (le numéro saisi est conservé)"],
  ["| a | b |", "ligne de tableau ; la première ligne est l'en-tête"],
  ["[saut de page]", "saut de page"],
  ["{{cle}}", "champ ; une ligne vide sépare deux blocs"],
]
