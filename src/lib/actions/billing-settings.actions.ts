"use server"
// Paramètres de facturation (mentions légales, délais) — ADMIN de la société de session, drapeau Lot C.
import { revalidatePath } from "next/cache"
import { z } from "zod"
import { prisma } from "@/lib/prisma"
import { BillingAccessError, billingAccessMessage, requireBillingAdmin } from "@/lib/billing/access"

const text = (max: number) => z.string().trim().max(max)
const schema = z.object({
  vatNumber: text(20), legalForm: text(60), shareCapital: text(60), rcs: text(120), iban: text(40), bic: text(16),
  quoteValidityDays: z.coerce.number().int().min(1).max(365), paymentTermsDays: z.coerce.number().int().min(0).max(120),
  latePenaltyText: text(1000), quoteFooter: text(1000), invoiceFooter: text(1000),
  vatRegime: z.enum(["DEBITS", "ENCAISSEMENTS"]), defaultDepositPercent: z.coerce.number().int().min(1).max(100),
}).strict()

export async function saveBillingSettingsAction(raw: unknown): Promise<{ ok: true } | { ok: false; error: string }> {
  const p = schema.safeParse(raw)
  if (!p.success) return { ok: false, error: p.error.issues[0]?.message ?? "Saisie invalide." }
  const v = p.data
  if (v.iban && !/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(v.iban.replace(/\s/g, "").toUpperCase())) return { ok: false, error: "IBAN invalide." }
  if (v.vatNumber && !/^[A-Z]{2}[A-Z0-9]{2,13}$/.test(v.vatNumber.replace(/\s/g, "").toUpperCase())) return { ok: false, error: "Numéro de TVA intracommunautaire invalide." }
  try {
    const ctx = await requireBillingAdmin()
    const data = {
      vatNumber: v.vatNumber ? v.vatNumber.replace(/\s/g, "").toUpperCase() : null, legalForm: v.legalForm || null, shareCapital: v.shareCapital || null, rcs: v.rcs || null,
      iban: v.iban ? v.iban.replace(/\s/g, "").toUpperCase() : null, bic: v.bic ? v.bic.replace(/\s/g, "").toUpperCase() : null,
      quoteValidityDays: v.quoteValidityDays, paymentTermsDays: v.paymentTermsDays, latePenaltyText: v.latePenaltyText || null,
      quoteFooter: v.quoteFooter || null, invoiceFooter: v.invoiceFooter || null, vatRegime: v.vatRegime, defaultDepositBp: v.defaultDepositPercent * 100,
    }
    await prisma.$transaction(async (tx) => {
      await tx.billingSettings.upsert({ where: { companyId: ctx.companyId }, create: { companyId: ctx.companyId, ...data }, update: data })
      await tx.historyLog.create({ data: { companyId: ctx.companyId, actorId: ctx.userId, action: "UPDATED", entityType: "BillingSettings", entityId: ctx.companyId, detail: "Paramètres de facturation modifiés" } })
    })
    revalidatePath("/factures", "layout")
    revalidatePath("/devis", "layout")
    return { ok: true }
  } catch (error) {
    if (error instanceof BillingAccessError) return { ok: false, error: billingAccessMessage(error.reason) }
    console.error("[facturation] paramètres en échec", error instanceof Error ? error.name : "erreur")
    return { ok: false, error: "Erreur serveur, réessayez." }
  }
}

/** Identifiants de facturation d'un client (SIRET, TVA) — société de session uniquement. */
export async function saveClientBillingIdsAction(raw: unknown): Promise<{ ok: true } | { ok: false; error: string }> {
  const p = z.object({ clientId: z.string().trim().min(1).max(64), siret: text(20), vatNumber: text(20) }).strict().safeParse(raw)
  if (!p.success) return { ok: false, error: "Saisie invalide." }
  const siret = p.data.siret.replace(/\s/g, "")
  if (siret && !/^\d{9}$|^\d{14}$/.test(siret)) return { ok: false, error: "SIRET (14 chiffres) ou SIREN (9 chiffres) invalide." }
  try {
    const ctx = await requireBillingAdmin()
    const u = await prisma.client.updateMany({ where: { id: p.data.clientId, companyId: ctx.companyId }, data: { siret: siret || null, vatNumber: p.data.vatNumber ? p.data.vatNumber.replace(/\s/g, "").toUpperCase() : null } })
    if (u.count !== 1) return { ok: false, error: "Client introuvable." }
    revalidatePath("/devis", "layout"); revalidatePath("/factures", "layout")
    return { ok: true }
  } catch (error) {
    if (error instanceof BillingAccessError) return { ok: false, error: billingAccessMessage(error.reason) }
    return { ok: false, error: "Erreur serveur, réessayez." }
  }
}
