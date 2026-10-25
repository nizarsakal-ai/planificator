// Paramètres de facturation d'une société (BillingSettings) avec valeurs par défaut ; mentions légales des PDF.
import type { Prisma, PrismaClient } from "@prisma/client"

type Db = PrismaClient | Prisma.TransactionClient

export interface BillingSettingsView {
  vatNumber: string | null
  legalForm: string | null
  shareCapital: string | null
  rcs: string | null
  iban: string | null
  bic: string | null
  quoteValidityDays: number
  paymentTermsDays: number
  latePenaltyText: string | null
  quoteFooter: string | null
  invoiceFooter: string | null
  vatRegime: "DEBITS" | "ENCAISSEMENTS"
  defaultDepositBp: number
}

export const DEFAULT_BILLING_SETTINGS: BillingSettingsView = {
  vatNumber: null, legalForm: null, shareCapital: null, rcs: null, iban: null, bic: null,
  quoteValidityDays: 30, paymentTermsDays: 30, latePenaltyText: null, quoteFooter: null, invoiceFooter: null,
  vatRegime: "DEBITS", defaultDepositBp: 3000,
}

/** Mention légale par défaut (art. L441-10 C. com.) : pénalités de retard, indemnité forfaitaire de 40 €, pas d'escompte. */
export const DEFAULT_LATE_PENALTY_TEXT =
  "En cas de retard de paiement, pénalités de retard au taux de 3 fois le taux d'intérêt légal, exigibles sans rappel, et indemnité forfaitaire pour frais de recouvrement de 40 € (art. L441-10 et D441-5 du Code de commerce). Pas d'escompte pour paiement anticipé."

export async function getBillingSettings(db: Db, companyId: string): Promise<BillingSettingsView> {
  const s = await db.billingSettings.findUnique({ where: { companyId } })
  if (!s) return { ...DEFAULT_BILLING_SETTINGS }
  return {
    vatNumber: s.vatNumber, legalForm: s.legalForm, shareCapital: s.shareCapital, rcs: s.rcs, iban: s.iban, bic: s.bic,
    quoteValidityDays: s.quoteValidityDays, paymentTermsDays: s.paymentTermsDays, latePenaltyText: s.latePenaltyText,
    quoteFooter: s.quoteFooter, invoiceFooter: s.invoiceFooter, vatRegime: s.vatRegime, defaultDepositBp: s.defaultDepositBp,
  }
}

/** Variante pour les écrans comptables : contexte de session uniquement. */
export function getBillingSettingsFor(db: Db, ctx: { companyId: string }): Promise<BillingSettingsView> {
  return getBillingSettings(db, ctx.companyId)
}

/** SIREN = 9 premiers chiffres du SIRET (après suppression des espaces). */
export function sirenFromSiret(siret: string | null | undefined): string | null {
  const digits = (siret ?? "").replace(/\s/g, "")
  return /^\d{14}$/.test(digits) ? digits.slice(0, 9) : /^\d{9}$/.test(digits) ? digits : null
}

export function appBaseUrl(): string {
  return (process.env.NEXTAUTH_URL ?? "http://localhost:3000").replace(/\/+$/, "")
}
