/**
 * Texte sûr pour les PDF @react-pdf rendus avec les polices standard (Helvetica, encodage WinAnsi).
 *
 * Cause du défaut observé sur DEV-2026-0001 (« 2/000,00 € ») : `formatEuro` sépare les milliers par une
 * espace fine insécable (U+202F) et préfixe le signe moins typographique (U+2212). Ces caractères n'existent
 * pas dans l'encodage WinAnsi des polices standard : le moteur les remplace par un glyphe de repli (« / »).
 * Les montants sont justes ; seule la représentation est corrigée ici, au moment du rendu. Les slashs
 * légitimes des désignations ne sont jamais touchés.
 */

const SAFE_REPLACEMENTS: readonly [RegExp, string][] = [
  [/[          ]/g, " "], // espaces fines ⇒ insécable (WinAnsi 160)
  [/−/g, "-"], // signe moins typographique ⇒ trait d'union
  [/[‐‑‒]/g, "-"],
  [/→/g, "–"], // flèche ⇒ tiret demi-cadratin (WinAnsi 150)
  [/[✓✔]/g, "v"],
  [/ /g, " "],
]

export function pdfSafe(value: string): string {
  let out = value
  for (const [re, rep] of SAFE_REPLACEMENTS) out = out.replace(re, rep)
  return out
}

/** Caractères que les polices standard ne savent pas rendre (contrôle de tests). */
export const UNSAFE_PDF_CHARS = /[     −→✓✔]/
