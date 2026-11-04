/** Normalisation de texte pour le score et le dédoublonnage : minuscules, sans accents, ponctuation réduite à des espaces. */
export function normalizeText(value: string | null | undefined): string {
  return (value ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[’']/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
}

const STOP_WORDS = new Set([
  "a", "au", "aux", "de", "des", "du", "d", "en", "et", "l", "la", "le", "les", "pour", "par", "sur", "un", "une",
  "dans", "avec", "lot", "lots", "marche", "marches", "accord", "cadre", "relatif", "relative", "prestations", "prestation",
])

/** Mots significatifs d'un texte normalisé (sans mots vides), dans l'ordre d'apparition. */
export function significantWords(value: string | null | undefined): string[] {
  return normalizeText(value).split(" ").filter((word) => word.length > 1 && !STOP_WORDS.has(word))
}
