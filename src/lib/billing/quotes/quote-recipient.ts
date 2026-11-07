// ═══════════════════════════════════════════════════════════════════════════
// V2 06/11/2026 — destinataire des devis (module PUR, sans base) : validation du destinataire saisi et propositions.
// Règles :
//  • le contact proposé est celui EXTRAIT de la consultation d'origine (demandeur réel), jamais l'expéditeur technique du message
//    (envoi automatique, transfert, plateforme) ; une adresse absente n'est JAMAIS inventée (nom seul ⇒ e-mail à saisir) ;
//  • l'adresse principale du client (Client.email, utilisée par la facturation) reste distincte : elle n'est qu'un choix possible ;
//  • contact absent ou ambigu ⇒ aucune proposition imposée : sélection d'un contact existant ou saisie libre ;
//  • rien n'est envoyé ici : l'envoi exige une confirmation explicite (action serveur).
// ═══════════════════════════════════════════════════════════════════════════
import { z } from "zod"

export const RECIPIENT_SOURCES = ["CONSULTATION", "PREVIOUS", "CLIENT", "MANUAL"] as const
export type RecipientSource = (typeof RECIPIENT_SOURCES)[number]

export const RECIPIENT_SOURCE_LABEL: Record<RecipientSource, string> = {
  CONSULTATION: "Contact à l'origine de la demande",
  PREVIOUS: "Destinataire d'un devis précédent de ce client",
  CLIENT: "Adresse principale du client",
  MANUAL: "Saisie manuelle",
}

export const RECIPIENT_ERRORS = {
  emailRequired: "Indiquez l'adresse e-mail du destinataire.",
  emailInvalid: "Adresse e-mail du destinataire invalide.",
  nameTooLong: "Nom du destinataire trop long (120 caractères au plus).",
  invalid: "Destinataire invalide.",
} as const

const CONTROL = /[\u0000-\u001f\u007f]/
// Forme volontairement stricte (un seul @, domaine avec point, aucun espace ni chevron) : l'adresse est utilisée telle quelle.
const EMAIL = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/

export interface Recipient { name: string | null; email: string }

/** Normalise une adresse : espaces retirés, domaine en minuscules ; null si la forme est invalide. */
export function normalizeEmail(raw: unknown): string | null {
  if (typeof raw !== "string") return null
  const v = raw.trim()
  if (v.length < 3 || v.length > 254 || CONTROL.test(v) || !EMAIL.test(v)) return null
  const at = v.lastIndexOf("@")
  const local = v.slice(0, at)
  if (local.length > 64 || local.startsWith(".") || local.endsWith(".") || local.includes("..")) return null
  return `${local}@${v.slice(at + 1).toLowerCase()}`
}

/** Clé de comparaison (insensible à la casse). */
export const emailKey = (email: string) => email.trim().toLowerCase()

export function normalizeRecipientName(raw: unknown): { ok: true; value: string | null } | { ok: false; error: string } {
  if (raw === undefined || raw === null) return { ok: true, value: null }
  if (typeof raw !== "string") return { ok: false, error: RECIPIENT_ERRORS.invalid }
  const v = raw.replace(/\s+/g, " ").trim()
  if (CONTROL.test(raw.replace(/[\t\n\r]/g, " "))) return { ok: false, error: RECIPIENT_ERRORS.invalid }
  if (v.length > 120) return { ok: false, error: RECIPIENT_ERRORS.nameTooLong }
  return { ok: true, value: v || null }
}

const recipientInputSchema = z.object({
  name: z.string().max(400).nullable().optional(),
  email: z.string().max(400),
  source: z.enum(RECIPIENT_SOURCES),
}).strict()

export interface ConfirmedRecipient extends Recipient { source: RecipientSource }

/** Validation de la saisie confirmée par l'utilisateur (dialogue d'envoi) : e-mail obligatoire et valide, nom facultatif. */
export function parseRecipientInput(raw: unknown): { ok: true; value: ConfirmedRecipient } | { ok: false; error: string } {
  const r = recipientInputSchema.safeParse(raw)
  if (!r.success) return { ok: false, error: RECIPIENT_ERRORS.invalid }
  if (!r.data.email.trim()) return { ok: false, error: RECIPIENT_ERRORS.emailRequired }
  const email = normalizeEmail(r.data.email)
  if (!email) return { ok: false, error: RECIPIENT_ERRORS.emailInvalid }
  const name = normalizeRecipientName(r.data.name)
  if (!name.ok) return name
  return { ok: true, value: { name: name.value, email, source: r.data.source } }
}

export interface RecipientCandidate { name: string | null; email: string; source: Exclude<RecipientSource, "MANUAL"> }

