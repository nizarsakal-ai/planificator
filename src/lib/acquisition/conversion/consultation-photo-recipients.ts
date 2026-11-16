/**
 * Destinataires des photos d'un chantier issu d'une consultation.
 *
 * Le contact extrait de la consultation (nom + e-mail) puis l'expéditeur de l'e-mail
 * deviennent les destinataires initiaux : ce sont les interlocuteurs du donneur d'ordre
 * pour ce chantier. AUCUN envoi automatique (contrat LOT-PHOTO-RECIPIENTS inchangé) :
 * la liste reste modifiable par un Super Admin.
 *
 * Fonction pure : normalisation identique à l'éditeur (`normalizeRecipientEmail`),
 * dédoublonnage insensible à la casse, adresses techniques (no-reply…) exclues.
 */

import {
  normalizeRecipientEmail,
  PHOTO_RECIPIENT_LABEL_MAX,
  type PhotoRecipientInput,
} from "@/lib/chantiers/photo-recipients"

/** Boîtes techniques auxquelles on n'envoie jamais de photos. */
const TECHNICAL_LOCAL_PART =
  /^(no[-._]?reply|do[-._]?not[-._]?reply|ne[-._]?pas[-._]?repondre|mailer[-._]?daemon|postmaster|notifications?|bounce[s]?)([-._+].*)?$/i

function normalizeLabel(raw: string | null | undefined): string | null {
  const label = (raw ?? "").replace(/\s+/g, " ").trim()
  if (!label) return null
  return label.length > PHOTO_RECIPIENT_LABEL_MAX
    ? label.slice(0, PHOTO_RECIPIENT_LABEL_MAX).trim()
    : label
}

function usableEmail(raw: string | null | undefined): string | null {
  const email = raw ? normalizeRecipientEmail(raw) : null
  if (!email) return null
  const local = email.slice(0, email.indexOf("@"))
  return TECHNICAL_LOCAL_PART.test(local) ? null : email
}

export function consultationPhotoRecipients(input: {
  contactName?: string | null
  contactEmail?: string | null
  senderEmail?: string | null
}): PhotoRecipientInput[] {
  const out: PhotoRecipientInput[] = []
  const seen = new Set<string>()
  const push = (email: string | null, label: string | null) => {
    if (!email) return
    const key = email.toLowerCase()
    if (seen.has(key)) return
    seen.add(key)
    out.push({ label, email, active: true })
  }
  push(usableEmail(input.contactEmail), normalizeLabel(input.contactName))
  push(usableEmail(input.senderEmail), "Expéditeur de la consultation")
  return out
}
