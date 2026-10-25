// Initialisation idempotente du référentiel comptable d'une société (plan de comptes de base PCG, journaux).
import type { Prisma } from "@prisma/client"
import type { AccountingContext } from "./posting"

export const BASE_ACCOUNTS: readonly [string, string][] = [
  ["101000", "Capital"], ["401000", "Fournisseurs"], ["411000", "Clients"],
  ["445660", "TVA déductible sur autres biens et services"], ["445710", "TVA collectée"],
  ["512000", "Banque"], ["530000", "Caisse"], ["601000", "Achats de matières premières"],
  ["604000", "Achats d'études et prestations de services"], ["606000", "Achats non stockés de matières et fournitures"],
  ["613000", "Locations"], ["616000", "Primes d'assurances"], ["625000", "Déplacements, missions et réceptions"],
  ["641000", "Rémunérations du personnel"], ["645000", "Charges de sécurité sociale"], ["706000", "Prestations de services"],
  ["707000", "Ventes de marchandises"], ["758000", "Produits divers de gestion courante"],
]

export const BASE_JOURNALS: readonly [string, string, "SALES" | "PURCHASES" | "BANK" | "MISC"][] = [
  ["VT", "Ventes", "SALES"], ["HA", "Achats", "PURCHASES"], ["BQ", "Banque", "BANK"], ["OD", "Opérations diverses", "MISC"],
]

export async function ensureBaseReferential(tx: Prisma.TransactionClient, ctx: AccountingContext): Promise<void> {
  await tx.accountingAccount.createMany({
    data: BASE_ACCOUNTS.map(([number, label]) => ({ companyId: ctx.companyId, number, label })),
    skipDuplicates: true,
  })
  await tx.accountingJournal.createMany({
    data: BASE_JOURNALS.map(([code, label, kind]) => ({ companyId: ctx.companyId, code, label, kind })),
    skipDuplicates: true,
  })
}
