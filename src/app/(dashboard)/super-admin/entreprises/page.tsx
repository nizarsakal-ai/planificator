import type { Metadata } from "next"
import { auth } from "@/auth"
import { redirect } from "next/navigation"
import { prisma } from "@/lib/prisma"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent } from "@/components/ui/card"
import { Building2, Users, HardHat, Calendar, CheckCircle2, XCircle } from "lucide-react"
import { CreateCompanyDialog } from "@/components/super-admin/CreateCompanyDialog"

export const metadata: Metadata = { title: "Super Admin — Entreprises" }

function formatDate(d: Date) {
  return new Intl.DateTimeFormat("fr-FR", { day: "2-digit", month: "short", year: "numeric" }).format(d)
}

export default async function SuperAdminEntreprisesPage() {
  const session = await auth()
  if (!session?.user) redirect("/login")
  if (session.user.role !== "SUPER_ADMIN") redirect("/dashboard")

  const companies = await prisma.company.findMany({
    include: {
      _count: {
        select: {
          users:      true,
          employees:  true,
          worksites:  true,
        },
      },
    },
    orderBy: { createdAt: "desc" },
  })

  const actives  = companies.filter((c) => c.active).length
  const totalUsr = companies.reduce((sum, c) => sum + c._count.users, 0)

  return (
    <div className="space-y-6">
      {/* En-tête */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Entreprises</h1>
          <p className="text-sm text-slate-500 mt-1">
            {actives} active{actives > 1 ? "s" : ""} · {totalUsr} utilisateur{totalUsr > 1 ? "s" : ""} au total
          </p>
        </div>
        <div className="flex items-center gap-3">
          <CreateCompanyDialog />
          <Badge className="bg-red-100 text-red-700 border-red-200 text-xs px-3 py-1">
            Super Admin
          </Badge>
        </div>
      </div>

      {/* Stats globales */}
      <div className="grid grid-cols-3 gap-4">
        <Card>
          <CardContent className="p-4 flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg bg-blue-50 flex items-center justify-center">
              <Building2 className="h-4 w-4 text-blue-600" />
            </div>
            <div>
              <p className="text-2xl font-bold text-slate-900">{companies.length}</p>
              <p className="text-xs text-slate-500">Entreprises</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg bg-green-50 flex items-center justify-center">
              <Users className="h-4 w-4 text-green-600" />
            </div>
            <div>
              <p className="text-2xl font-bold text-slate-900">{totalUsr}</p>
              <p className="text-xs text-slate-500">Utilisateurs</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg bg-orange-50 flex items-center justify-center">
              <HardHat className="h-4 w-4 text-orange-500" />
            </div>
            <div>
              <p className="text-2xl font-bold text-slate-900">
                {companies.reduce((sum, c) => sum + c._count.worksites, 0)}
              </p>
              <p className="text-xs text-slate-500">Chantiers</p>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Liste entreprises */}
      <Card>
        <CardContent className="p-0">
          {companies.length === 0 ? (
            <div className="py-16 text-center">
              <Building2 className="h-10 w-10 text-slate-200 mx-auto mb-3" />
              <p className="text-slate-400">Aucune entreprise.</p>
            </div>
          ) : (
            <div className="divide-y divide-slate-50">
              {companies.map((company) => (
                <div key={company.id} className="flex items-center justify-between px-5 py-4 hover:bg-slate-50 transition-colors">
                  {/* Identité */}
                  <div className="flex items-center gap-4">
                    <div className="w-10 h-10 rounded-xl bg-[#0f3460]/10 flex items-center justify-center font-bold text-[#0f3460] text-sm shrink-0">
                      {company.name.charAt(0).toUpperCase()}
                    </div>
                    <div>
                      <div className="flex items-center gap-2">
                        <p className="font-semibold text-slate-800 text-sm">{company.name}</p>
                        {company.active ? (
                          <CheckCircle2 className="h-3.5 w-3.5 text-green-500" />
                        ) : (
                          <XCircle className="h-3.5 w-3.5 text-red-400" />
                        )}
                      </div>
                      <p className="text-xs text-slate-400">{company.slug}</p>
                      {company.email && <p className="text-xs text-slate-400">{company.email}</p>}
                    </div>
                  </div>

                  {/* Stats */}
                  <div className="flex items-center gap-6 text-xs text-slate-500">
                    <div className="flex items-center gap-1.5">
                      <Users className="h-3.5 w-3.5 text-slate-400" />
                      <span>{company._count.users} util.</span>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <HardHat className="h-3.5 w-3.5 text-slate-400" />
                      <span>{company._count.worksites} chantiers</span>
                    </div>
                    <div className="flex items-center gap-1.5 text-slate-400">
                      <Calendar className="h-3.5 w-3.5" />
                      <span>{formatDate(company.createdAt)}</span>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
