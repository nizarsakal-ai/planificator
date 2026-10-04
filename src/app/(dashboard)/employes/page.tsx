import type { Metadata } from "next"
import { auth } from "@/auth"
import { redirect } from "next/navigation"
import { prisma } from "@/lib/prisma"
import { Card, CardContent } from "@/components/ui/card"
import { Users } from "lucide-react"
import { NouvelEmployeDialog } from "@/components/employes/NouvelEmployeDialog"
import { InviterMembreDialog } from "@/components/invitations/InviterMembreDialog"
import { EmployesView } from "@/components/employes/EmployesView"
import { EmployeStats } from "@/components/employes/EmployeStats"
import { ResendAccessButton } from "@/components/employes/ResendAccessButton"
import { computeEmployeeStats, toEmployeeViewItems } from "@/lib/employes/employes-view"

export const metadata: Metadata = { title: "Employés" }

export default async function EmployesPage() {
  const session = await auth()
  if (!session?.user) redirect("/login")
  if (!["ADMIN", "SUPER_ADMIN", "TEAM_LEADER"].includes(session.user.role)) redirect("/dashboard")

  const companyId = session.user.companyId!

  const rows = await prisma.employee.findMany({
    where: { companyId },
    select: {
      id: true,
      companyId: true,
      firstName: true,
      lastName: true,
      jobTitle: true,
      phone: true,
      avatarUrl: true,
      active: true,
      user: { select: { role: true } },
      teamMemberships: {
        where: { leftAt: null, team: { companyId } },
        select: { team: { select: { id: true, name: true, color: true, companyId: true } } },
      },
      ledTeams: {
        where: { active: true, companyId },
        select: { id: true, name: true, color: true, companyId: true },
      },
    },
    orderBy: { firstName: "asc" },
  })

  const employees = toEmployeeViewItems(rows, companyId)
  const stats = computeEmployeeStats(employees)

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Employés</h1>
          <p className="text-sm text-slate-500 mt-1">
            Votre personnel, organisé par fonction.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <ResendAccessButton />
          <InviterMembreDialog
            canInviteAdmin={["ADMIN", "SUPER_ADMIN"].includes(session.user.role)}
          />
          <NouvelEmployeDialog />
        </div>
      </div>

      <EmployeStats stats={stats} />

      {employees.length === 0 ? (
        <Card>
          <CardContent className="py-16 text-center">
            <Users className="h-10 w-10 text-slate-200 mx-auto mb-3" />
            <p className="text-slate-400 font-medium">Aucun employé pour le moment.</p>
            <p className="text-slate-400 text-sm mt-1">Cliquez sur &quot;Créer un employé&quot; pour commencer.</p>
          </CardContent>
        </Card>
      ) : (
        <EmployesView employees={employees} />
      )}
    </div>
  )
}
