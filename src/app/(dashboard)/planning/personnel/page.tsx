import type { Metadata } from "next"
import { auth } from "@/auth"
import { redirect } from "next/navigation"
import { prisma } from "@/lib/prisma"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { CheckCircle2, AlertCircle, Users } from "lucide-react"
import { PersonnelDateNav } from "@/components/planning/PersonnelDateNav"
import { PersonnelAssignForm } from "@/components/planning/PersonnelAssignForm"
import { PersonnelViewTabs } from "@/components/planning/PersonnelViewTabs"
import {
  PersonnelDisponibiliteView,
  type EmployeeAvailability,
  type FreeWindow,
  type TimelineSegment,
} from "@/components/planning/PersonnelDisponibiliteView"

export const metadata: Metadata = { title: "Personnel disponible" }

// ─── Types (vue journée) ───────────────────────────────────────────────────────

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
      date: Date
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

// ─── Helpers ──────────────────────────────────────────────────────────────────

function buildAllDates(from: Date, totalDays: number): string[] {
  const dates: string[] = []
  const d = new Date(from)
  for (let i = 0; i < totalDays; i++) {
    dates.push(d.toISOString().split("T")[0])
    d.setDate(d.getDate() + 1)
  }
  return dates
}

function computeWindows(
  allDates: string[],
  occupiedSet: Set<string>
): { windows: FreeWindow[]; timeline: TimelineSegment[] } {
  const windows: FreeWindow[] = []
  const timeline: TimelineSegment[] = []

  let winStart: string | null = null
  let winEnd: string | null = null

  for (const dateStr of allDates) {
    const occupied = occupiedSet.has(dateStr)

    // Build timeline segments (merge consecutive same-state days)
    if (timeline.length === 0 || timeline[timeline.length - 1].occupied !== occupied) {
      timeline.push({ occupied, count: 1 })
    } else {
      timeline[timeline.length - 1].count++
    }

    // Build free windows
    if (!occupied) {
      if (!winStart) winStart = dateStr
      winEnd = dateStr
    } else {
      if (winStart && winEnd) {
        const days =
          Math.floor(
            (new Date(winEnd).getTime() - new Date(winStart).getTime()) / 86400000
          ) + 1
        windows.push({ from: winStart, to: winEnd, days })
      }
      winStart = null
      winEnd = null
    }
  }
  // Flush last window
  if (winStart && winEnd) {
    const days =
      Math.floor(
        (new Date(winEnd).getTime() - new Date(winStart).getTime()) / 86400000
      ) + 1
    windows.push({ from: winStart, to: winEnd, days })
  }

  return { windows, timeline }
}

// ─── Disponibilité immédiate ──────────────────────────────────────────────────

function getFirstFreeWindow(
  allDates: string[],
  occupiedSet: Set<string>
): { from: string; to: string; days: number } | null {
  let winStart: string | null = null
  let winEnd: string | null = null
  for (const d of allDates) {
    if (!occupiedSet.has(d)) {
      if (!winStart) winStart = d
      winEnd = d
    } else if (winStart) {
      break
    }
  }
  if (!winStart || !winEnd) return null
  const days =
    Math.floor((new Date(winEnd).getTime() - new Date(winStart).getTime()) / 86400000) + 1
  return { from: winStart, to: winEnd, days }
}

const FMT_DAY = new Intl.DateTimeFormat("fr-FR", { day: "2-digit", month: "short" })
function fd(s: string) { return FMT_DAY.format(new Date(s + "T00:00:00")) }