export type RecipientIdentification =
  | "LAST_SENT"      // renvoi : destinataire effectif du dernier envoi
  | "CONSULTATION"   // contact de la demande identifié avec une adresse valide
  | "NAME_ONLY"      // demandeur identifié par son nom, sans adresse fiable : l'adresse est à saisir (jamais inventée)
  | "SINGLE_KNOWN"   // pas de consultation ; un seul contact connu
  | "AMBIGUOUS"      // plusieurs contacts possibles : choix explicite requis
  | "ABSENT"         // aucun contact : saisie manuelle

export interface RecipientSuggestionInput {
  /** Destinataire effectif du dernier envoi (renvoi). */
  lastSent: { name: string | null; email: string | null } | null
  /** Contact extrait de la consultation d'origine du chantier (WorksiteImportDraft.proposedContact*). */
  consultation: { contactName: string | null; contactEmail: string | null; senderEmail: string | null } | null
  /** Adresse principale du client (Client.email) — distincte du destinataire, jamais modifiée. */
  client: { name: string; email: string | null }
  /** Destinataires effectifs d'autres devis du même client (même société), du plus récent au plus ancien. */
  previous: { name: string | null; email: string }[]
}

export interface RecipientSuggestions {
  identification: RecipientIdentification
  /** Proposition pré-remplie (toujours modifiable) ; null ⇒ choix ou saisie requis. */
  proposed: { name: string | null; email: string | null; source: RecipientSource } | null
  candidates: RecipientCandidate[]
  /** Informations affichées à l'utilisateur (ex. expéditeur technique distinct du demandeur). */
  notices: string[]
}

export function buildRecipientSuggestions(input: RecipientSuggestionInput): RecipientSuggestions {
  const notices: string[] = []
  const candidates: RecipientCandidate[] = []
  const seen = new Set<string>()
  const add = (c: RecipientCandidate) => { const k = emailKey(c.email); if (seen.has(k)) return; seen.add(k); candidates.push(c) }

  const consultationName = input.consultation ? normalizeRecipientName(input.consultation.contactName) : null
  const contactName = consultationName && consultationName.ok ? consultationName.value : null
  const contactEmail = input.consultation ? normalizeEmail(input.consultation.contactEmail) : null
  const senderEmail = input.consultation ? normalizeEmail(input.consultation.senderEmail) : null
  if (contactEmail) add({ name: contactName, email: contactEmail, source: "CONSULTATION" })
  for (const p of input.previous) {
    const e = normalizeEmail(p.email)
    if (!e) continue
    const n = normalizeRecipientName(p.name)
    add({ name: n.ok ? n.value : null, email: e, source: "PREVIOUS" })
  }
  const clientEmail = normalizeEmail(input.client.email)
  if (clientEmail) add({ name: input.client.name, email: clientEmail, source: "CLIENT" })

  if (input.consultation?.contactEmail && !contactEmail) notices.push("L'adresse extraite de la demande n'a pas une forme valide : elle n'est pas proposée.")
  if (senderEmail && (!contactEmail || emailKey(senderEmail) !== emailKey(contactEmail))) {
    notices.push("Le message d'origine a été reçu d'une autre adresse (envoi automatique, plateforme ou transfert possible) : elle n'est pas proposée comme destinataire.")
  }
  if (clientEmail) notices.push("L'adresse principale du client n'est pas modifiée par l'envoi ; elle reste utilisée par la facturation.")

  // Renvoi : on repart du destinataire effectif précédent (modifiable).
  const lastEmail = input.lastSent ? normalizeEmail(input.lastSent.email) : null
  if (lastEmail) {
    const lastName = normalizeRecipientName(input.lastSent?.name)
    const known = candidates.find((c) => emailKey(c.email) === emailKey(lastEmail))
    return { identification: "LAST_SENT", proposed: { name: lastName.ok ? lastName.value : null, email: lastEmail, source: known?.source ?? "MANUAL" }, candidates, notices }
  }
  if (contactEmail) return { identification: "CONSULTATION", proposed: { name: contactName, email: contactEmail, source: "CONSULTATION" }, candidates, notices }
  if (contactName) {
    // Demandeur connu par son nom seulement : l'adresse est à saisir ou à choisir (une homonymie n'est jamais résolue automatiquement).
    notices.push(`Le demandeur identifié est ${contactName}, mais aucune adresse fiable n'a été trouvée : saisissez-la ou choisissez un contact existant.`)
    return { identification: "NAME_ONLY", proposed: { name: contactName, email: null, source: "MANUAL" }, candidates, notices }
  }
  if (candidates.length === 0) return { identification: "ABSENT", proposed: null, candidates, notices }
  if (candidates.length === 1) { const c = candidates[0]; return { identification: "SINGLE_KNOWN", proposed: { name: c.name, email: c.email, source: c.source }, candidates, notices } }
  return { identification: "AMBIGUOUS", proposed: null, candidates, notices }
}
