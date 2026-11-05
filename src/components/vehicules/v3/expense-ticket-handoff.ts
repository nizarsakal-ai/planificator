/**
 * Passage « ticket lu dans Documents → dépense préremplie » : brouillon ÉPHÉMÈRE en sessionStorage (même origine,
 * même onglet), lu une seule fois, valable quelques minutes, rattaché à la société, au camion et à la version exacte du
 * justificatif. Seules des valeurs structurées y figurent (jamais le texte lu, jamais d'observations) ; l'URL ne porte
 * qu'un identifiant opaque. Tout écart (absent, périmé, autre camion ou société, justificatif non proposé) : rien
 * n'est appliqué. La dépense n'est jamais créée automatiquement : l'opérateur vérifie puis valide.
 */
import type { ExpenseReading, RecognitionConfidence } from "@/lib/vehicules/v3/document-recognition-domain"

export const TICKET_DRAFT_TTL_MS = 10 * 60_000
const PREFIX = "planificator:expense-ticket-draft:"
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** Champs du formulaire de dépense remplis depuis le ticket. */
export type TicketFieldName = "category" | "date" | "amount" | "currency" | "litres" | "mileage" | "supplier" | "reference"
export interface TicketValues {
  values: Partial<Record<TicketFieldName, string>>
  /** « READ » (lu à côté de son libellé) ou « TO_CHECK » (déduit, ou TTC non indiqué) par champ rempli. */
  confidence: Partial<Record<TicketFieldName, RecognitionConfidence>>
  /** Valeurs lues mais non reprises, et pourquoi (devise absente ou contradictoire). */
  warnings: string[]
}

const amountFr = (value: string) => `${value} (montant lu)`

/**
 * Valeurs de dépense depuis un ticket lu. Montant repris seulement avec UNE devise lue sur le ticket (aucune devise
 * supposée, aucune conversion) ; total sans mention TTC repris « à vérifier ». Catégorie Carburant et litres seulement
 * si le ticket nomme un carburant ; sinon catégorie « Autres » à vérifier, jamais Carburant par défaut.
 */
export function ticketExpenseValues(reading: ExpenseReading): TicketValues {
  const out: TicketValues = { values: {}, confidence: {}, warnings: [] }
  const put = (name: TicketFieldName, value: string, confidence: RecognitionConfidence) => { out.values[name] = value; out.confidence[name] = confidence }
  if (reading.refund) out.warnings.push("Avoir ou remboursement : ce n'est pas une dépense. Montant et litres non repris ; à traiter séparément.")
  if (reading.amount && !reading.refund) {
    if (reading.currency.status === "READ" && reading.currency.value) {
      put("amount", reading.amount.value, reading.amount.ttc ? reading.amount.confidence : "TO_CHECK")
      put("currency", reading.currency.value, reading.amount.confidence)
      if (!reading.amount.ttc) out.warnings.push("Le ticket ne précise pas que le montant est TTC : vérifiez-le.")
    } else out.warnings.push(reading.currency.status === "CONFLICT"
      ? `Plusieurs devises sur le ticket : montant non repris, ${amountFr(reading.amount.value)}. Saisissez-le avec sa devise.`
      : reading.currency.status === "AMBIGUOUS"
        ? `Symbole $ sans pays sur le ticket (dollar américain, canadien… ?) : montant non repris, ${amountFr(reading.amount.value)}. Saisissez-le avec sa devise.`
        : `Devise absente du ticket : montant non repris, ${amountFr(reading.amount.value)}. Vérifiez la devise puis saisissez-le.`)
  }
  if (reading.fuel) {
    put("category", "FUEL", reading.litres?.confidence ?? "TO_CHECK")
    if (reading.litres && !reading.refund) put("litres", reading.litres.value, reading.litres.confidence)
  } else put("category", "OTHER", "TO_CHECK")
  if (reading.date) put("date", reading.date.value, reading.date.confidence)
  if (reading.supplier) put("supplier", reading.supplier.value.slice(0, 200), reading.supplier.confidence)
  if (reading.reference) put("reference", reading.reference.value.slice(0, 200), reading.reference.confidence)
  if (reading.mileage) put("mileage", String(reading.mileage.value), reading.mileage.confidence)
  return out
}

const DOCUMENT_FIELDS = [["issuedOn", "date"], ["issuerName", "supplier"], ["referenceNumber", "reference"], ["mileage", "mileage"]] as const

