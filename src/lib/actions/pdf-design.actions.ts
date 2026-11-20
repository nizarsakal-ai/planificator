"use server"
// 20/11/2026 — design du PDF d'UN brouillon (facture, acompte, avoir ou devis). ADMIN de la société de session, drapeau Lot C.
// Une pièce émise n'est jamais modifiée : la mise à jour est conditionnée au statut DRAFT (UPDATE … WHERE status = 'DRAFT').
import { revalidatePath } from "next/cache"
import { z } from "zod"
import { prisma } from "@/lib/prisma"
import { BillingAccessError, billingAccessMessage, requireBillingAdmin } from "@/lib/billing/access"
import { designToStored, validateDesign, type DesignColumns } from "@/lib/billing/pdf/design"
import { designInputSchema } from "@/lib/billing/pdf/design-schema"

type Result = { ok: true } | { ok: false; error: string }

const schema = z.object({
  kind: z.enum(["invoice", "quote"]),
  id: z.string().trim().min(1).max(64),
  /** null = suivre le réglage de la société. */
  design: designInputSchema.nullable(),
}).strict()

export async function saveDocumentDesignAction(raw: unknown): Promise<Result> {
  const p = schema.safeParse(raw)
  if (!p.success) return { ok: false, error: "Saisie invalide." }
  // Toutes les colonnes à null = suivre le réglage de la société (choix tout ou rien, voir designFromStored).
  let stored: DesignColumns | { [K in keyof DesignColumns]: null } = { pdfTemplate: null, pdfPrimaryColor: null, pdfSecondaryColor: null, pdfLayout: null, pdfShowClientIds: null, pdfShowBankDetails: null }
  if (p.data.design) {
    const v = validateDesign(p.data.design)
    if (!v.ok) return { ok: false, error: v.errors[0] }
    stored = designToStored(v.design)
  }
  try {
    const ctx = await requireBillingAdmin()
    const { kind, id } = p.data
    const updated = await prisma.$transaction(async (tx) => {
      const u = kind === "invoice"
        ? await tx.invoice.updateMany({ where: { id, companyId: ctx.companyId, status: "DRAFT" }, data: stored })
        : await tx.quote.updateMany({ where: { id, companyId: ctx.companyId, status: "DRAFT" }, data: stored })
      if (u.count !== 1) return false
      await tx.historyLog.create({
        data: {
          companyId: ctx.companyId, actorId: ctx.userId, action: "UPDATED", entityType: kind === "invoice" ? "Invoice" : "Quote", entityId: id,
          detail: p.data.design ? `Apparence du PDF : modèle ${stored.pdfTemplate}, couleurs ${stored.pdfPrimaryColor} / ${stored.pdfSecondaryColor}` : "Apparence du PDF : réglage de la société",
          newValue: { ...stored },
        },
      })
      return true
    })
    if (!updated) return { ok: false, error: "Seul un brouillon peut changer d'apparence (une pièce émise garde son design)." }
    revalidatePath(kind === "invoice" ? `/factures/${id}` : `/devis/${id}`)
    return { ok: true }
  } catch (error) {
    if (error instanceof BillingAccessError) return { ok: false, error: billingAccessMessage(error.reason) }
    console.error("[facturation] apparence du PDF en échec", error instanceof Error ? error.name : "erreur")
    return { ok: false, error: "Erreur serveur, réessayez." }
  }
}
