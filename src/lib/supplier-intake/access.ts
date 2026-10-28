import { auth } from "@/auth"
import { prisma } from "@/lib/prisma"
import { isAccountingModuleEnabled } from "@/lib/accounting/accounting-feature-flag"
import { resolveCompanyAccess } from "@/lib/company-access"
import { resolveIntakeAccess, hasIntakeEmployeeGrant } from "./access.core"
export function resolveSupplierIntakeAccess() {
  if (!process.env.SUPPLIER_INTAKE_GRANTS && !process.env.SUPPLIER_INTAKE_EMPLOYEE_IDS) return Promise.resolve(null)
  return resolveIntakeAccess({
    enabled: isAccountingModuleEnabled, auth,
    grants: () => process.env.SUPPLIER_INTAKE_GRANTS,
    employeeGrant: async (ctx, role) => {
      const raw = process.env.SUPPLIER_INTAKE_EMPLOYEE_IDS
      if (!raw) return false
      const profile = await prisma.employee.findFirst({ where: {
        userId: ctx.userId, companyId: ctx.companyId, active: true,
        role: role as "EMPLOYEE" | "TEAM_LEADER", company: { active: true }, user: { active: true },
      }, select: { id: true } })
      return !!profile && hasIntakeEmployeeGrant(raw, profile.id)
    },
    membershipActive: async (ctx, role) => {
      const user = await prisma.user.findUnique({ where: { id: ctx.userId }, select: {
        active: true, role: true, companyId: true, company: { select: { active: true } },
        employeeProfiles: { select: { companyId: true, active: true, role: true, company: { select: { active: true } } } },
      } })
      if (!user?.active) return false
      const access = resolveCompanyAccess(user, ctx.companyId)
      return access?.companyId === ctx.companyId && access.role === role
    },
  })
}
export async function requireSupplierIntake() {
  const ctx = await resolveSupplierIntakeAccess()
  if (!ctx) throw new Error("SUPPLIER_INTAKE_FORBIDDEN")
  return ctx
}
