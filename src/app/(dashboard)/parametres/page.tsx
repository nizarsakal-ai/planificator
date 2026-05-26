import type { Metadata } from "next"
import { auth } from "@/auth"
import { redirect } from "next/navigation"
import { prisma } from "@/lib/prisma"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Building2, SlidersHorizontal, Users, HardHat, CalendarDays } from "lucide-react"
import { CompanyForm } from "@/components/parametres/CompanyForm"
import { SettingsForm } from "@/components/parametres/SettingsForm"

export const metadata: Metadata = { title: "Paramètres" }

export default async function ParametresPage() {
  const session = await auth()
  if (!session?.user) redirect("/login")
  if (!["ADMIN", "SUPER_ADMIN"].includes(session.user.role)) redirect("/dashboard")

  const company = await prisma.company.findUnique({
    where: { id: session.user.companyId! },
    include: { settings: true },
  })

  if (!company) redirect("/dashboard")

  // Statistiques rapides
  const [nbEmployes, nbEquipes, nbChantiers] = await Promise.all([
    prisma.employee.count({ where: { companyId: company.id, active: true } }),
    prisma.team.count({ where: { companyId: company.id, active: true } }),
    prisma.worksite.count({ where: { companyId: company.id, status: { in: ["PLANNED", "IN_PROGRESS"] } } }),
  ])

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">Paramètres</h1>
        <p className="text-sm text-slate-500 mt-1">Gérez les informations et réglages de votre entreprise</p>
      </div>

      {/* Stats rapides */}
      <div className="grid grid-cols-3 gap-4">
        <Card>
          <CardContent className="p-4 flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg bg-blue-50 flex items-center justify-center">
              <Users className="h-4 w-4 text-blue-600" />
            </div>
            <div>
              <p className="text-2xl font-bold text-slate-900">{nbEmployes}</p>
              <p className="text-xs text-slate-500">Employés actifs</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg bg-purple-50 flex items-center justify-center">
              <CalendarDays className="h-4 w-4 text-purple-600" />
            </div>
            <div>
              <p className="text-2xl font-bold text-slate-900">{nbEquipes}</p>
              <p className="text-xs text-slate-500">Équipes actives</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg bg-orange-50 flex items-center justify-center">
              <HardHat className="h-4 w-4 text-orange-500" />
            </div>
            <div>
              <p className="text-2xl font-bold text-slate-900">{nbChantiers}</p>
              <p className="text-xs text-slate-500">Chantiers en cours</p>
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Infos entreprise */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-semibold flex items-center gap-2">
              <Building2 className="h-4 w-4" /> Informations de l&apos;entreprise
            </CardTitle>
          </CardHeader>
          <CardContent>
            <CompanyForm company={company} />
          </CardContent>
        </Card>

        {/* Paramètres */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-semibold flex items-center gap-2">
              <SlidersHorizontal className="h-4 w-4" /> Réglages
            </CardTitle>
          </CardHeader>
          <CardContent>
            <SettingsForm settings={company.settings} />
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
