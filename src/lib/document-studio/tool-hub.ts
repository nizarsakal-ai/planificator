/**
 * Lot G Planificator V2 : accueil « par outils » du Document Studio (accueil-v3, 19/11/2026). Règles PURES, partagées par
 * l'écran serveur et le petit composant client de recherche (aucune donnée métier, aucun accès serveur).
 *
 * - Six outils, tous adossés à une capacité réellement présente : formulaire de création, modèles publiés, listes,
 *   file de validation filtrée côté serveur, choix d'un document avec la route PDF protégée existante.
 * - Espace PDF (lots 1 et 2, 20/11/2026) : deux outils de plus, « Importer un PDF » et « PDF importés » (visionneuse,
 *   recherche, remplir et signer, versions). Lot 3 : « Combiner des PDF » (troisième outil de la famille).
 * - Recherche : filtre à la frappe sur le titre, la description et quelques mots-clés concrets ; insensible à la casse
 *   et aux accents (« generer » trouve « Générer un document ») ; tous les mots saisis doivent être présents.
 * - Vues de choix bornées à `generer`, `validation` et `pdf` : une seule valeur texte admise, sinon listes existantes.
 */

export type ToolFamilyId = "creer" | "retrouver" | "valider" | "pdf"

export interface ToolFamily { id: ToolFamilyId; label: string }
export interface StudioTool {
  id: "nouveau-modele" | "generer" | "modeles" | "documents" | "validation" | "pdf" | "importer-pdf" | "pdf-importes" | "combiner-pdf"
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
  { id: "pdf", label: "Travailler sur un PDF" },
]

export const STUDIO_TOOLS: readonly StudioTool[] = [
  { id: "nouveau-modele", family: "creer", title: "Nouveau modèle", description: "Créer un modèle : la version 1 démarre en brouillon.", href: "/studio-documents#nouveau-modele", keywords: ["créer", "modèle", "gabarit", "brouillon", "champs"] },
  { id: "generer", family: "creer", title: "Générer un document", description: "Choisir un modèle publié et remplir ses champs.", href: "/studio-documents?vue=generer#generer", keywords: ["générer", "remplir", "publié", "numéro"] },
  { id: "modeles", family: "retrouver", title: "Modèles et versions", description: "Liste complète des modèles et de leurs versions.", href: "/studio-documents#modeles", keywords: ["modèles", "versions", "publication", "liste"] },
  { id: "documents", family: "retrouver", title: "Documents générés", description: "Liste des documents produits, par numéro et état.", href: "/studio-documents#documents", keywords: ["documents", "liste", "numéro", "état"] },
  { id: "validation", family: "valider", title: "En attente de validation", description: "Documents à valider ou refuser par un autre administrateur.", href: "/studio-documents?vue=validation#validation", keywords: ["valider", "validation", "signature", "refus", "attente"] },
  { id: "pdf", family: "valider", title: "Télécharger un PDF", description: "Choisir un document et ouvrir son PDF.", href: "/studio-documents?vue=pdf#pdf", keywords: ["pdf", "télécharger", "exporter", "imprimer"] },
  { id: "importer-pdf", family: "pdf", title: "Importer un PDF", description: "Déposer un PDF reçu pour le consulter, le remplir et le signer.", href: "/studio-documents#importer", keywords: ["importer", "déposer", "ouvrir", "pdf", "reçu", "avis", "fichier"] },
  { id: "pdf-importes", family: "pdf", title: "PDF importés", description: "Visionneuse, recherche, remplir, signer, annoter, biffer, organiser les pages, versions.", href: "/studio-documents#fichiers", keywords: ["pdf", "visionneuse", "remplir", "signer", "signature", "versions", "rechercher", "organiser", "pivoter", "extraire", "pages", "annoter", "surligner", "note", "biffer", "caviarder", "masquer"] },
  { id: "combiner-pdf", family: "pdf", title: "Combiner des PDF", description: "Assembler plusieurs PDF importés en un seul, dans l'ordre choisi.", href: "/studio-documents#combiner", keywords: ["combiner", "fusionner", "assembler", "regrouper", "pdf"] },
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

// ── Lot G2 : recherche dans les documents générés (paramètres d'adresse bornés). ─────────────────────────────────────────
export const DOC_ETATS = ["PENDING_APPROVAL", "ISSUED", "REJECTED"] as const
export type DocEtat = (typeof DOC_ETATS)[number]
/** Paramètres `q` (texte, 80 caractères au plus, caractères de contrôle retirés) et `etat` (liste fermée, sinon tous). */
export function lireRecherche(q: unknown, etat: unknown): { q: string; etat: DocEtat | null } {
  // eslint-disable-next-line no-control-regex
  const texte = typeof q === "string" ? q.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 80) : ""
  return { q: texte, etat: typeof etat === "string" && (DOC_ETATS as readonly string[]).includes(etat) ? (etat as DocEtat) : null }
}

// ── Lot G2 : contexte d'adresse de l'accueil (vue ouverte, modèle de départ, recherche). ─────────────────────────────────
// Un lien qui change UNE dimension reconduit les autres : ouvrir une vue ou choisir un modèle de départ ne perd pas la
// recherche en cours, et inversement. Seules des valeurs déjà validées (listes fermées, texte borné) sont reconduites.
export interface StudioContexte { vue: StudioVue | null; depart: string | null; q: string; etat: DocEtat | null }
/** Adresse interne de l'accueil pour ce contexte ; ordre stable des paramètres (vue, depart, q, etat). */
export function adresseStudio(c: Partial<StudioContexte>, ancre: string): string {
  const p = new URLSearchParams()
  if (c.vue) p.set("vue", c.vue)
  if (c.depart) p.set("depart", c.depart)
  if (c.q) p.set("q", c.q)
  if (c.etat) p.set("etat", c.etat)
  const s = p.toString()
  return `/studio-documents${s ? `?${s}` : ""}#${ancre}`
}
/** Lien d'ouverture d'une vue (`…?vue=x#x`) : même vue, reste du contexte reconduit. Tout autre lien est rendu tel quel. */
export function adresseVue(href: string, c: Partial<Omit<StudioContexte, "vue">>): string {
  const m = /^\/studio-documents\?vue=([a-z]+)#([a-z-]+)$/.exec(href)
  const vue = m ? lireVue(m[1]) : null
  return m && vue ? adresseStudio({ ...c, vue }, m[2]) : href
}
