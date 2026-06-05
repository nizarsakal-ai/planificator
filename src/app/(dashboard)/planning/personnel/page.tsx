import type { Metadata } from "next"
import { auth } from "@/auth"
import { redirect } from "next/navigation"
import { prisma } from "@/lib/prisma"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { CheckCircle2, AlertCircle, Users } from "lucide-react"
import { PersonnelDateNav } from "@/components/planning/PersonnelDateNav"
import { PersonnelAssignForm } from "@/components/planning/PersonnelAssignForm"

export const metadata: Metadata = { title: "Personnel disponible" }

// ─── Types ────────────────────────────────────────────────────────────────────

interface WorksiteOption {
  id: string
  name: string
  startDate: string
  endDate: string
}

interface TeamMemberData {
  employee: {
    id: string
    firstName: string
    lastName: string
    employeeAssignments: Array<{
      assignment: { worksite: { id: string; name: string } }
    }>
  }
}

interface TeamData {
  id: string
  name: string
  color: string | null
  leader: { firstName: string; lastName: string }
  members: TeamMemberData[]
  assignments: Array<{ worksite: { id: string; name: string } }>
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default async function PersonnelDisponiblePage({
  searchParams,
}: {
  searchParams: Promise<{ date?: string }>
}) {
  const session = await auth()
  if (!session?.user) redirect("/login")
  if (!["ADMIN", "SUPER_ADMIN"].includes(session.user.role)) redirect("/dashboard")

  const { date } = await searchParams

  let selectedDate: Date
  if (date && /^\d{4}-\d{2}-\d{2}$/.test(date)) {
    selectedDate = new Date(date + "T00:00:00")
  } else {
    const today = new Date()
    today.setHours(0, 0, 0, 0)
    selectedDate = today
  }

  const dateStr = selectedDate.toISOString().split("T")[0]
  const companyId = session.user.companyId!

  const [rawTeams, rawWorksites] = await Promise.all([
    prisma.team.findMany({
      where: { companyId, active: true },
      include: {
        leader: { select: { firstName: true, lastName: true } },
        members: {
          where: { leftAt: null },
          include: {
            employee: {
              select: {
                id: true,
                firstName: true,
                lastName: true,
                employeeAssignments: {
                  where: { date: selectedDate },
                  include: {
                    assignment: {
                      include: { worksite: { select: { id: true, name: true } } },
                    },
                  },
                  take: 1,
                },
              },
            },
          },
          orderBy: { joinedAt: "asc" },
        },
        assignments: {
          where: { date: selectedDate },
          include: { worksite: { select: { id: true, name: true } } },
          take: 1,
        },
      },
      orderBy: { name: "asc" },
    }),
    prisma.worksite.findMany({
      where: {
        companyId,
        status: { in: ["PLANNED", "IN_PROGRESS", "EXTENDED", "DELAYED"] },
      },
      select: { id: true, name: true, startDate: true, endDate: true },
      orderBy: { name: "asc" },
    }),
  ])

  const teams = rawTeams as unknown as TeamData[]
  const worksites: WorksiteOption[] = rawWorksites.map((w) => ({
    id: w.id,
    name: w.name,
    startDate: w.startDate.toISOString().split("T")[0],
    endDate: w.endDate.toISOString().split("T")[0],
  }))

  const available = teams.filter((t) => t.assignments.length === 0)
  const assigned  = teams.filter((t) => t.assignments.length > 0)

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Personnel disponible</h1>
          <p className="text-sm text-slate-500 mt-0.5">
            Visualisez et affectez les équipes pour la journée
          </p>
        </div>
        <PersonnelDateNav currentDate={dateStr} />
      </div>

      {/* Stats */}
      <div className="grid grid-cols-3 gap-4">
        <Card className="border-0 bg-slate-50">
          <CardContent className="pt-4 pb-3 text-center">
            <p className="text-2xl font-bold text-slate-900">{teams.length}</p>
            <p className="text-xs text-slate-500 mt-0.5">Équipes actives</p>
          </CardContent>
        </Card>
        <Card className="border-0 bg-emerald-50">
          <CardContent className="pt-4 pb-3 text-center">
            <p className="text-2xl font-bold text-emerald-700">{available.length}</p>
            <p className="text-xs text-emerald-600 mt-0.5">Disponibles</p>
          </CardContent>
        </Card>
        <Card className="border-0 bg-blue-50">
          <CardContent className="pt-4 pb-3 text-center">
            <p className="text-2xl font-bold text-blue-700">{assigned.length}</p>
            <p className="text-xs text-blue-600 mt-0.5">En chantier</p>
          </CardContent>
        </Card>
      </div>

      {/* Équipes disponibles */}
      {available.length > 0 && (
        <section>
          <h2 className="text-sm font-semibold text-slate-500 uppercase tracking-wider mb-3 flex items-center gap-2">
            <CheckCircle2 className="h-4 w-4 text-emerald-500" />
            Disponibles ({available.length})
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
            {available.map((team) => (
              <TeamCard
                key={team.id}
                team={team}
                worksites={worksites}
                selectedDate={dateStr}
                available
              />
            ))}
          </div>
        </section>
      )}

      {/* Équipes en chantier */}
      {assigned.length > 0 && (
        <section>
          <h2 className="text-sm font-semibold text-slate-500 uppercase tracking-wider mb-3 flex items-center gap-2">
            <AlertCircle className="h-4 w-4 text-blue-500" />
            En chantier ({assigned.length})
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
            {assigned.map((team) => (
              <TeamCard
                key={team.id}
                team={team}
                worksites={worksites}
                selectedDate={dateStr}
                available={false}
              />
            ))}
          </div>
        </section>
      )}

      {teams.length === 0 && (
        <Card>
          <CardContent className="py-16 text-center">
            <Users className="h-10 w-10 text-slate-300 mx-auto mb-3" />
            <p className="text-slate-400 text-sm">Aucune équipe active.</p>
          </CardContent>
        </Card>
      )}
    </div>
  )
}

