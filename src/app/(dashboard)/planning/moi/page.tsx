import type { Metadata } from "next"
import { auth } from "@/auth"
import { redirect } from "next/navigation"
import { prisma } from "@/lib/prisma"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent } from "@/components/ui/card"
import { HardHat, MapPin, Clock, CalendarDays, Users, BedDouble, KeyRound, Phone } from "lucide-react"
import Link from "next/link"

export const metadata: Metadata = { title: "Mon Planning" }

const STATUS_STYLE: Record<string, { label: string; variant: "default" | "secondary" | "destructive" | "outline" }> = {
  CONFIRMED: { label: "Confirmé",   variant: "default" },
  PENDING:   { label: "En attente", variant: "secondary" },
  REFUSED:   { label: "Refusé",     variant: "destructive" },
}

function formatDay(d: Date) {
  return new Intl.DateTimeFormat("fr-FR", { weekday: "long", day: "2-digit", month: "long", year: "numeric" }).format(d)
}

function isUpcoming(d: Date) {
  const today = new Date(); today.setHours(0,0,0,0)
  return d >= today
}

export default async function MonPlanningPage() {
  const session = await auth()
  if (!session?.user) redirect("/login")

  // Trouver l'employé lié à cet utilisateur avec son équipe et son chef
  const employee = await prisma.employee.findFirst({
    where: { userId: session.user.id },
    select: {
      id: true,
      firstName: true,
      lastName: true,
      teamMemberships: {
        where: { leftAt: null },
        select: {
          team: {
            select: {
              id: true,
              name: true,
              color: true,
              leader: { select: { firstName: true, lastName: true } },
            },
          },
        },
        take: 1,
      },
    },
  })

  if (!employee) {
    return (
      <div className="space-y-6">
        <h1 className="text-2xl font-bold text-slate-900">Mon Planning</h1>
        <Card>
          <CardContent className="py-16 text-center">
            <CalendarDays className="h-10 w-10 text-slate-200 mx-auto mb-3" />
            <p className="text-slate-400 font-medium">Profil employé introuvable.</p>
            <p className="text-slate-400 text-sm mt-1">Contactez votre administrateur.</p>
          </CardContent>
        </Card>
      </div>
    )
  }

  // Récupérer les affectations des 30 derniers jours + 60 jours à venir
  const from = new Date(); from.setDate(from.getDate() - 30); from.setHours(0,0,0,0)
  const to   = new Date(); to.setDate(to.getDate() + 60);   to.setHours(23,59,59,999)
  const todayDate = new Date(); todayDate.setHours(0,0,0,0)

  // Logements de l'équipe à venir
  const teamId = employee.teamMemberships[0]?.team?.id
  const accommodations = teamId ? await prisma.accommodation.findMany({
    where: {
      teamId,
      companyId: session.user.companyId!,
      endDate: { gte: todayDate },
      status: { not: "CANCELLED" },
    },
    orderBy: { startDate: "asc" },
  }) : []

  const assignments = await prisma.employeeAssignment.findMany({
    where: {
      employeeId: employee.id,
      date: { gte: from, lte: to },
    },
    include: {
      assignment: {
        include: {
          worksite: { select: { id: true, name: true, address: true, dailyHours: true } },
          team:     { select: { name: true } },
        },
      },
    },
    orderBy: { date: "asc" },
  })

  const upcoming = assignments.filter((a) => isUpcoming(a.date))
  const past     = assignments.filter((a) => !isUpcoming(a.date))
  const myTeam   = employee.teamMemberships[0]?.team

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">Mon Planning</h1>
        <p className="text-sm text-slate-500 mt-1">
          {employee.firstName} {employee.lastName} · {upcoming.length} affectation{upcoming.length > 1 ? "s" : ""} à venir
        </p>
      </div>

      {/* Mon équipe & chef d'équipe */}
      {myTeam && (
        <Card>
          <CardContent className="p-4 flex items-center gap-4">
            <div
              className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0"
              style={{ backgroundColor: myTeam.color ?? "#0f3460" }}
            >
              <Users className="h-5 w-5 text-white" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-semibold text-slate-800">{myTeam.name}</p>
              <p className="text-xs text-slate-500">
                Chef d&apos;équipe : <span className="font-medium text-slate-700">{myTeam.leader.firstName} {myTeam.leader.lastName}</span>
              </p>
            </div>
            <Link
              href="/chantiers"
              className="text-xs text-[#0f3460] hover:underline font-medium shrink-0"
            >
              Mes chantiers →
            </Link>
          </CardContent>
        </Card>
      )}

      {/* Logements */}
      {accommodations.length > 0 && (
        <div className="space-y-3">
          <h2 className="text-sm font-semibold text-slate-700 uppercase tracking-wide flex items-center gap-2">
            <BedDouble className="h-4 w-4 text-[#0f3460]" />
            Mon logement
          </h2>
          {accommodations.map((acc) => {
            const fmtDate = (d: Date) =>
              new Intl.DateTimeFormat("fr-FR", { day: "2-digit", month: "long", year: "numeric" }).format(d)
            const isActive = todayDate >= new Date(acc.startDate) && todayDate <= new Date(acc.endDate)
            return (
              <Card key={acc.id} className="border-l-4" style={{ borderLeftColor: "#0f3460" }}>
                <CardContent className="p-4 space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <BedDouble className="h-4 w-4 text-[#0f3460]" />
                      <span className="text-sm font-semibold text-slate-800">
                        {isActive ? "Hébergement en cours" : "Hébergement à venir"}
                      </span>
                    </div>
                    <Badge variant={isActive ? "default" : "secondary"} className="text-xs shrink-0">
                      {isActive ? "En cours" : "À venir"}
                    </Badge>
                  </div>
                  <p className="text-xs text-slate-500 font-medium">
                    {fmtDate(acc.startDate)} → {fmtDate(acc.endDate)}
                  </p>
                  <div className="flex items-start gap-1.5 text-xs text-slate-600">
                    <MapPin className="h-3.5 w-3.5 shrink-0 mt-0.5 text-slate-400" />
                    <span>{acc.address}{acc.city ? `, ${acc.city}` : ""}{acc.zipCode ? ` ${acc.zipCode}` : ""}</span>
                  </div>
                  {acc.doorCode && (
                    <div className="flex items-center gap-1.5 text-xs text-slate-600">
                      <KeyRound className="h-3.5 w-3.5 text-slate-400" />
                      Code porte : <strong>{acc.doorCode}</strong>
                    </div>
                  )}
                  {acc.contactPhone && (
                    <div className="flex items-center gap-1.5 text-xs text-slate-600">
                      <Phone className="h-3.5 w-3.5 text-slate-400" />
                      {acc.contactName ? `${acc.contactName} · ` : ""}{acc.contactPhone}
                    </div>
                  )}
                  {acc.notes && (
                    <p className="text-xs text-slate-400 italic">{acc.notes}</p>
                  )}
                </CardContent>
              </Card>
            )
          })}
        </div>
      )}

      {/* À venir */}
      <div className="space-y-3">
        <h2 className="text-sm font-semibold text-slate-700 uppercase tracking-wide">À venir</h2>
        {upcoming.length === 0 ? (
          <Card>
            <CardContent className="py-12 text-center">
              <CalendarDays className="h-8 w-8 text-slate-200 mx-auto mb-2" />
              <p className="text-slate-400 text-sm">Aucune affectation prévue.</p>
            </CardContent>
          </Card>
        ) : (
          upcoming.map((ea) => {
            const a  = ea.assignment
            const st = STATUS_STYLE[a.status] ?? { label: a.status, variant: "secondary" as const }
            return (
              <Card key={ea.id} className="border-l-4 border-l-[#0f3460]">
                <CardContent className="p-4 flex items-start justify-between gap-4">
                  <div className="space-y-1.5">
                    <div className="flex items-center gap-2">
                      <HardHat className="h-4 w-4 text-[#0f3460]" />
                      <p className="font-semibold text-slate-800 text-sm">{a.worksite.name}</p>
                    </div>
                    <p className="text-xs text-slate-500 font-medium capitalize">{formatDay(ea.date)}</p>
                    {a.worksite.address && (
                      <div className="flex items-center gap-1.5 text-xs text-slate-500">
                        <MapPin className="h-3.5 w-3.5 shrink-0" />
                        {a.worksite.address}
                      </div>
                    )}
                    <div className="flex items-center gap-1.5 text-xs text-slate-500">
                      <Clock className="h-3.5 w-3.5 shrink-0" />
                      {a.worksite.dailyHours}h · Équipe : {a.team.name}
                    </div>
                  </div>
                  <Badge variant={st.variant} className="shrink-0 text-xs">{st.label}</Badge>
                </CardContent>
              </Card>
            )
          })
        )}
      </div>

      {/* Passé */}
      {past.length > 0 && (
        <div className="space-y-3">
          <h2 className="text-sm font-semibold text-slate-400 uppercase tracking-wide">Passé</h2>
          {past.reverse().map((ea) => {
            const a  = ea.assignment
            const st = STATUS_STYLE[a.status] ?? { label: a.status, variant: "secondary" as const }
            return (
              <Card key={ea.id} className="opacity-60">
                <CardContent className="p-4 flex items-start justify-between gap-4">
                  <div className="space-y-1">
                    <div className="flex items-center gap-2">
                      <HardHat className="h-4 w-4 text-slate-400" />
                      <p className="font-medium text-slate-600 text-sm">{a.worksite.name}</p>
                    </div>
                    <p className="text-xs text-slate-400 capitalize">{formatDay(ea.date)}</p>
                    <p className="text-xs text-slate-400">Équipe : {a.team.name}</p>
                  </div>
                  <Badge variant={st.variant} className="shrink-0 text-xs">{st.label}</Badge>
                </CardContent>
              </Card>
            )
          })}
        </div>
      )}
    </div>
  )
}
