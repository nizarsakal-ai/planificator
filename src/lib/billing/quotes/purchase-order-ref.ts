// V2 06/11/2026 — numéro du bon de commande CLIENT (module PUR). Facultatif, jamais inventé ni déduit d'un autre numéro
// (facture, devis, commande fournisseur) : seule la saisie explicite de l'utilisateur est retenue.
// Normalisation : espaces de bord retirés, espaces internes réduits à un ; vide ⇒ null.
// Correctif R2 (revue Codex) : jeu de caractères aligné sur le rendu PDF V1 réellement disponible (Helvetica, encodage WinAnsi /
// CP1252, police inchangée) : lettres latines ASCII, lettres accentuées latines présentes dans WinAnsi (accents français compris,
// Œ œ Š š Ž ž Ÿ), chiffres ASCII, espace et . _ / # : ( ) + -. Tout autre caractère (idéogrammes, cyrillique, chiffres non ASCII…)
// est REFUSÉ explicitement : aucune translittération, aucune perte silencieuse. Les caractères admis ne sont pas modifiés par pdfSafe.

export const PO_REF_MAX = 64
export const PO_REF_ERRORS = {
  tooLong: `Numéro de bon de commande trop long (${PO_REF_MAX} caractères au plus).`,
  invalid: "Numéro de bon de commande invalide : il doit commencer par une lettre ou un chiffre, puis lettres, chiffres, espaces et . _ / # : ( ) + - uniquement.",
} as const

/** Lettres admises : ASCII et lettres latines de l'encodage WinAnsi (U+00C0–U+00FF hors × et ÷, plus Œ œ Š š Ž ž Ÿ). */
const LETTER = "A-Za-zÀ-ÖØ-öø-ÿŒœŠšŽžŸ"
const START = new RegExp(`^[${LETTER}0-9]`)
const ALLOWED_CHAR = new RegExp(`[${LETTER}0-9 ._/#:()+\\-]`)

export function unsupportedPurchaseOrderChar(value: string): string | null {
  for (const ch of value) if (!ALLOWED_CHAR.test(ch)) return ch
  return null
}

export function normalizePurchaseOrderRef(raw: unknown): { ok: true; value: string | null } | { ok: false; error: string } {
  if (raw === undefined || raw === null) return { ok: true, value: null }
  if (typeof raw !== "string") return { ok: false, error: PO_REF_ERRORS.invalid }
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(raw)) return { ok: false, error: PO_REF_ERRORS.invalid }
  const v = raw.replace(/\s+/g, " ").trim()
  if (!v) return { ok: true, value: null }
  if ([...v].length > PO_REF_MAX) return { ok: false, error: PO_REF_ERRORS.tooLong }
  const bad = unsupportedPurchaseOrderChar(v)
  if (bad) {
    const shown = ` « ${bad} »` // caractères de contrôle déjà refusés et blancs déjà réduits : affichage sûr dans le message
    return { ok: false, error: `Caractère${shown} non pris en charge par le PDF de facture. ${PO_REF_ERRORS.invalid}` }
  }
  if (!START.test(v)) return { ok: false, error: PO_REF_ERRORS.invalid }
  return { ok: true, value: v }
}