// ─── TeamCard ─────────────────────────────────────────────────────────────────

function TeamCard({
  team,
  worksites,
  selectedDate,
  available,
}: {
  team: TeamData
  worksites: WorksiteOption[]
  selectedDate: string
  available: boolean
}) {
  const worksiteName = team.assignments[0]?.worksite.name

  return (
    <Card className={available ? "border border-emerald-100" : "border border-slate-100"}>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <span
              className="w-3 h-3 rounded-full shrink-0"
              style={{ backgroundColor: team.color ?? "#0f3460" }}
            />
            <CardTitle className="text-sm font-semibold text-slate-800 truncate">
              {team.name}
            </CardTitle>
          </div>
          <Badge
            variant={available ? "secondary" : "default"}
            className={
              available
                ? "text-[11px] bg-emerald-100 text-emerald-700 border-0 shrink-0"
                : "text-[11px] shrink-0"
            }
          >
            {available ? "Disponible" : (worksiteName ?? "En chantier")}
          </Badge>
        </div>
        <p className="text-xs text-slate-400 pl-5">
          Chef : {team.leader.firstName} {team.leader.lastName}
        </p>
      </CardHeader>

      <CardContent className="space-y-3">
        {/* Membres */}
        <div className="space-y-1">
          {team.members.map(({ employee: emp }) => {
            const empWorksite = emp.employeeAssignments[0]?.assignment.worksite.name
            return (
              <div key={emp.id} className="flex items-center justify-between gap-2">
                <span className="text-xs text-slate-600 truncate">
                  {emp.firstName} {emp.lastName}
                </span>
                {empWorksite ? (
                  <span className="text-[10px] text-blue-600 bg-blue-50 px-1.5 py-0.5 rounded shrink-0 max-w-[120px] truncate">
                    {empWorksite}
                  </span>
                ) : (
                  <span className="text-[10px] text-emerald-600 shrink-0">libre</span>
                )}
              </div>
            )
          })}
          {team.members.length === 0 && (
            <p className="text-xs text-slate-400 italic">Aucun membre actif</p>
          )}
        </div>

        {/* Formulaire d'affectation rapide */}
        <PersonnelAssignForm
          teamId={team.id}
          teamName={team.name}
          worksites={worksites}
          defaultDate={selectedDate}
        />
      </CardContent>
    </Card>
  )
}
