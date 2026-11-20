// ═══════════════════════════════════════════════════════════════════════════
// Modèles de design des PDF (devis, factures, acomptes, avoirs) — 20/11/2026.
// Un design = un modèle de mise en page + 2 couleurs (principale : bandeaux, titres ; secondaire : totaux, accents).
// Résolution : choix du document (brouillon) ?? réglage de la société ?? défaut « Classique » (rendu historique inchangé).
// Une pièce émise garde le design figé à l'émission (snapshot pour les factures, colonnes du devis à l'envoi).
// Module PUR (aucun accès base) : utilisable par le rendu, les actions serveur et les composants client.
// ═══════════════════════════════════════════════════════════════════════════

export const PDF_TEMPLATES = ["CLASSIC", "MODERN", "BAND", "MINIMAL"] as const
export type PdfTemplate = (typeof PDF_TEMPLATES)[number]

export const PDF_TEMPLATE_LABEL: Record<PdfTemplate, string> = {
  CLASSIC: "Classique",
  MODERN: "Moderne",
  BAND: "Bandeau",
  MINIMAL: "Épuré",
}

export const PDF_TEMPLATE_DESCRIPTION: Record<PdfTemplate, string> = {
  CLASSIC: "Le gabarit historique : sobre, titre à droite, filets fins.",
  MODERN: "Logo en haut à gauche, client en haut à droite, en-tête de tableau en bandeau arrondi, total TTC en pastille.",
  BAND: "Grand bandeau de couleur en tête avec le titre et le numéro en blanc.",
  MINIMAL: "Noir et blanc aéré : la couleur seulement sur les filets et le total.",
}

/**
 * Format du tableau des lignes. COMPLETE : désignation, unité, quantité, prix unitaire, remise, TVA, total HT.
 * QUICK (« Rapide ») : désignation, TVA, montant HT — autorisé UNIQUEMENT si chaque ligne a une quantité de 1 et aucune
 * remise (le prix unitaire est alors égal au montant : quantité et prix unitaire restent déductibles, art. 242 nonies A CGI).
 * Sinon le rendu repasse en COMPLETE (jamais d'information obligatoire masquée).
 */
export const PDF_LAYOUTS = ["COMPLETE", "QUICK"] as const
export type PdfLayout = (typeof PDF_LAYOUTS)[number]
export const PDF_LAYOUT_LABEL: Record<PdfLayout, string> = { COMPLETE: "Complet", QUICK: "Rapide" }
export const PDF_LAYOUT_DESCRIPTION: Record<PdfLayout, string> = {
  COMPLETE: "Avec quantités, unités et prix unitaires.",
  QUICK: "L'essentiel : désignation, TVA, montant. Uniquement si toutes les lignes ont une quantité de 1 sans remise.",
}

export interface PdfDesign {
  template: PdfTemplate
  primary: string
  secondary: string
  layout: PdfLayout
  /** Afficher SIREN/SIRET et n° de TVA du client (s'ils sont renseignés). */
  showClientIds: boolean
  /** Encadré « Coordonnées bancaires » (IBAN/BIC des paramètres de facturation). */
  showBankDetails: boolean
}

/** Rendu historique (avant les modèles) : aucune pièce existante ne change d'apparence. */
export const DEFAULT_PDF_DESIGN: PdfDesign = { template: "CLASSIC", primary: "#0f3460", secondary: "#0f3460", layout: "COMPLETE", showClientIds: true, showBankDetails: false }

export interface PdfPalette { id: string; label: string; primary: string; secondary: string }

/** Palettes prêtes à l'emploi — toutes lisibles (texte blanc sur la principale, secondaire sur fond blanc : contraste ≥ 4,5). */
export const PDF_PALETTES: readonly PdfPalette[] = [
  { id: "marine", label: "Marine", primary: "#0f3460", secondary: "#1d4ed8" },
  { id: "indigo", label: "Indigo", primary: "#4f46e5", secondary: "#4338ca" },
  { id: "vert", label: "Vert", primary: "#047857", secondary: "#065f46" },
  { id: "bordeaux", label: "Bordeaux", primary: "#9f1239", secondary: "#be123c" },
  { id: "orange", label: "Orange", primary: "#c2410c", secondary: "#9a3412" },
  { id: "ardoise", label: "Ardoise", primary: "#334155", secondary: "#0f766e" },
]

/** Contraste minimal exigé (WCAG AA, texte courant) : texte blanc sur la principale, texte secondaire sur fond blanc. */
export const MIN_CONTRAST = 4.5

