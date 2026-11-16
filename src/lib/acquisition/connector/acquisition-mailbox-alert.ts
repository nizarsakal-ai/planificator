/**
 * Alerte « boîte Gmail Consultations inaccessible » (incident 03→16/11/2026 : panne
 * silencieuse pendant 13 jours).
 *
 * Sans état dédié (pas de migration) : la décision d'envoi dérive du compteur
 * `consecutiveFailures` du curseur de scan, incrémenté une fois par run horaire.
 * → 1er envoi au 2e échec consécutif (évite d'alerter sur un incident passager),
 *   puis rappel toutes les 24 occurrences (~1 fois par jour) pendant 7 jours au plus
 *   (au-delà, la boîte est considérée abandonnée : plus de relance, l'état reste
 *   visible dans Paramètres et sur la page Consultations).
 */

import { prisma } from "@/lib/prisma"
import type { sendAcquisitionMailboxAlertEmail } from "@/lib/email"
import { safeInternalErrorCode } from "@/lib/acquisition/connector/acquisition-gmail-cron.errors"

export const MAILBOX_ALERT_FIRST_AT = 2
export const MAILBOX_ALERT_REPEAT_EVERY = 24
export const MAILBOX_ALERT_MAX_REMINDERS = 7

export function shouldSendMailboxAlert(consecutiveFailures: number): boolean {
  if (!Number.isInteger(consecutiveFailures) || consecutiveFailures < MAILBOX_ALERT_FIRST_AT) {
    return false
  }
  const sinceFirst = consecutiveFailures - MAILBOX_ALERT_FIRST_AT
  if (sinceFirst > MAILBOX_ALERT_REPEAT_EVERY * MAILBOX_ALERT_MAX_REMINDERS) return false
  return sinceFirst % MAILBOX_ALERT_REPEAT_EVERY === 0
}

export interface MailboxAlertDeps {
  listAdmins: (companyId: string) => Promise<Array<{ email: string }>>
  getCompanyName: (companyId: string) => Promise<string | null>
  sendEmail: typeof sendAcquisitionMailboxAlertEmail
  log?: (event: string, payload: Record<string, unknown>) => void
}

export const defaultMailboxAlertDeps: MailboxAlertDeps = {
  listAdmins: (companyId) =>
    prisma.user.findMany({
      where: { companyId, active: true, role: { in: ["ADMIN", "SUPER_ADMIN"] } },
      select: { email: true },
    }),
  getCompanyName: async (companyId) =>
    (await prisma.company.findUnique({ where: { id: companyId }, select: { name: true } }))?.name ??
    null,
  // Import paresseux : email.ts instancie Resend au chargement ; l'orchestrateur
  // (importé par de nombreux modules) ne doit pas en dépendre à l'import.
  sendEmail: async (input) => (await import("@/lib/email")).sendAcquisitionMailboxAlertEmail(input),
}

export interface MailboxAlertResult {
  sent: number
  failed: number
  skipped?: "NOT_DUE" | "NO_ADMIN"
}

/**
 * Best-effort : ne lève jamais (une panne d'e-mail ne doit pas casser la synchro).
 * Ne journalise ni adresse d'administrateur ni contenu.
 */
export async function notifyAcquisitionMailboxAccessLost(
  input: { companyId: string; gmailAddress: string; consecutiveFailures: number },
  deps: MailboxAlertDeps = defaultMailboxAlertDeps
): Promise<MailboxAlertResult> {
  const log = deps.log ?? ((event, payload) => console.warn(`[acquisition-mailbox-alert] ${event}`, payload))
  if (!shouldSendMailboxAlert(input.consecutiveFailures)) {
    return { sent: 0, failed: 0, skipped: "NOT_DUE" }
  }

  let admins: Array<{ email: string }>
  let companyName: string | null
  try {
    ;[admins, companyName] = await Promise.all([
      deps.listAdmins(input.companyId),
      deps.getCompanyName(input.companyId),
    ])
  } catch (e) {
    log("MAILBOX_ALERT_LOOKUP_FAILED", { companyId: input.companyId, internalCode: safeInternalErrorCode(e) })
    return { sent: 0, failed: 1 }
  }

  const recipients = [...new Set(admins.map((a) => a.email.trim().toLowerCase()).filter(Boolean))]
  if (recipients.length === 0) {
    log("MAILBOX_ALERT_NO_ADMIN", { companyId: input.companyId })
    return { sent: 0, failed: 0, skipped: "NO_ADMIN" }
  }

  let sent = 0
  let failed = 0
  for (const to of recipients) {
    try {
      await deps.sendEmail({
        to,
        gmailAddress: input.gmailAddress,
        companyName: companyName ?? "votre entreprise",
        consecutiveFailures: input.consecutiveFailures,
      })
      sent++
    } catch (e) {
      failed++
      log("MAILBOX_ALERT_SEND_FAILED", { companyId: input.companyId, internalCode: safeInternalErrorCode(e) })
    }
  }
  log("MAILBOX_ALERT_SENT", {
    companyId: input.companyId,
    gmailAddress: input.gmailAddress,
    consecutiveFailures: input.consecutiveFailures,
    sent,
    failed,
  })
  return { sent, failed }
}
