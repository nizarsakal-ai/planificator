// Génération automatique des écritures après un événement de facturation, uniquement si ACCOUNTING_AUTO_POSTING_ENABLED
// et ACCOUNTING_MODULE_ENABLED sont actifs. Jamais bloquante pour la pièce ; erreurs journalisées sans contenu sensible.
import type { PrismaClient } from "@prisma/client"
import { isAccountingModuleEnabled } from "@/lib/accounting/accounting-feature-flag"
import { isAccountingAutoPostingEnabled } from "@/lib/billing/billing-feature-flag"
import { resolveAccountingAccessForRequest } from "@/lib/accounting/access/accounting-access"
import { tryAutoPost } from "./postings"

/** Le contexte comptable est celui de la garde A2 (requireAccountingAdmin), jamais celui de la facturation. */
export async function autoPostIfEnabled(db: PrismaClient, ctx: { companyId: string; userId: string }, kind: "INVOICE" | "PAYMENT" | "SUPPLIER_INVOICE", id: string): Promise<void> {
  if (!isAccountingModuleEnabled() || !isAccountingAutoPostingEnabled()) return
  const access = await resolveAccountingAccessForRequest()
  if (!access.ok || access.context.companyId !== ctx.companyId) return
  await tryAutoPost(db, { companyId: access.context.companyId, userId: access.context.userId }, kind, id)
}
