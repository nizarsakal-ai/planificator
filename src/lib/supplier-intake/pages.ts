import { notFound } from "next/navigation"
import { requireSupplierIntake, resolveSupplierIntakeAccess } from "./access"
import { prisma } from "@/lib/prisma"
import { intakeInvoiceScope, type IntakeContext } from "./access.core"
export async function requireIntakePage() {
  const ctx = await resolveSupplierIntakeAccess()
  if (!ctx) notFound()
  return ctx
}
export async function intakeAccounts(ctx: IntakeContext) {
  return prisma.accountingAccount.findMany({ where: { companyId: ctx.companyId, active: true, number: { startsWith: "6" } }, select: { id: true, number: true, label: true }, orderBy: { number: "asc" } })
}
export async function intakeInvoice(id: string) {
  const ctx = await requireSupplierIntake()
  if (!id || id.length > 64) return null
  return prisma.supplierInvoice.findFirst({ where: { id, ...intakeInvoiceScope(ctx) } })
}