function fmtAvailWindow(
  win: { from: string; to: string; days: number },
  selectedDate: string
): string {
  if (win.from === selectedDate) {
    return win.from === win.to ? "libre aujourd'hui" : `libre jusqu'au ${fd(win.to)}`
  }
  return `libre du ${fd(win.from)} au ${fd(win.to)}`
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default async function PersonnelDisponiblePage({
  searchParams,
}: {
  searchParams: Promise<{ date?: string; vue?: string; days?: string }>
}) {
  const session = await auth()
  if (!session?.user) redirect("/login")
  if (!["ADMIN", "SUPER_ADMIN", "TEAM_LEADER"].includes(session.user.role)) redirect("/dashboard")

  const { date, vue: vueParam, days: daysParam } = await searchParams
  const companyId = session.user.companyId!

  const vue = vueParam === "plages" ? "plages" : "jour"

  // ── Vue "Plages de disponibilité" ──────────────────────────────────────────
  if (vue === "plages") {
    const horizon = Math.min(Math.max(parseInt(daysParam ?? "60") || 60, 7), 180)

    const today = new Date()
    today.setHours(0, 0, 0, 0)
    const toDate = new Date(today)
    toDate.setDate(toDate.getDate() + horizon - 1)

    const fromStr = today.toISOString().split("T")[0]
    const toStr   = toDate.toISOString().split("T")[0]
    const allDates = buildAllDates(today, horizon)

    const rawEmployees = await prisma.employee.findMany({
      where: { companyId, active: true },
      include: {
        teamMemberships: {
          where: { leftAt: null },
          include: { team: { select: { name: true, color: true } } },
          orderBy: { joinedAt: "desc" },
          take: 1,
        },
        employeeAssignments: {
          where: { date: { gte: today, lte: toDate } },
          select: { date: true },
        },
      },
      orderBy: [{ firstName: "asc" }, { lastName: "asc" }],
    })

    const employees: EmployeeAvailability[] = rawEmployees.map((emp) => {
      const occupiedSet = new Set(
        emp.employeeAssignments.map((a) => a.date.toISOString().split("T")[0])
      )
      const { windows, timeline } = computeWindows(allDates, occupiedSet)
      const totalFreeDays = windows.reduce((s, w) => s + w.days, 0)
      const team = emp.teamMemberships[0]?.team ?? null

      return {
        id: emp.id,
        firstName: emp.firstName,
        lastName: emp.lastName,
        jobTitle: emp.jobTitle,
        team,
        freeWindows: windows,
        timeline,
        totalFreeDays,
        totalDays: horizon,
      }
    })

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
          <PersonnelViewTabs vue="plages" currentDate={fromStr} />
        </div>

        <PersonnelDisponibiliteView
          employees={employees}
          fromDate={fromStr}
          toDate={toStr}
          horizon={horizon}
        />
      </div>
    )
  }

  // ── Vue "Journée" (existante) ──────────────────────────────────────────────

  let selectedDate: Date
  if (date && /^\d{4}-\d{2}-\d{2}$/.test(date)) {
    selectedDate = new Date(date + "T00:00:00")
  } else {
    const today = new Date()
    today.setHours(0, 0, 0, 0)
    selectedDate = today
  }

  const dateStr = selectedDate.toISOString().split("T")[0]

  // Lookahead 60 jours pour les plages de disponibilité
  const JOUR_HORIZON = 60
  const jourToDate = new Date(selectedDate)
  jourToDate.setDate(jourToDate.getDate() + JOUR_HORIZON - 1)
  const jourAllDates = buildAllDates(selectedDate, JOUR_HORIZON)

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
                  where: { date: { gte: selectedDate, lte: jourToDate } },
                  include: {
                    assignment: {
                      include: { worksite: { select: { id: true, name: true } } },
                    },
                  },
                  orderBy: { date: "asc" },
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
        <div className="flex items-center gap-2 flex-wrap">
          <PersonnelViewTabs vue="jour" currentDate={dateStr} />
          <PersonnelDateNav currentDate={dateStr} />
        </div>
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
                allDates={jourAllDates}
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
                allDates={jourAllDates}
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
  allDates,
  available,
}: {
  team: TeamData
  worksites: WorksiteOption[]
  selectedDate: string
  allDates: string[]
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
        <div className="space-y-1.5">
          {team.members.map(({ employee: emp }) => {
            const occupiedSet = new Set(
              emp.employeeAssignments.map((a) => a.date.toISOString().split("T")[0])
            )
            const todayAssign = emp.employeeAssignments.find(
              (a) => a.date.toISOString().split("T")[0] === selectedDate
            )
            const firstWindow = getFirstFreeWindow(allDates, occupiedSet)

            return (
              <div key={emp.id} className="flex items-start justify-between gap-2">
                <span className="text-xs text-slate-600 truncate shrink-0">
                  {emp.firstName} {emp.lastName}
                </span>
                <div className="flex flex-col items-end gap-0.5 min-w-0">
                  {todayAssign ? (
                    <span className="text-[10px] text-blue-600 bg-blue-50 px-1.5 py-0.5 rounded shrink-0 max-w-[130px] truncate">
                      {todayAssign.assignment.worksite.name}
                    </span>
                  ) : null}
                  {firstWindow ? (
                    <span className="text-[10px] text-emerald-700 font-medium shrink-0">
                      {fmtAvailWindow(firstWindow, selectedDate)}
                    </span>
                  ) : todayAssign ? (
                    <span className="text-[10px] text-slate-400 shrink-0">aucune dispo.</span>
                  ) : (
                    <span className="text-[10px] text-emerald-600 shrink-0">libre</span>
                  )}
                </div>
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
