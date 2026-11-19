/**
 * Lot G Planificator V2 : accueil « par outils » du Document Studio (accueil-v3, 19/11/2026). Règles PURES, partagées par
 * l'écran serveur et le petit composant client de recherche (aucune donnée métier, aucun accès serveur).
 *
 * - Six outils, tous adossés à une capacité réellement présente : formulaire de création, modèles publiés, listes,
 *   file de validation filtrée côté serveur, choix d'un document avec la route PDF protégée existante.
 * - Recherche : filtre à la frappe sur le titre, la description et quelques mots-clés concrets ; insensible à la casse
 *   et aux accents (« generer » trouve « Générer un document ») ; tous les mots saisis doivent être présents.
 * - Vues de choix bornées à `generer`, `validation` et `pdf` : une seule valeur texte admise, sinon listes existantes.
 */

export type ToolFamilyId = "creer" | "retrouver" | "valider"

export interface ToolFamily { id: ToolFamilyId; label: string }
export interface StudioTool {
  id: "nouveau-modele" | "generer" | "modeles" | "documents" | "validation" | "pdf"
  family: ToolFamilyId
  title: string
  description: string
  /** Adresse interne réelle (section stable ou vue bornée), ouverte par un lien HTML natif. */
  href: string
  keywords: readonly string[]
}

export const TOOL_FAMILIES: readonly ToolFamily[] = [
  { id: "creer", label: "Créer et générer" },
  { id: "retrouver", label: "Retrouver" },
  { id: "valider", label: "Valider et exporter" },
]

export const STUDIO_TOOLS: readonly StudioTool[] = [
  { id: "nouveau-modele", family: "creer", title: "Nouveau modèle", description: "Créer un modèle : la version 1 démarre en brouillon.", href: "/studio-documents#nouveau-modele", keywords: ["créer", "modèle", "gabarit", "brouillon", "champs"] },
  { id: "generer", family: "creer", title: "Générer un document", description: "Choisir un modèle publié et remplir ses champs.", href: "/studio-documents?vue=generer#generer", keywords: ["générer", "remplir", "publié", "numéro"] },
  { id: "modeles", family: "retrouver", title: "Modèles et versions", description: "Liste complète des modèles et de leurs versions.", href: "/studio-documents#modeles", keywords: ["modèles", "versions", "publication", "liste"] },
  { id: "documents", family: "retrouver", title: "Documents générés", description: "Liste des documents produits, par numéro et état.", href: "/studio-documents#documents", keywords: ["documents", "liste", "numéro", "état"] },
  { id: "validation", family: "valider", title: "En attente de validation", description: "Documents à valider ou refuser par un autre administrateur.", href: "/studio-documents?vue=validation#validation", keywords: ["valider", "validation", "signature", "refus", "attente"] },
  { id: "pdf", family: "valider", title: "Télécharger un PDF", description: "Choisir un document et ouvrir son PDF.", href: "/studio-documents?vue=pdf#pdf", keywords: ["pdf", "télécharger", "exporter", "imprimer"] },
]

/** Minuscules, sans diacritiques, espaces réduits. */
export function normaliser(texte: string): string {
  return texte.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, " ").trim()
}

/** Outils dont le titre, la description ou les mots-clés contiennent TOUS les mots saisis ; saisie vide ⇒ tous. */
export function filtrerOutils(saisie: string, outils: readonly StudioTool[] = STUDIO_TOOLS): StudioTool[] {
  const termes = normaliser(saisie.slice(0, 100)).split(" ").filter(Boolean)
  if (termes.length === 0) return [...outils]
  return outils.filter((o) => {
    const texte = normaliser([o.title, o.description, ...o.keywords].join(" "))
    return termes.every((t) => texte.includes(t))
  })
}

export const STUDIO_VUES = ["generer", "validation", "pdf"] as const
export type StudioVue = (typeof STUDIO_VUES)[number]

/** Paramètre `vue` : une seule valeur texte de la liste fermée, sinon `null` (listes existantes). */
export function lireVue(valeur: unknown): StudioVue | null {
  return typeof valeur === "string" && (STUDIO_VUES as readonly string[]).includes(valeur) ? (valeur as StudioVue) : null
}
