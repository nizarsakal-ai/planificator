// Retour 18/11/2026 : les factures PDF importées ne portaient pas de client (« Client à choisir » sur 46 lignes), alors que le
// nom du client figure dans le nom du fichier exporté par l'ancien logiciel, ex. « 2026-06-20_Facture_000017_GALYA_EVENTS_
// JEDDIS_TRANSPORT.pdf ». Fonctions pures, sans dépendance serveur (utilisées par l'aperçu et par l'extraction).
// Le nom proposé n'est jamais un client créé : la création reste un choix explicite de l'utilisateur.

const stripAccents = (s: string): string => s.normalize("NFD").replace(/[̀-ͯ]/g, "")
/** Même clé que `nameKey` (normalize.ts) : sans accents, casse, ponctuation ni forme juridique. */
const LEGAL_FORMS = /\b(sarl|sas|sasu|sa|eurl|sci|scop|snc|ei|eirl|selarl|association|ste|societe)\b/g
export function clientKey(raw: string): string {
  return stripAccents(raw).toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(LEGAL_FORMS, " ").replace(/\s+/g, " ").trim()
}

const DOC_WORDS = new Set(["facture", "factures", "avoir", "avoirs", "devis", "invoice", "fa", "fac", "fact", "copie", "duplicata"])
const DATE = /^(\d{4}-\d{2}-\d{2}|\d{8}|\d{2}-\d{2}-\d{4})$/

/**
 * Nom de client lu dans un nom de fichier de facture : retire l'extension, un suffixe « (1) », la date, les mots « Facture »,
 * le numéro et le nom de la société émettrice. Renvoie "" si rien de plausible ne reste (au moins deux lettres).
 */
export function clientNameFromFileName(fileName: string, ownCompanyName: string): string {
  const base = fileName.split(/[\\/]/).pop() ?? ""
  const stem = base.replace(/\.[a-z0-9]{2,5}$/i, "").replace(/\s*\(\d+\)\s*$/, "")
  let tokens = stem.split(/[_\s]+/).filter(Boolean)
  // En-tête : date, type de pièce, numéro (dans n'importe quel ordre).
  while (tokens.length && (DATE.test(tokens[0]) || DOC_WORDS.has(clientKey(tokens[0])) || /^[A-Z]{0,4}[-/]?\d[\d/-]*$/i.test(tokens[0]))) tokens = tokens.slice(1)
  // Société émettrice : première séquence de mots identique à son nom.
  const own = clientKey(ownCompanyName).split(" ").filter(Boolean)
  if (own.length) {
    const keys = tokens.map(t => clientKey(t))
    for (let i = 0; i + own.length <= keys.length; i++) {
      if (own.every((w, j) => keys[i + j] === w)) { tokens = [...tokens.slice(0, i), ...tokens.slice(i + own.length)]; break }
    }
  }
  const name = tokens.join(" ").replace(/\s+/g, " ").trim().slice(0, 200)
  return (name.match(/[a-zà-ÿ]/gi) ?? []).length >= 2 ? name : ""
}

/** Client existant de même nom (clé normalisée), s'il est unique. */
export function existingClientByName<T extends { name: string }>(name: string, clients: readonly T[]): T | null {
  const key = clientKey(name)
  if (!key) return null
  const hits = clients.filter(c => clientKey(c.name) === key)
  return hits.length === 1 ? hits[0] : null
}