/**
 * Corrections faites à la main dans le formulaire de la pièce avant son enregistrement : la valeur ENREGISTRÉE de
 * l'opérateur remplace la lecture (sans marque « lu ») ; un champ vidé à la main n'est pas repris.
 */
export function withDocumentCorrections(ticket: TicketValues, saved: { issuedOn: string | null; issuerName: string | null; referenceNumber: string | null; mileage: number | null }, touched: ReadonlySet<string>): TicketValues {
  const out: TicketValues = { values: { ...ticket.values }, confidence: { ...ticket.confidence }, warnings: [...ticket.warnings] }
  for (const [docKey, name] of DOCUMENT_FIELDS) {
    if (!touched.has(docKey)) continue
    const value = saved[docKey]
    delete out.confidence[name]
    if (value === null || value === "") delete out.values[name]
    else out.values[name] = String(value).slice(0, 200)
  }
  return out
}

export interface TicketDraft extends TicketValues {
  v: 1
  id: string
  companyId: string
  truckId: string
  documentId: string
  versionId: string
  createdAt: number
}

export interface DraftStorage { getItem(key: string): string | null; setItem(key: string, value: string): void; removeItem(key: string): void; readonly length: number; key(index: number): string | null }

/** Enregistre le brouillon (et purge les brouillons périmés) ; rend l'identifiant opaque à mettre dans l'URL. */
export function saveTicketDraft(storage: DraftStorage, draft: Omit<TicketDraft, "v" | "createdAt">, now: number): string {
  if (!ID.test(draft.id)) throw new Error("INVALID_DRAFT_ID")
  purgeTicketDrafts(storage, now)
  storage.setItem(PREFIX + draft.id, JSON.stringify({ ...draft, v: 1, createdAt: now } satisfies TicketDraft))
  return draft.id
}

export function purgeTicketDrafts(storage: DraftStorage, now: number) {
  const keys: string[] = []
  for (let i = 0; i < storage.length; i++) { const k = storage.key(i); if (k?.startsWith(PREFIX)) keys.push(k) }
  for (const k of keys) {
    const draft = parseTicketDraft(storage.getItem(k) ?? "", k.slice(PREFIX.length))
    if (!draft || !(now - draft.createdAt >= 0 && now - draft.createdAt <= TICKET_DRAFT_TTL_MS)) storage.removeItem(k)
  }
}

export type DraftRefusal = "MISSING" | "EXPIRED" | "SCOPE" | "INVALID"
export type TakenDraft = { ok: true; draft: TicketDraft } | { ok: false; reason: DraftRefusal }

/** Taille maximale acceptée d'un brouillon (valeurs structurées seulement). */
export const TICKET_DRAFT_MAX_BYTES = 8 * 1024
const OPAQUE = /^[A-Za-z0-9_-]{1,200}$/
const isDay = (v: string) => { if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return false; const t = new Date(`${v}T00:00:00.000Z`); return Number.isFinite(t.getTime()) && t.toISOString().slice(0, 10) === v }
/** Propriété PROPRE (jamais héritée : « __proto__ », « constructor », « toString » ne sont pas des champs). */
const own = (o: object, key: string) => Object.prototype.hasOwnProperty.call(o, key)
const plainText = (v: string) => v.length <= 200 && !/[\u0000-\u001f\u007f]/.test(v)
/** Format accepté par champ : mêmes motifs que le formulaire de dépense (le serveur revalide tout à l'envoi). */
const FIELD_FORMAT: Record<TicketFieldName, (v: string) => boolean> = {
  category: (v) => ["FUEL", "MAINTENANCE", "INSURANCE", "OTHER"].includes(v),
  date: isDay,
  amount: (v) => /^\d{1,9}([.,]\d{1,2})?$/.test(v),
  currency: (v) => /^[A-Z]{3}$/.test(v),
  litres: (v) => /^\d{1,4}([.,]\d{1,3})?$/.test(v),
  mileage: (v) => /^\d{1,7}$/.test(v),
  supplier: plainText,
  reference: plainText,
}
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v)

/**
 * Structure d'un brouillon relu du navigateur, vérifiée champ par champ (rien n'est pris sur parole) : identifiants,
 * date de création, champs autorisés et leurs formats, niveaux de lecture, avertissements bornés. Le navigateur n'a
 * aucune autorité comptable : ces valeurs ne font que préremplir un formulaire que le serveur revalide à l'envoi.
 */
