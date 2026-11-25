// Lot 2a juridique : catalogue des pages légales publiques. Le texte source est dans docs/legal/*.md (lot 1) ;
// ce module est pur (pas de fs, pas de Prisma) pour rester utilisable par le middleware Edge et par les tests.

export type LegalDocumentKey = "mentions-legales" | "confidentialite" | "cgu" | "accord-sous-traitance"

export interface LegalDocument {
  key: LegalDocumentKey
  /** Route publique de la page. */
  route: `/${string}`
  /** Fichier source dans docs/legal/. */
  file: string
  /** Titre court (onglet du navigateur, liens). */
  title: string
}

export const LEGAL_DOCUMENTS: readonly LegalDocument[] = [
  { key: "mentions-legales", route: "/mentions-legales", file: "mentions-legales.md", title: "Mentions légales" },
  { key: "confidentialite", route: "/confidentialite", file: "politique-de-confidentialite.md", title: "Confidentialité" },
  { key: "cgu", route: "/cgu", file: "cgu.md", title: "Conditions d'utilisation" },
  { key: "accord-sous-traitance", route: "/accord-sous-traitance", file: "accord-sous-traitance-dpa.md", title: "Accord de sous-traitance des données" },
]

/**
 * Version des CGU et de l'accord de sous-traitance acceptés à l'inscription. À changer à chaque modification
 * importante des textes : la trace d'acceptation garde la version acceptée.
 */
export const LEGAL_TERMS_VERSION = "2026-11-25"

export function legalDocument(key: LegalDocumentKey): LegalDocument {
  const doc = LEGAL_DOCUMENTS.find((d) => d.key === key)
  if (!doc) throw new Error(`Document légal inconnu : ${key}`)
  return doc
}

/** Pages légales : publiques, connecté ou non (jamais de redirection vers le tableau de bord). */
export function isLegalPublicPath(pathname: string): boolean {
  return LEGAL_DOCUMENTS.some((d) => pathname === d.route || pathname === `${d.route}/`)
}

/** Lien interne vers un autre fichier .md du dossier docs/legal → route publique correspondante, sinon inchangé. */
export function legalHref(href: string): string {
  const name = href.replace(/^\.\//, "")
  const doc = LEGAL_DOCUMENTS.find((d) => d.file === name)
  return doc ? doc.route : href
}
