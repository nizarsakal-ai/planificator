import type { Metadata } from "next"
import { auth } from "@/auth"
import { redirect } from "next/navigation"
import { prisma } from "@/lib/prisma"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Users, LogIn, Clock } from "lucide-react"
import { PointagesAdminView } from "@/components/pointage/PointagesAdminView"
import { DateNavigation } from "@/components/pointage/DateNavigation"

export const metadata: Metadata = { title: "Pointages" }

interface PageProps {
  searchParams: Promise<{ date?: string }>
}

export default async function PointagesPage({ searchParams }: PageProps) {
  const session = await auth()
  if (!session?.user) redirect("/login")

  const isAdmin      = ["ADMIN", "SUPER_ADMIN"].includes(session.user.role)
  const isTeamLeader = session.user.role === "TEAM_LEADER"
  if (!isAdmin && !isTeamLeader) redirect("/dashboard")

  const companyId = session.user.companyId!

  // Pour TEAM_LEADER : filtrer aux membres de son équipe
  let memberIds: string[] | undefined
  if (isTeamLeader) {
    const leaderEmployee = await prisma.employee.findFirst({
      where: { userId: session.user.id!, companyId },
      select: {
        ledTeams: {
          where: { active: true },
          select: { members: { where: { leftAt: null }, select: { employeeId: true } } },
          take: 1,
        },
      },
    })
    memberIds = leaderEmployee?.ledTeams[0]?.members.map((m) => m.employeeId) ?? []
    if (memberIds.length === 0) redirect("/dashboard")
  }

  const { date: dateParam } = await searchParams
  const selectedDate = dateParam ? new Date(dateParam) : new Date()
  selectedDate.setHours(0, 0, 0, 0)

  const pointages = await prisma.timeclock.findMany({
    where: {
      companyId,
      date: selectedDate,
      ...(isTeamLeader ? { employeeId: { in: memberIds } } : {}),
    },
    include: {
      employee: { select: { firstName: true, lastName: true, avatarUrl: true } },
      worksite: { select: { name: true } },
    },
    orderBy: { checkInAt: "asc" },
  })

  const presents  = pointages.filter((p) => p.checkInAt).length
  const partis    = pointages.filter((p) => p.checkOutAt).length
  const enCours   = presents - partis

  function fmtDate(d: Date) {
    return new Intl.DateTimeFormat("fr-FR", { weekday: "long", day: "2-digit", month: "long", year: "numeric" }).format(d)
  }

  // Calculer les dates navigation
  const prev = new Date(selectedDate); prev.setDate(prev.getDate() - 1)
  const next = new Date(selectedDate); next.setDate(next.getDate() + 1)
  const isToday = selectedDate.toDateString() === new Date().toDateString()

  function toISO(d: Date) {
    const y = d.getFullYear()
    const m = String(d.getMonth() + 1).padStart(2, "0")
    const day = String(d.getDate()).padStart(2, "0")
    return `${y}-${m}-${day}`
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">
            {isTeamLeader ? "Pointages de mon équipe" : "Pointages"}
          </h1>
          <p className="text-sm text-slate-500 mt-1 capitalize">{fmtDate(selectedDate)}</p>
        </div>

        <DateNavigation
          selectedDate={toISO(selectedDate)}
          prevDate={toISO(prev)}
          nextDate={toISO(next)}
          isToday={isToday}
        />
      </div>

      {/* Stats */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <Card>
          <CardContent className="p-4 flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-green-50 flex items-center justify-center">
              <LogIn className="h-5 w-5 text-green-600" />
            </div>
            <div>
              <p className="text-2xl font-bold text-slate-900">{presents}</p>
              <p className="text-xs text-slate-500">Présences</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-amber-50 flex items-center justify-center">
              <Clock className="h-5 w-5 text-amber-500" />
            </div>
            <div>
              <p className="text-2xl font-bold text-slate-900">{enCours}</p>
              <p className="text-xs text-slate-500">En cours</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-blue-50 flex items-center justify-center">
              <Users className="h-5 w-5 text-blue-500" />
            </div>
            <div>
              <p className="text-2xl font-bold text-slate-900">{partis}</p>
              <p className="text-xs text-slate-500">Partis</p>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Liste / Carte */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">
            {pointages.length === 0
              ? "Aucun pointage"
              : `${pointages.length} pointage${pointages.length > 1 ? "s" : ""}`}
          </CardTitle>
        </CardHeader>
        {pointages.length > 0 && (
          <CardContent className="p-0">
            <PointagesAdminView pointages={pointages} />
          </CardContent>
        )}
        {pointages.length === 0 && (
          <CardContent className="py-10 text-center">
            <Users className="h-8 w-8 text-slate-200 mx-auto mb-2" />
            <p className="text-slate-400 text-sm">Aucun pointage enregistré pour cette journée.</p>
          </CardContent>
        )}
      </Card>
    </div>
  )
}
