// Envoi journalisé : une ligne BillingMailLog par courrier (jamais le corps), statut SIMULATED/SENT/FAILED.
// À appeler HORS transaction (effet externe) : la journalisation est faite après l'envoi.
import type { Prisma, PrismaClient } from "@prisma/client"
import { getBillingMailer, type BillingMailMessage } from "./mailer"

type Db = PrismaClient | Prisma.TransactionClient

export interface MailLogInput { companyId: string; kind: string; documentType: "Quote" | "Invoice"; documentId: string }

export async function sendBillingMail(db: Db, log: MailLogInput, message: BillingMailMessage): Promise<{ status: string; id: string }> {
  const result = await getBillingMailer().send(message)
  const row = await db.billingMailLog.create({
    data: {
      companyId: log.companyId, kind: log.kind, to: message.to, subject: message.subject.slice(0, 300),
      documentType: log.documentType, documentId: log.documentId, status: result.status,
      providerId: result.providerId ?? null, error: result.error ?? null,
    },
    select: { id: true },
  })
  return { status: result.status, id: row.id }
}
