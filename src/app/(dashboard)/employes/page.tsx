import type { Metadata } from "next"
import { auth } from "@/auth"
import { redirect } from "next/navigation"
import { prisma } from "@/lib/prisma"
import { Card, CardContent } from "@/components/ui/card"
import { Users } from "lucide-react"
import { NouvelEmployeDialog } from "@/components/employes/NouvelEmployeDialog"
import { InviterMembreDialog } from "@/components/invitations/InviterMembreDialog"
import { EmployesView } from "@/components/employes/EmployesView"
import { ResendAccessButton } from "@/components/employes/ResendAccessButton"

export const metadata: Metadata = { title: "Employés" }

export default async function EmployesPage() {
  const session = await auth()
  if (!session?.user) redirect("/login")
  if (!["ADMIN", "SUPER_ADMIN", "TEAM_LEADER"].includes(session.user.role)) redirect("/dashboard")

  const employees = await prisma.employee.findMany({
    where: { companyId: session.user.companyId! },
    include: {
      user: { select: { email: true, active: true } },
      teamMemberships: {
        where: { leftAt: null },
        include: { team: { select: { name: true, color: true } } },
      },
    },
    orderBy: { firstName: "asc" },
  })

  const actifs   = employees.filter((e) =>  e.active).length
  const inactifs = employees.filter((e) => !e.active).length

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Employés</h1>
          <p className="text-sm text-slate-500 mt-1">
            {actifs} actif{actifs > 1 ? "s" : ""}
            {inactifs > 0 && ` · ${inactifs} inactif${inactifs > 1 ? "s" : ""}`}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <ResendAccessButton />
          <InviterMembreDialog />
          <NouvelEmployeDialog />
        </div>
      </div>

      {employees.length === 0 ? (
        <Card>
          <CardContent className="py-16 text-center">
            <Users className="h-10 w-10 text-slate-200 mx-auto mb-3" />
            <p className="text-slate-400 font-medium">Aucun employé pour le moment.</p>
            <p className="text-slate-400 text-sm mt-1">Cliquez sur &quot;Nouvel employé&quot; pour commencer.</p>
          </CardContent>
        </Card>
      ) : (
        <EmployesView employees={employees} />
      )}
    </div>
  )
}
