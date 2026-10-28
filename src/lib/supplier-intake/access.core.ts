/** Supplemental intake permission, never an accounting administrator role. */
export type IntakeContext = { userId: string; companyId: string }
export type IntakeSession = { user?: { id?: string; companyId?: string | null; role?: string } } | null
export function hasIntakeGrant(raw: string | undefined, ctx: IntakeContext): boolean {
  if (!raw || raw.length > 100_000) return false
  try {
    const grants: unknown = JSON.parse(raw)
    if (!Array.isArray(grants) || !grants.every(g => g && typeof g === "object" &&
      Object.keys(g).length === 2 && typeof g.userId === "string" && g.userId.trim() &&
      typeof g.companyId === "string" && g.companyId.trim())) return false
    return grants.some(g => g.userId === ctx.userId && g.companyId === ctx.companyId)
  } catch { return false }
}
export async function resolveIntakeAccess(deps: {
  enabled: () => boolean; auth: () => Promise<IntakeSession>; grants: () => string | undefined;
  employeeGrant?: (ctx: IntakeContext, role: string) => Promise<boolean>;
  membershipActive: (ctx: IntakeContext, role: string) => Promise<boolean>
}): Promise<IntakeContext | null> {
  try {
    if (!deps.enabled()) return null
    const user = (await deps.auth())?.user
    if (!user?.id || !user.companyId || !["EMPLOYEE", "TEAM_LEADER"].includes(user.role ?? "")) return null
    const ctx = { userId: user.id, companyId: user.companyId }
    if (!(hasIntakeGrant(deps.grants(), ctx) || await deps.employeeGrant?.(ctx, user.role!) === true) || !await deps.membershipActive(ctx, user.role!)) return null
    return ctx
  } catch { return null }
}
/** Own uploads only, including after validation (read-only); no company-wide ledger visibility. */
export function intakeInvoiceScope(ctx: IntakeContext) {
  return { companyId: ctx.companyId, createdById: ctx.userId }
}

/** Explicit profile IDs only; the adapter must bind each profile to the session user and company. */
export function hasIntakeEmployeeGrant(raw: string | undefined, employeeId: string): boolean {
  if (!raw || raw.length > 100_000 || !employeeId) return false
  try {
    const ids: unknown = JSON.parse(raw)
    return Array.isArray(ids) && ids.every(id => typeof id === "string" && id.trim() === id && id.length > 0) && ids.includes(employeeId)
  } catch { return false }
}