const HEX = /^#[0-9a-f]{6}$/

/** « #ABC123 » / « abc123 » → « #abc123 » ; null si ce n'est pas une couleur hexadécimale à 6 chiffres. */
export function normalizeHex(input: string): string | null {
  const v = input.trim().toLowerCase()
  const withHash = v.startsWith("#") ? v : `#${v}`
  return HEX.test(withHash) ? withHash : null
}

function channels(hex: string): [number, number, number] {
  const n = normalizeHex(hex)
  if (!n) throw new RangeError(`Couleur invalide : ${hex}`)
  return [parseInt(n.slice(1, 3), 16), parseInt(n.slice(3, 5), 16), parseInt(n.slice(5, 7), 16)]
}

/** Luminance relative WCAG 2.x (0 = noir, 1 = blanc). */
export function relativeLuminance(hex: string): number {
  const [r, g, b] = channels(hex).map((c) => {
    const s = c / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/** Rapport de contraste WCAG entre deux couleurs (1 à 21). */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a), lb = relativeLuminance(b)
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la]
  return (hi + 0.05) / (lo + 0.05)
}

/** Mélange une couleur avec du blanc : `amount` = part de la couleur (0 = blanc, 1 = couleur pure). Fonds de blocs. */
export function tint(hex: string, amount: number): string {
  if (!(amount >= 0 && amount <= 1)) throw new RangeError("Proportion de teinte hors de [0, 1].")
  const mix = channels(hex).map((c) => Math.round(255 - (255 - c) * amount))
  return `#${mix.map((c) => c.toString(16).padStart(2, "0")).join("")}`
}

export type DesignValidation = { ok: true; design: PdfDesign } | { ok: false; errors: string[] }

export interface DesignInput { template: string; primary: string; secondary: string; layout: string; showClientIds: boolean; showBankDetails: boolean }

/** Contrôle d'un design saisi : modèle et format connus, couleurs hexadécimales, lisibilité garantie. */
export function validateDesign(input: DesignInput): DesignValidation {
  const errors: string[] = []
  const layout = (PDF_LAYOUTS as readonly string[]).includes(input.layout) ? (input.layout as PdfLayout) : null
  if (!layout) errors.push("Format de document inconnu.")
  if (typeof input.showClientIds !== "boolean" || typeof input.showBankDetails !== "boolean") errors.push("Options d'affichage invalides.")
  const template = (PDF_TEMPLATES as readonly string[]).includes(input.template) ? (input.template as PdfTemplate) : null
  if (!template) errors.push("Modèle de document inconnu.")
  const primary = normalizeHex(input.primary)
  const secondary = normalizeHex(input.secondary)
  if (!primary) errors.push("Couleur principale invalide (format attendu : #1a2b3c).")
  if (!secondary) errors.push("Couleur secondaire invalide (format attendu : #1a2b3c).")
  if (primary && contrastRatio(primary, "#ffffff") < MIN_CONTRAST) errors.push("Couleur principale trop claire : le texte blanc posé dessus serait illisible. Choisissez une teinte plus foncée.")
  if (secondary && contrastRatio(secondary, "#ffffff") < MIN_CONTRAST) errors.push("Couleur secondaire trop claire : les totaux seraient illisibles sur fond blanc. Choisissez une teinte plus foncée.")
  if (errors.length > 0 || !template || !primary || !secondary || !layout) return { ok: false, errors }
  return { ok: true, design: { template, primary, secondary, layout, showClientIds: input.showClientIds, showBankDetails: input.showBankDetails } }
}

/** Valeurs brutes lues en base (colonnes nullables d'un document, ou réglage de la société). */
export interface StoredDesign {
  pdfTemplate: string | null; pdfPrimaryColor: string | null; pdfSecondaryColor: string | null
  pdfLayout: string | null; pdfShowClientIds: boolean | null; pdfShowBankDetails: boolean | null
}

/**
 * Design stocké → design valide, ou null si absent / incomplet / invalide (une valeur corrompue ne casse jamais un PDF :
 * le niveau suivant de la résolution s'applique). Un choix de document est TOUT OU RIEN : modèle renseigné ⇒ choix complet.
 */
