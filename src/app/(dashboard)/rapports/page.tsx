import type { Metadata } from "next"
import { auth } from "@/auth"
import { redirect } from "next/navigation"
import { prisma } from "@/lib/prisma"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { CheckCircle2, XCircle, Clock3, Users, HardHat, TrendingUp } from "lucide-react"
import { RapportFilters } from "@/components/rapports/RapportFilters"

export const metadata: Metadata = { title: "Rapports" }

export default async function RapportsPage() {
  const session = await auth()
  if (!session?.user) redirect("/login")
  if (!["ADMIN", "SUPER_ADMIN"].includes(session.user.role)) redirect("/dashboard")

  const companyId = session.user.companyId!

  // Données pour les filtres
  const [teams, chantiers] = await Promise.all([
    prisma.team.findMany({
      where: { companyId, active: true },
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    }),
    prisma.worksite.findMany({
      where: { companyId },
      select: { id: true, name: true },
      orderBy: { createdAt: "desc" },
    }),
  ])

  // Stats globales (30 derniers jours)
  const from30 = new Date(); from30.setDate(from30.getDate() - 30); from30.setHours(0,0,0,0)

  const [totalAssignments, byStatus, byTeam, byChantier] = await Promise.all([
    prisma.assignment.count({
      where: { worksite: { companyId }, date: { gte: from30 } },
    }),
    prisma.assignment.groupBy({
      by: ["status"],
      where: { worksite: { companyId }, date: { gte: from30 } },
      _count: true,
    }),
    prisma.assignment.groupBy({
      by: ["teamId"],
      where: { worksite: { companyId }, date: { gte: from30 } },
      _count: true,
      orderBy: { _count: { teamId: "desc" } },
      take: 5,
    }),
    prisma.assignment.groupBy({
      by: ["worksiteId"],
      where: { worksite: { companyId }, date: { gte: from30 } },
      _count: true,
      orderBy: { _count: { worksiteId: "desc" } },
      take: 5,
    }),
  ])

  const confirmed = byStatus.find(s => s.status === "CONFIRMED")?._count ?? 0
  const refused   = byStatus.find(s => s.status === "REFUSED")?._count   ?? 0
  const pending   = byStatus.find(s => s.status === "PENDING")?._count   ?? 0
  const tauxConfirmation = totalAssignments > 0 ? Math.round((confirmed / totalAssignments) * 100) : 0

  // Résoudre les noms des équipes et chantiers pour les tops
  const teamIds     = byTeam.map(t => t.teamId)
  const chantierIds = byChantier.map(c => c.worksiteId)

  const [teamNames, chantierNames] = await Promise.all([
    prisma.team.findMany({ where: { id: { in: teamIds } }, select: { id: true, name: true } }),
    prisma.worksite.findMany({ where: { id: { in: chantierIds } }, select: { id: true, name: true } }),
  ])

  const topTeams = byTeam.map(t => ({
    name:  teamNames.find(n => n.id === t.teamId)?.name ?? t.teamId,
    count: t._count,
  }))
  const topChantiers = byChantier.map(c => ({
    name:  chantierNames.find(n => n.id === c.worksiteId)?.name ?? c.worksiteId,
    count: c._count,
  }))

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">Rapports</h1>
        <p className="text-sm text-slate-500 mt-1">Statistiques et exports des 30 derniers jours</p>
      </div>

      {/* KPIs */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Card>
          <CardContent className="p-4 flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg bg-slate-100 flex items-center justify-center shrink-0">
              <TrendingUp className="h-5 w-5 text-slate-500" />
            </div>
            <div>
              <p className="text-2xl font-bold text-slate-900">{totalAssignments}</p>
              <p className="text-xs text-slate-500">Affectations</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg bg-green-50 flex items-center justify-center shrink-0">
              <CheckCircle2 className="h-5 w-5 text-green-500" />
            </div>
            <div>
              <p className="text-2xl font-bold text-slate-900">{confirmed}</p>
              <p className="text-xs text-slate-500">Confirmées</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg bg-red-50 flex items-center justify-center shrink-0">
              <XCircle className="h-5 w-5 text-red-400" />
            </div>
            <div>
              <p className="text-2xl font-bold text-slate-900">{refused}</p>
              <p className="text-xs text-slate-500">Refusées</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg bg-amber-50 flex items-center justify-center shrink-0">
              <Clock3 className="h-5 w-5 text-amber-500" />
            </div>
            <div>
              <p className="text-2xl font-bold text-slate-900">{pending}</p>
              <p className="text-xs text-slate-500">En attente</p>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Taux de confirmation */}
      <Card>
        <CardContent className="p-4">
          <div className="flex items-center justify-between mb-2">
            <p className="text-sm font-medium text-slate-700">Taux de confirmation</p>
            <p className="text-sm font-bold text-slate-900">{tauxConfirmation}%</p>
          </div>
          <div className="h-2.5 bg-slate-100 rounded-full overflow-hidden">
            <div className="h-full bg-green-500 rounded-full" style={{ width: `${tauxConfirmation}%` }} />
          </div>
          <p className="text-xs text-slate-400 mt-1">{confirmed} confirmées sur {totalAssignments} affectations</p>
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* Top équipes */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-semibold text-slate-700 flex items-center gap-2">
              <Users className="h-4 w-4" /> Top équipes (30j)
            </CardTitle>
          </CardHeader>
          <CardContent>
            {topTeams.length === 0 ? (
              <p className="text-sm text-slate-400 text-center py-4">Aucune donnée</p>
            ) : (
              <div className="space-y-3">
                {topTeams.map((t, i) => (
                  <div key={i} className="flex items-center gap-3">
                    <span className="text-xs font-bold text-slate-400 w-4">{i + 1}</span>
                    <div className="flex-1">
                      <div className="flex justify-between mb-1">
                        <p className="text-xs font-medium text-slate-700">{t.name}</p>
                        <p className="text-xs text-slate-500">{t.count}j</p>
                      </div>
                      <div className="h-1.5 bg-slate-100 rounded-full">
                        <div
                          className="h-full bg-[#0f3460] rounded-full"
                          style={{ width: `${Math.round((t.count / (topTeams[0]?.count || 1)) * 100)}%` }}
                        />
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Top chantiers */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-semibold text-slate-700 flex items-center gap-2">
              <HardHat className="h-4 w-4" /> Top chantiers (30j)
            </CardTitle>
          </CardHeader>
          <CardContent>
            {topChantiers.length === 0 ? (
              <p className="text-sm text-slate-400 text-center py-4">Aucune donnée</p>
            ) : (
              <div className="space-y-3">
                {topChantiers.map((c, i) => (
                  <div key={i} className="flex items-center gap-3">
                    <span className="text-xs font-bold text-slate-400 w-4">{i + 1}</span>
                    <div className="flex-1">
                      <div className="flex justify-between mb-1">
                        <p className="text-xs font-medium text-slate-700 truncate pr-2">{c.name}</p>
                        <p className="text-xs text-slate-500 shrink-0">{c.count}j</p>
                      </div>
                      <div className="h-1.5 bg-slate-100 rounded-full">
                        <div
                          className="h-full bg-blue-400 rounded-full"
                          style={{ width: `${Math.round((c.count / (topChantiers[0]?.count || 1)) * 100)}%` }}
                        />
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Export avec filtres */}
      <RapportFilters
        teams={teams}
        chantiers={chantiers}
      />
    </div>
  )
}
