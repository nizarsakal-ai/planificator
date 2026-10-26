/**
 * Interface d'envoi des courriers de facturation (devis, factures, relances). Injectable : les tests utilisent
 * un enregistreur en mémoire ; en production, Resend n'est appelé que si BILLING_MAIL_ENABLED=true, sinon
 * le courrier est journalisé (BillingMailLog, statut SIMULATED) et jamais envoyé.
 */
import { isBillingMailEnabled } from "@/lib/billing/billing-feature-flag"

export interface BillingMailMessage {
  to: string
  subject: string
  html: string
  text: string
}

export interface BillingMailResult {
  status: "SIMULATED" | "SENT" | "FAILED"
  providerId?: string
  error?: string
}

export interface BillingMailer {
  readonly name: string
  send(message: BillingMailMessage): Promise<BillingMailResult>
}

/** Enregistreur : aucun envoi, conserve les messages (tests) et renvoie SIMULATED. */
export class RecordingMailer implements BillingMailer {
  readonly name = "recording"
  readonly sent: BillingMailMessage[] = []
  async send(message: BillingMailMessage): Promise<BillingMailResult> {
    this.sent.push(message)
    return { status: "SIMULATED" }
  }
}

/** Resend (clé RESEND_API_KEY) — chargé paresseusement, jamais en test. */
export class ResendMailer implements BillingMailer {
  readonly name = "resend"
  async send(message: BillingMailMessage): Promise<BillingMailResult> {
    try {
      const { Resend } = await import("resend")
      const key = process.env.RESEND_API_KEY
      if (!key) return { status: "FAILED", error: "RESEND_API_KEY absent" }
      const from = process.env.FROM_EMAIL?.includes("@galyaevents.fr") ? process.env.FROM_EMAIL : "Planificator <noreply@galyaevents.fr>"
      const r = await new Resend(key).emails.send({ from, to: message.to, subject: message.subject, html: message.html, text: message.text })
      if (r.error) return { status: "FAILED", error: r.error.message.slice(0, 300) }
      return { status: "SENT", providerId: r.data?.id }
    } catch (e) {
      return { status: "FAILED", error: (e instanceof Error ? e.message : "erreur").slice(0, 300) }
    }
  }
}

let override: BillingMailer | null = null
/** Tests : injecter un mailer. */
export function setBillingMailerForTests(mailer: BillingMailer | null): void { override = mailer }

export function getBillingMailer(): BillingMailer {
  if (override) return override
  return isBillingMailEnabled() ? new ResendMailer() : new RecordingMailer()
}