export function designFromStored(s: StoredDesign | null | undefined): PdfDesign | null {
  if (!s || !s.pdfTemplate || !s.pdfPrimaryColor || !s.pdfSecondaryColor) return null
  const v = validateDesign({
    template: s.pdfTemplate, primary: s.pdfPrimaryColor, secondary: s.pdfSecondaryColor,
    layout: s.pdfLayout ?? DEFAULT_PDF_DESIGN.layout, showClientIds: s.pdfShowClientIds ?? DEFAULT_PDF_DESIGN.showClientIds, showBankDetails: s.pdfShowBankDetails ?? DEFAULT_PDF_DESIGN.showBankDetails,
  })
  return v.ok ? v.design : null
}

/** Design effectif d'un brouillon : choix du document, sinon réglage de la société, sinon défaut historique. */
export function resolveDesign(documentChoice: StoredDesign | null | undefined, companySetting: StoredDesign | null | undefined): PdfDesign {
  return designFromStored(documentChoice) ?? designFromStored(companySetting) ?? DEFAULT_PDF_DESIGN
}

/** Design figé dans un snapshot (JSON) : lu défensivement ; absent (snapshot antérieur aux modèles) ⇒ défaut historique. */
export function designFromSnapshot(raw: unknown): PdfDesign {
  if (!raw || typeof raw !== "object") return DEFAULT_PDF_DESIGN
  const r = raw as Record<string, unknown>
  if (typeof r.template !== "string" || typeof r.primary !== "string" || typeof r.secondary !== "string") return DEFAULT_PDF_DESIGN
  const v = validateDesign({
    template: r.template, primary: r.primary, secondary: r.secondary,
    layout: typeof r.layout === "string" ? r.layout : DEFAULT_PDF_DESIGN.layout,
    showClientIds: typeof r.showClientIds === "boolean" ? r.showClientIds : DEFAULT_PDF_DESIGN.showClientIds,
    showBankDetails: typeof r.showBankDetails === "boolean" ? r.showBankDetails : DEFAULT_PDF_DESIGN.showBankDetails,
  })
  return v.ok ? v.design : DEFAULT_PDF_DESIGN
}

/** Colonnes d'un design complet, typées pour l'écriture en base (énumérations Prisma PdfTemplate / PdfLayout). */
export interface DesignColumns {
  pdfTemplate: PdfTemplate; pdfPrimaryColor: string; pdfSecondaryColor: string
  pdfLayout: PdfLayout; pdfShowClientIds: boolean; pdfShowBankDetails: boolean
}

export function designToStored(d: PdfDesign): DesignColumns {
  return { pdfTemplate: d.template, pdfPrimaryColor: d.primary, pdfSecondaryColor: d.secondary, pdfLayout: d.layout, pdfShowClientIds: d.showClientIds, pdfShowBankDetails: d.showBankDetails }
}



/** Quantité affichée équivalente à 1 (« 1 », « 1,00 », « 1.0 »). */
function isOne(q: string): boolean {
  const n = q.trim().replace(",", ".")
  return /^1(\.0+)?$/.test(n)
}

/** Format « Rapide » applicable : au moins une ligne, toutes de quantité 1 et sans remise. */
export function quickLayoutAllowed(lines: readonly { quantity: string; discount: string }[]): boolean {
  return lines.length > 0 && lines.every((l) => isOne(l.quantity) && l.discount.trim() === "")
}

/** Format réellement rendu : « Rapide » demandé mais non applicable ⇒ « Complet ». */
export function effectiveLayout(design: PdfDesign, lines: readonly { quantity: string; discount: string }[]): PdfLayout {
  return design.layout === "QUICK" && quickLayoutAllowed(lines) ? "QUICK" : "COMPLETE"
}

const CLIENT_ID_LINE = /^(SIRET|SIREN|Identifiant|TVA intracommunautaire)\b/

/** Lignes d'identité du client à afficher selon l'option (adresse et e-mail toujours conservés). */
export function buyerLinesFor(lines: readonly string[], showClientIds: boolean): string[] {
  return showClientIds ? [...lines] : lines.filter((l) => !CLIENT_ID_LINE.test(l))
}

/** Mention « Règlement par virement : IBAN … » des factures, remplacée par l'encadré quand il est affiché. */
export const BANK_MENTION = /^Règlement par virement : IBAN /

/** Tampon de statut affiché sur les modèles récents (calculé à chaque rendu, jamais figé). */
export interface PdfStamp { label: string; tone: "success" | "danger" }

export function invoiceStamp(status: string, kind: string): PdfStamp | null {
  if (kind === "CREDIT_NOTE") return null
  if (status === "PAID") return { label: "Payée", tone: "success" }
  if (status === "CANCELLED") return { label: "Annulée", tone: "danger" }
  return null
}
