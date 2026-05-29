import type { Metadata } from "next"
import { auth } from "@/auth"
import { redirect } from "next/navigation"
import { prisma } from "@/lib/prisma"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent } from "@/components/ui/card"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Users } from "lucide-react"
import { getInitials } from "@/lib/utils"
import Link from "next/link"
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

  const actifs   = employees.filter((e) =>  e.active).length
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

      {/* Liste */}
      {employees.length === 0 ? (
        <Card>
          <CardContent className="py-16 text-center">
            <Users className="h-10 w-10 text-slate-200 mx-auto mb-3" />
            <p className="text-slate-400 font-medium">Aucun employé pour le moment.</p>
            <p className="text-slate-400 text-sm mt-1">Cliquez sur &quot;Nouvel employé&quot; pour commencer.</p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3">
          {employees.map((emp) => {
            const fullName = `${emp.firstName} ${emp.lastName}`
            const team     = emp.teamMemberships[0]?.team

            return (
              <div key={emp.id} className={`relative group ${!emp.active ? "opacity-50" : ""}`}>
                <Link
                  href={`/employes/${emp.id}`}
                  className="absolute inset-0 z-0 rounded-xl"
                  aria-label={`Voir le profil de ${fullName}`}
                />
                <Card className="hover:shadow-md hover:border-[#0f3460]/30 transition-all border border-slate-100">
                  <CardContent className="p-3 flex flex-col items-center text-center gap-2">
                    <Avatar className="h-11 w-11 mt-1">
                      {emp.avatarUrl && <AvatarImage src={emp.avatarUrl} alt={fullName} />}
                      <AvatarFallback className="bg-[#0f3460] text-white font-semibold text-xs">
                        {getInitials(fullName)}
                      </AvatarFallback>
                    </Avatar>

                    <div className="w-full min-w-0">
                      <p className="font-semibold text-slate-900 text-xs leading-tight truncate group-hover:text-[#0f3460] transition-colors">
                        {fullName}
                      </p>
                      {emp.jobTitle && (
                        <p className="text-[11px] text-slate-400 truncate mt-0.5">{emp.jobTitle}</p>
                      )}
                      {team ? (
                        <div className="flex items-center justify-center gap-1 mt-1">
                          <span className="inline-block w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: team.color ?? "#0f3460" }} />
                          <span className="text-[11px] text-slate-500 truncate">{team.name}</span>
                        </div>
                      ) : (
                        <p className="text-[10px] text-slate-300 mt-0.5">Sans équipe</p>
                      )}
                    </div>

                    <div className="relative z-10 w-full border-t border-slate-50 pt-2">
                      <EmployeActions employeeId={emp.id} active={emp.active} />
                    </div>
                  </CardContent>
                </Card>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
