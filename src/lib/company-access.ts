/** A login identity can have independent employee memberships in several companies. */
export type CompanyAccess = { companyId: string | null; role: string }
type Account = { role: string; companyId: string | null; employeeProfiles: { companyId: string; active: boolean; role: string; company: { active: boolean } }[]; company: { active: boolean } | null }
export function resolveCompanyAccess(account: Account, requested?: string | null): CompanyAccess | null {
  if (account.role === "SUPER_ADMIN") return { companyId: account.companyId, role: "SUPER_ADMIN" }
  const choices = account.employeeProfiles.filter(p => p.active && p.company.active)
    .map(p => ({ companyId: p.companyId, role: p.role }))
  // Legacy administrators/clients may have no employee profile.
  if (account.companyId && account.company?.active && !account.employeeProfiles.some(p => p.companyId === account.companyId)) {
    choices.push({ companyId: account.companyId, role: account.role })
  }
  return choices.find(p => p.companyId === requested)
    ?? choices.find(p => p.companyId === account.companyId) ?? choices[0] ?? null
}