export function parseTicketDraft(raw: string, id: string): TicketDraft | null {
  if (raw.length > TICKET_DRAFT_MAX_BYTES) return null
  let data: unknown
  try { data = JSON.parse(raw) } catch { return null }
  if (!isRecord(data) || data.v !== 1 || data.id !== id || typeof data.createdAt !== "number" || !Number.isFinite(data.createdAt)) return null
  const ids = [data.companyId, data.truckId, data.documentId, data.versionId]
  if (!ids.every((v): v is string => typeof v === "string" && OPAQUE.test(v))) return null
  if (!isRecord(data.values) || !isRecord(data.confidence) || !Array.isArray(data.warnings) || data.warnings.length > 5) return null
  // Objets sans prototype : une clé « __proto__ » validée par erreur ne pourrait jamais en changer le prototype.
  const values: TicketValues["values"] = Object.create(null), confidence: TicketValues["confidence"] = Object.create(null)
  for (const [name, value] of Object.entries(data.values)) {
    if (!own(FIELD_FORMAT, name) || typeof value !== "string" || !FIELD_FORMAT[name as TicketFieldName](value)) return null
    values[name as TicketFieldName] = value
  }
  for (const [name, level] of Object.entries(data.confidence)) {
    if (!own(values, name) || (level !== "READ" && level !== "TO_CHECK")) return null
    confidence[name as TicketFieldName] = level
  }
  // Montant et devise vont ensemble : un montant sans sa devise n'est pas un brouillon valable.
  if (own(values, "amount") !== own(values, "currency")) return null
  const warnings: string[] = []
  for (const w of data.warnings) { if (typeof w !== "string" || w.length > 300) return null; warnings.push(w) }
  const [companyId, truckId, documentId, versionId] = ids as string[]
  return { v: 1, id, companyId, truckId, documentId, versionId, createdAt: data.createdAt, values: { ...values }, confidence: { ...confidence }, warnings }
}

/** Lecture UNIQUE : le brouillon est supprimé dès la lecture, qu'il soit valable, mal formé ou non. */
export function takeTicketDraft(storage: DraftStorage, input: { id: string; companyId: string; truckId: string; now: number }): TakenDraft {
  if (!ID.test(input.id)) return { ok: false, reason: "MISSING" }
  const key = PREFIX + input.id
  const raw = storage.getItem(key)
  storage.removeItem(key)
  if (!raw) return { ok: false, reason: "MISSING" }
  const draft = parseTicketDraft(raw, input.id)
  if (!draft) return { ok: false, reason: "INVALID" }
  const age = input.now - draft.createdAt
  if (!(age >= 0 && age <= TICKET_DRAFT_TTL_MS)) return { ok: false, reason: "EXPIRED" }
  if (draft.companyId !== input.companyId || draft.truckId !== input.truckId) return { ok: false, reason: "SCOPE" }
  return { ok: true, draft }
}

/** Justificatif proposé dans la liste du formulaire (version COURANTE d'un dossier non archivé de ce camion). */
export function draftDocumentAllowed(draft: Pick<TicketDraft, "documentId" | "versionId">, documents: readonly { id: string; archivedAt?: string | null; currentVersion: { id: string } | null }[]): boolean {
  return documents.some((d) => d.id === draft.documentId && !d.archivedAt && d.currentVersion?.id === draft.versionId)
}

/**
 * Messages d'échec : la lecture est éphémère et ne peut pas être reprise. L'action proposée est réelle : saisir la
 * dépense à partir du ticket et choisir le justificatif déjà enregistré dans la liste.
 */
const MANUAL = "Saisissez la dépense à partir du ticket et choisissez son justificatif dans la liste."
export function ticketDraftError(reason: DraftRefusal | "DOCUMENT" | "LINK_CHOSEN"): string {
  switch (reason) {
    case "EXPIRED": return `La lecture du ticket a expiré (plus de 10 minutes) : rien n'a été prérempli. ${MANUAL}`
    case "SCOPE": return `Cette lecture de ticket concerne un autre véhicule : rien n'a été prérempli. ${MANUAL}`
    case "DOCUMENT": return `Le justificatif lu n'est plus disponible pour ce véhicule : rien n'a été prérempli. ${MANUAL}`
    case "INVALID": return `La lecture du ticket est illisible : rien n'a été prérempli. ${MANUAL}`
    case "LINK_CHOSEN": return "Vous aviez déjà choisi un autre justificatif : la lecture du ticket n'a pas été reprise et votre choix est conservé."
    default: return `La lecture du ticket n'est plus disponible (page rechargée ou déjà utilisée) : rien n'a été prérempli. ${MANUAL}`
  }
}

