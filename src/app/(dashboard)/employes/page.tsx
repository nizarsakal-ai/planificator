import type { Metadata } from "next"
import { auth } from "@/auth"
import { redirect } from "next/navigation"
import { prisma } from "@/lib/prisma"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent } from "@/components/ui/card"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Users, Phone, Briefcase } from "lucide-react"
import { getInitials } from "@/lib/utils"
import { NouvelEmployeDialog } from "@/components/employes/NouvelEmployeDialog"
import { EmployeActions } from "@/components/employes/EmployeActions"
import { InviterMembreDialog } from "@/components/invitations/InviterMembreDialog"

export const metadata: Metadata = { title: "Employés" }

export default async function EmployesPage() {
  const session = await auth()
  if (!session?.user) redirect("/login")
  if (!["ADMIN", "SUPER_ADMIN"].includes(session.user.role)) redirect("/dashboard")

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

  const actifs = employees.filter((e) => e.active).length
  const inactifs = employees.filter((e) => !e.active).length

  return (
    <div className="space-y-6">
      {/* En-tête */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Employés</h1>
          <p className="text-sm text-slate-500 mt-1">
            {actifs} actif{actifs > 1 ? "s" : ""}
            {inactifs > 0 && ` · ${inactifs} inactif${inactifs > 1 ? "s" : ""}`}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <InviterMembreDialog />
          <NouvelEmployeDialog />
        </div>
      </div>

      {/* Liste des employés */}
      {employees.length === 0 ? (
        <Card>
          <CardContent className="py-16 text-center">
            <Users className="h-10 w-10 text-slate-200 mx-auto mb-3" />
            <p className="text-slate-400 font-medium">Aucun employé pour le moment.</p>
            <p className="text-slate-400 text-sm mt-1">
              Cliquez sur &quot;Nouvel employé&quot; pour commencer.
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {employees.map((emp) => {
            const fullName = `${emp.firstName} ${emp.lastName}`
            const team = emp.teamMemberships[0]?.team

            return (
              <Card
                key={emp.id}
                className={`hover:shadow-md transition-shadow ${!emp.active ? "opacity-60" : ""}`}
              >
                <CardContent className="p-5">
                  {/* Header carte */}
                  <div className="flex items-start justify-between mb-4">
                    <div className="flex items-center gap-3">
                      <Avatar className="h-11 w-11">
                        <AvatarFallback className="bg-[#0f3460] text-white font-semibold text-sm">
                          {getInitials(fullName)}
                        </AvatarFallback>
                      </Avatar>
                      <div>
                        <p className="font-semibold text-slate-900 text-sm leading-tight">
                          {fullName}
                        </p>
                        <p className="text-xs text-slate-400 mt-0.5">
                          {emp.user.email}
                        </p>
                      </div>
                    </div>
                    <Badge variant={emp.active ? "default" : "secondary"} className="text-xs shrink-0">
                      {emp.active ? "Actif" : "Inactif"}
                    </Badge>
                  </div>

                  {/* Infos */}
                  <div className="space-y-1.5 mb-4">
                    {emp.jobTitle && (
                      <div className="flex items-center gap-2 text-xs text-slate-500">
                        <Briefcase className="h-3.5 w-3.5 shrink-0" />
                        {emp.jobTitle}
                      </div>
                    )}
                    {emp.phone && (
                      <div className="flex items-center gap-2 text-xs text-slate-500">
                        <Phone className="h-3.5 w-3.5 shrink-0" />
                        {emp.phone}
                      </div>
                    )}
                    {team && (
                      <div className="flex items-center gap-2 text-xs">
                        <span
                          className="inline-block w-2.5 h-2.5 rounded-full shrink-0"
                          style={{ backgroundColor: team.color ?? "#0f3460" }}
                        />
                        <span className="text-slate-600">{team.name}</span>
                      </div>
                    )}
                    {!team && (
                      <p className="text-xs text-slate-400 italic">
                        Non assigné à une équipe
                      </p>
                    )}
                  </div>

                  {/* Actions */}
                  <div className="border-t border-slate-100 pt-3 flex justify-end">
                    <EmployeActions
                      employeeId={emp.id}
                      active={emp.active}
                    />
                  </div>
                </CardContent>
              </Card>
            )
          })}
        </div>
      )}
    </div>
  )
}
