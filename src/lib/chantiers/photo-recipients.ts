/**
 * Destinataires des photos d'un chantier — lecture PURE du champ de formulaire `photoRecipients`.
 * Contrat : docs/specs/worksite-photos/LOT-PHOTO-RECIPIENTS.md. AUCUN envoi automatique.
 *
 * Le formulaire envoie UN champ texte contenant une liste JSON `[{ label, email, active }]` :
 * - champ ABSENT ⇒ `absent` : la configuration existante est conservée (aucune écriture des destinataires) ;
 * - liste vide `[]` ⇒ `set` vide : effacement explicite de la configuration ;
 * - liste valide ⇒ `set` normalisé (trim, nom/fonction vide ⇒ null, ordre = position).
 * Refus (`invalid`) sans aucune écriture : champ répété, fichier, JSON invalide ou trop volumineux, plus de 20 lignes,
 * forme inconnue, e-mail invalide ou multiple, nom/fonction > 120, adresse en double (insensible à la casse).
 * Les messages citent le numéro de ligne, jamais l'adresse. Aucune reprise de l'adresse comptable du client.
 */
import { z } from "zod"

export const PHOTO_RECIPIENTS_FIELD = "photoRecipients"
export const PHOTO_RECIPIENTS_MAX = 20
export const PHOTO_RECIPIENT_LABEL_MAX = 120
export const PHOTO_RECIPIENT_EMAIL_MAX = 254
const PAYLOAD_MAX_BYTES = 16 * 1024

export const PHOTO_RECIPIENTS_FORBIDDEN = "Seul un Super Admin peut modifier les destinataires des photos."
export const PHOTO_RECIPIENTS_INVALID = "Destinataires des photos invalides."

export interface PhotoRecipientInput { label: string | null; email: string; active: boolean }

export type PhotoRecipientsField =
  | { kind: "absent" }
  | { kind: "set"; recipients: PhotoRecipientInput[] }
  | { kind: "invalid"; message: string }

const rowSchema = z.object({
  label: z.string().nullable().optional(),
  email: z.string(),
  active: z.boolean(),
}).strict()

const emailSchema = z.string().max(PHOTO_RECIPIENT_EMAIL_MAX).email()

/** Une seule adresse e-mail, trimée, ≤ 254 ; `null` si invalide. */
export function normalizeRecipientEmail(raw: string): string | null {
  const email = raw.trim()
  if (email.length === 0 || /[\s,;<>]/.test(email) || !emailSchema.safeParse(email).success) return null
  return email
}

export function readPhotoRecipientsField(formData: FormData): PhotoRecipientsField {
  const values = formData.getAll(PHOTO_RECIPIENTS_FIELD)
  if (values.length === 0) return { kind: "absent" }
  const invalid = (message = PHOTO_RECIPIENTS_INVALID): PhotoRecipientsField => ({ kind: "invalid", message })
  if (values.length > 1 || typeof values[0] !== "string") return invalid()
  if (new TextEncoder().encode(values[0]).byteLength > PAYLOAD_MAX_BYTES) return invalid()
  let parsed: unknown
  try { parsed = JSON.parse(values[0]) } catch { return invalid() }
  if (!Array.isArray(parsed)) return invalid()
  if (parsed.length > PHOTO_RECIPIENTS_MAX) return invalid(`${PHOTO_RECIPIENTS_MAX} destinataires au plus par chantier.`)
  const recipients: PhotoRecipientInput[] = []
  const seen = new Set<string>()
  for (let i = 0; i < parsed.length; i++) {
    const row = rowSchema.safeParse(parsed[i])
    if (!row.success) return invalid()
    const email = normalizeRecipientEmail(row.data.email)
    if (!email) return invalid(`Destinataire ${i + 1} : e-mail invalide (une seule adresse, ${PHOTO_RECIPIENT_EMAIL_MAX} caractères au plus).`)
    const key = email.toLowerCase()
    if (seen.has(key)) return invalid(`Destinataire ${i + 1} : adresse déjà présente dans la liste.`)
    seen.add(key)
    const label = row.data.label?.trim() ?? ""
    if (label.length > PHOTO_RECIPIENT_LABEL_MAX) return invalid(`Destinataire ${i + 1} : nom ou fonction trop long (${PHOTO_RECIPIENT_LABEL_MAX} caractères au plus).`)
    recipients.push({ label: label.length > 0 ? label : null, email, active: row.data.active })
  }
  return { kind: "set", recipients }
}

// ─── État initial du formulaire (compatibilité de l'adresse historique) ──────

export interface PhotoRecipientRow { label: string; email: string; active: boolean }

/**
 * État initial de l'éditeur. L'adresse historique `clientContact` n'est jamais préremplie ni enregistrée d'office : elle
 * n'est que SUGGÉRÉE (bouton explicite « Ajouter comme destinataire ») et seulement si la liste n'a JAMAIS été configurée
 * (`configuredAt` nul). Une fois configurée — même vide, même entièrement inactive — elle n'est plus jamais suggérée ni
 * utilisée comme destinataire. Le formulaire n'envoie la liste que si elle a été modifiée (sinon champ absent ⇒ conservée).
 */
export function initialRecipientState(input: {
  recipients: Array<{ label: string | null; email: string; active: boolean }>
  configuredAt: Date | string | null
  clientContact: string | null
}): { rows: PhotoRecipientRow[]; historicSuggestion: string | null } {
  const rows = input.recipients.map((r) => ({ label: r.label ?? "", email: r.email, active: r.active }))
  if (input.configuredAt !== null) return { rows, historicSuggestion: null }
  const historic = input.clientContact ? normalizeRecipientEmail(input.clientContact) : null
  return { rows, historicSuggestion: historic }
}