/** Formulaire minimal (DOM réel ou double de test). */
export interface TicketForm { elements: { namedItem(name: string): unknown } }
type Control = { value: string }
const controlOf = (form: TicketForm, name: string) => form.elements.namedItem(name) as Control | null

/**
 * Applique un brouillon au formulaire : un champ déjà saisi par l'opérateur (même pendant le chargement) n'est jamais
 * remplacé ; un justificatif déjà choisi à la main, s'il diffère, bloque toute reprise (les valeurs du ticket A ne sont
 * jamais associées au justificatif B). Montant et devise forment un COUPLE : si l'un des deux a été saisi à la main,
 * le montant du ticket n'est repris que dans la même devise, et la devise n'est jamais changée sous un montant saisi
 * (aucune conversion implicite). Rend les champs écrits (possédés par le ticket), ceux conservés et les avertissements.
 */
export function applyTicketDraft(form: TicketForm, draft: Pick<TicketDraft, "values" | "versionId">, touched: ReadonlySet<string>): { applied: false } | { applied: true; written: TicketFieldName[]; kept: TicketFieldName[]; warnings: string[] } {
  const link = controlOf(form, "documentVersionId")
  if (!link) return { applied: false }
  if (touched.has("documentVersionId") && link.value !== draft.versionId) return { applied: false }
  const written: TicketFieldName[] = [], kept: TicketFieldName[] = [], warnings: string[] = []
  const write = (name: TicketFieldName, value: string) => { const control = controlOf(form, name); if (control) { control.value = value; written.push(name) } }
  for (const [name, value] of Object.entries(draft.values) as [TicketFieldName, string][]) {
    if (name === "amount" || name === "currency" || !controlOf(form, name)) continue
    if (touched.has(name)) { kept.push(name); continue }
    write(name, value)
  }
  const amount = draft.values.amount, currency = draft.values.currency
  const amountControl = controlOf(form, "amount"), currencyControl = controlOf(form, "currency")
  if (amount !== undefined && currency !== undefined && amountControl && currencyControl) {
    const amountTouched = touched.has("amount"), currencyTouched = touched.has("currency")
    if (amountTouched) kept.push("amount")
    if (currencyTouched) kept.push("currency")
    if (!amountTouched && !currencyTouched) { write("amount", amount); write("currency", currency) }
    else if (!amountTouched && currencyControl.value === currency) write("amount", amount)
    else if (currencyControl.value !== currency) warnings.push(`Montant lu sur le ticket (${amount} ${currency}) non repris : la devise saisie (${currencyControl.value || "aucune"}) est différente et aucune conversion n'est faite. Vérifiez le couple montant et devise.`)
  }
  link.value = draft.versionId
  return { applied: true, written, kept, warnings }
}

/**
 * Justificatif changé après préremplissage (autre ticket ou « Aucun ») : les champs ENCORE possédés par le ticket
 * (valeur intacte) reviennent à leur valeur d'ouverture ; une correction de l'opérateur est conservée. Rend les champs
 * retirés. La devise du ticket reste en place tant qu'un montant (saisi à la main) en dépend : retirer la devise
 * changerait l'unité de ce montant.
 */
export function withdrawTicketFields(form: TicketForm, owned: readonly TicketFieldName[], values: TicketValues["values"], defaults: Partial<Record<TicketFieldName, string>>): TicketFieldName[] {
  const removed: TicketFieldName[] = []
  const release = (name: TicketFieldName) => {
    const control = controlOf(form, name)
    if (!control || control.value !== values[name]) return
    control.value = defaults[name] ?? ""
    removed.push(name)
  }
  for (const name of owned) if (name !== "currency") release(name)
  if (owned.includes("currency") && (controlOf(form, "amount")?.value ?? "") === "") release("currency")
  return removed
}

export const TICKET_FIELD_LABELS: Record<TicketFieldName, string> = { category: "catégorie", date: "date", amount: "montant", currency: "devise", litres: "litres", mileage: "compteur", supplier: "fournisseur", reference: "référence" }
