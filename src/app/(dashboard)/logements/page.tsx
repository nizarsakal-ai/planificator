import type { Metadata } from "next"
import { auth } from "@/auth"
import { redirect } from "next/navigation"
import { prisma } from "@/lib/prisma"
import { Card, CardContent } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { BedDouble, MapPin, KeyRound, Phone, User, CalendarDays, FileText } from "lucide-react"
import { NouveauLogementDialog } from "@/components/logements/NouveauLogementDialog"
import { LogementDeleteButton } from "@/components/logements/LogementDeleteButton"
import { PendingBookingsBanner } from "@/components/logements/PendingBookingsBanner"

export const metadata: Metadata = { title: "Logements" }

const statusConfig = {
  UPCOMING:  { label: "À venir",   variant: "secondary" as const, color: "text-blue-600" },
  ACTIVE:    { label: "En cours",  variant: "default"   as const, color: "text-green-600" },
  COMPLETED: { label: "Terminé",   variant: "secondary" as const, color: "text-slate-400" },
  CANCELLED: { label: "Annulé",    variant: "destructive" as const, color: "text-red-500" },
}

function formatDate(date: Date) {
  return new Intl.DateTimeFormat("fr-FR", { day: "2-digit", month: "long", year: "numeric" }).format(date)
}

export default async function LogementsPage() {
  const session = await auth()
  if (!session?.user) redirect("/login")
  if (!["ADMIN", "SUPER_ADMIN"].includes(session.user.role)) redirect("/dashboard")

  const today = new Date()
  today.setHours(0, 0, 0, 0)

  const [accommodations, teams, pendingAccommodations] = await Promise.all([
    prisma.accommodation.findMany({
      where: { companyId: session.user.companyId! },
      include: { team: { select: { name: true, color: true } } },
      orderBy: { startDate: "asc" },
    }),
    prisma.team.findMany({
      where: { companyId: session.user.companyId!, active: true },
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    }),
    prisma.pendingAccommodation.findMany({
      where:   { companyId: session.user.companyId!, status: "PENDING" },
      select:  { id: true, propertyName: true, address: true, city: true, zipCode: true, startDate: true, endDate: true, rawEmailSnippet: true },
      orderBy: { createdAt: "desc" },
    }),
  ])

  // Auto-update statuses for display (without DB write)
  const enriched = accommodations.map((acc) => {
    const start = new Date(acc.startDate)
    const end   = new Date(acc.endDate)
    let status = acc.status
    if (status !== "CANCELLED") {
      if (today > end)          status = "COMPLETED"
      else if (today >= start)  status = "ACTIVE"
      else                      status = "UPCOMING"
    }
    return { ...acc, statusDisplay: status }
  })

  const upcoming  = enriched.filter((a) => a.statusDisplay === "UPCOMING").length
  const active    = enriched.filter((a) => a.statusDisplay === "ACTIVE").length
  const completed = enriched.filter((a) => a.statusDisplay === "COMPLETED").length

  return (
    <div className="space-y-6">
      {/* En-tête */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Logements</h1>
          <p className="text-sm text-slate-500 mt-1">
            {upcoming} à venir · {active} en cours · {completed} terminé{completed > 1 ? "s" : ""}
          </p>
        </div>
        <NouveauLogementDialog teams={teams} />
      </div>

      {/* Réservations Booking.com en attente */}
      {pendingAccommodations.length > 0 && (
        <PendingBookingsBanner pendings={pendingAccommodations} teams={teams} />
      )}

      {/* KPI */}
      <div className="grid grid-cols-3 gap-4">
        {[
          { label: "À venir",  count: upcoming,  color: "text-blue-600",  bg: "bg-blue-50"  },
          { label: "En cours", count: active,    color: "text-green-600", bg: "bg-green-50" },
          { label: "Terminés", count: completed, color: "text-slate-500", bg: "bg-slate-50" },
        ].map((kpi) => (
          <Card key={kpi.label}>
            <CardContent className="p-4 text-center">
              <p className={`text-2xl font-bold ${kpi.color}`}>{kpi.count}</p>
              <p className="text-xs text-slate-500 mt-1">{kpi.label}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Liste */}
      {enriched.length === 0 ? (
        <Card>
          <CardContent className="py-16 text-center">
            <BedDouble className="h-10 w-10 text-slate-200 mx-auto mb-3" />
            <p className="text-slate-400 font-medium">Aucun logement pour le moment.</p>
            <p className="text-slate-400 text-sm mt-1">
              Cliquez sur &quot;Nouveau logement&quot; pour en créer un.
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {enriched.map((acc) => {
            const cfg = statusConfig[acc.statusDisplay as keyof typeof statusConfig] ?? statusConfig.UPCOMING
            return (
              <Card key={acc.id} className="overflow-hidden hover:shadow-sm transition-shadow">
                <div className="h-1 w-full" style={{ backgroundColor: acc.team.color ?? "#0f3460" }} />
                <CardContent className="p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex items-start gap-3 min-w-0">
                      {/* Icône */}
                      <div
                        className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0"
                        style={{ backgroundColor: `${acc.team.color ?? "#0f3460"}15` }}
                      >
                        <BedDouble className="h-5 w-5" style={{ color: acc.team.color ?? "#0f3460" }} />
                      </div>

                      <div className="min-w-0 space-y-1.5">
                        {/* Équipe + dates */}
                        <div className="flex items-center gap-2 flex-wrap">
                          <span
                            className="font-semibold text-slate-800"
                            style={{ color: acc.team.color ?? "#0f3460" }}
                          >
                            {acc.team.name}
                          </span>
                          <Badge variant={cfg.variant} className="text-xs">{cfg.label}</Badge>
                        </div>

                        <div className="flex items-center gap-1.5 text-xs text-slate-500">
                          <CalendarDays className="h-3.5 w-3.5 shrink-0" />
                          {formatDate(acc.startDate)} → {formatDate(acc.endDate)}
                        </div>

                        {/* Adresse */}
                        <div className="flex items-start gap-1.5 text-xs text-slate-600">
                          <MapPin className="h-3.5 w-3.5 shrink-0 mt-0.5 text-slate-400" />
                          <span>{acc.address}{acc.city ? `, ${acc.city}` : ""}{acc.zipCode ? ` ${acc.zipCode}` : ""}</span>
                        </div>

                        {/* Infos accès */}
                        <div className="flex flex-wrap gap-3">
                          {acc.doorCode && (
                            <div className="flex items-center gap-1 text-xs text-slate-500">
                              <KeyRound className="h-3.5 w-3.5 text-slate-400" />
                              {acc.doorCode}
                            </div>
                          )}
                          {acc.contactPhone && (
                            <div className="flex items-center gap-1 text-xs text-slate-500">
                              <Phone className="h-3.5 w-3.5 text-slate-400" />
                              {acc.contactName ? `${acc.contactName} · ` : ""}{acc.contactPhone}
                            </div>
                          )}
                          {acc.contactName && !acc.contactPhone && (
                            <div className="flex items-center gap-1 text-xs text-slate-500">
                              <User className="h-3.5 w-3.5 text-slate-400" />
                              {acc.contactName}
                            </div>
                          )}
                        </div>

                        {/* Notes */}
                        {acc.notes && (
                          <div className="flex items-start gap-1.5 text-xs text-slate-400">
                            <FileText className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                            <span className="italic">{acc.notes}</span>
                          </div>
                        )}
                      </div>
                    </div>

                    <LogementDeleteButton id={acc.id} />
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
