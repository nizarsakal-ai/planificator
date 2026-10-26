/**
 * Câblage serveur de la garde Comptabilité (session next-auth + lecture seule de la société).
 * Ne jamais importer ce fichier depuis un composant client ("use client").
 */
import { auth } from "@/auth"
import { prisma } from "@/lib/prisma"
import { isAccountingModuleEnabled } from "@/lib/accounting/accounting-feature-flag"
import {
  requireAccountingAdminImpl,
  resolveAccountingAccess,
  type AccountingAccessContext,
  type AccountingAccessDeps,
  type AccountingAccessResult,
} from "@/lib/accounting/access/accounting-access.core"

const defaultDeps: AccountingAccessDeps = {
  auth,
  isModuleEnabled: () => isAccountingModuleEnabled(),
  // Lecture seule : aucune écriture en base dans le Lot 0.
  findCompany: (companyId) =>
    prisma.company.findUnique({ where: { id: companyId }, select: { id: true, active: true } }),
  findUserHomeCompanyId: async (userId) =>
    (await prisma.user.findUnique({ where: { id: userId }, select: { companyId: true } }))?.companyId ?? null,
}

/**
 * Garde des futures Server Actions / routes comptables. Ne prend AUCUN argument :
 * le `companyId` ne peut venir que de la session serveur.
 */
export function requireAccountingAdmin(): Promise<AccountingAccessContext> {
  return requireAccountingAdminImpl(defaultDeps)
}

/** Variante non lançante pour les pages (voir `accountingDenialDisposition`). */
export function resolveAccountingAccessForRequest(): Promise<AccountingAccessResult> {
  return resolveAccountingAccess(defaultDeps)
}
