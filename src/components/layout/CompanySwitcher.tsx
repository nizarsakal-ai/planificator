import { prisma } from "@/lib/prisma"
import { switchCompany } from "@/lib/actions/company-context.actions"

export async function CompanySwitcher({ userId, companyId }: { userId: string; companyId: string | null }) {
  const account = await prisma.user.findUnique({ where: { id: userId }, include: {
    company: true, employeeProfiles: { where: { active: true, company: { active: true } }, include: { company: true } },
  } })
  if (!account || account.role === "SUPER_ADMIN" || account.role === "CLIENT") return null
  const companies = account.employeeProfiles.map(p => p.company)
  if (account.company?.active && !companies.some(c => c.id === account.companyId)
    && !await prisma.employee.findFirst({ where: { userId, companyId: account.companyId! } })) companies.push(account.company)
  if (companies.length < 2) return null
  return <form action={switchCompany} className="flex items-center gap-2">
    <label className="sr-only" htmlFor="active-company">Entreprise active</label>
    <select id="active-company" name="companyId" defaultValue={companyId ?? ""} className="max-w-40 rounded border p-1 text-sm">
      {companies.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
    </select>
    <button type="submit" className="rounded border px-2 py-1 text-sm">Changer</button>
  </form>
}
