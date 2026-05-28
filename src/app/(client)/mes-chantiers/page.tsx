import type { Metadata } from "next"
import { auth } from "@/auth"
import { redirect } from "next/navigation"
import { prisma } from "@/lib/prisma"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent } from "@/components/ui/card"
import { HardHat, MapPin, Calendar, Users, Clock, ChevronRight } from "lucide-react"
import Link from "next/link"

export const metadata: Metadata = { title: "Mes chantiers" }

const STATUS_STYLE: Record<string, { label: string; variant: "default" | "secondary" | "destructive" | "outline" }> = {
  PLANNED:     { label: "Planifié",   variant: "secondary" },
  IN_PROGRESS: { label: "En cours",  variant: "default" },
  EXTENDED:    { label: "Prolongé",  variant: "outline" },
  COMPLETED:   { label: "Terminé",   variant: "secondary" },
  ARCHIVED:    { label: "Archivé",   variant: "secondary" },
}

function formatDate(d: Date) {
  return new Intl.DateTimeFormat("fr-FR", { day: "2-digit", month: "long", year: "numeric" }).format(d)
}

export default async function MesChantiersPage() {
  const session = await auth()
  if (!session?.user) redirect("/login")

  // Trouver le Client lié à cet utilisateur
  const client = await prisma.client.findFirst({
    where: { companyId: session.user.companyId!, active: true },
    // Un compte CLIENT est lié à un client via son email
    // On cherche le client dont l'email correspond à l'utilisateur
  })

  // On cherche via l'email de l'utilisateur
  const clientRecord = await prisma.client.findFirst({
    where: {
      companyId: session.user.companyId!,
      email: session.user.email!,
    },
  })

  const worksites = clientRecord
    ? await prisma.worksite.findMany({
        where: { clientId: clientRecord.id },
        include: {
          assignments: {
            include: { team: { select: { name: true } } },
            orderBy: { date: "desc" },
            take: 5,
          },
        },
        orderBy: { createdAt: "desc" },
      })
    : []

  const enCours   = worksites.filter((w) => w.status === "IN_PROGRESS").length
  const planifies = worksites.filter((w) => w.status === "PLANNED").length

  return (
    <div className="space-y-6">
      {/* En-tête */}
      <div>
        <h1 className="text-2xl font-bold text-slate-900">Mes chantiers</h1>
        <p className="text-sm text-slate-500 mt-1">
          {enCours > 0 && `${enCours} en cours`}
          {enCours > 0 && planifies > 0 && " · "}
          {planifies > 0 && `${planifies} planifié${planifies > 1 ? "s" : ""}`}
          {worksites.length === 0 && "Aucun chantier"}
        </p>
      </div>

      {worksites.length === 0 ? (
        <Card>
          <CardContent className="py-16 text-center">
            <HardHat className="h-10 w-10 text-slate-200 mx-auto mb-3" />
            <p className="text-slate-400 font-medium">Aucun chantier pour le moment.</p>
            <p className="text-slate-400 text-sm mt-1">Vos chantiers apparaîtront ici.</p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          {worksites.map((w) => {
            const st = STATUS_STYLE[w.status] ?? { label: w.status, variant: "secondary" as const }
            const nextAssignment = w.assignments.find(
              (a) => new Date(a.date) >= new Date() && a.status !== "REFUSED"
            )
            return (
              <Link key={w.id} href={`/mes-chantiers/${w.id}`}>
              <Card className="hover:shadow-md transition-shadow cursor-pointer">
                <CardContent className="p-5">
                  <div className="flex items-start justify-between mb-4">
                    <div className="flex items-center gap-3">
                      <div className="w-10 h-10 rounded-xl bg-slate-100 flex items-center justify-center shrink-0">
                        <HardHat className="h-5 w-5 text-slate-500" />
                      </div>
                      <div>
                        <p className="font-semibold text-slate-900">{w.name}</p>
                        {w.address && (
                          <p className="text-xs text-slate-500 flex items-center gap-1 mt-0.5">
                            <MapPin className="h-3 w-3" /> {w.address}
                          </p>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <Badge variant={st.variant} className="text-xs">{st.label}</Badge>
                      <ChevronRight className="h-4 w-4 text-slate-400" />
                    </div>
                  </div>

                  {/* Dates + heures */}
                  <div className="grid grid-cols-2 gap-3 mb-4">
                    <div className="rounded-lg bg-slate-50 p-3">
                      <div className="flex items-center gap-2 text-xs text-slate-500 mb-1">
                        <Calendar className="h-3.5 w-3.5" /> Période
                      </div>
                      <p className="text-xs font-medium text-slate-700">
                        {formatDate(w.startDate)}
                      </p>
                      <p className="text-xs text-slate-500">→ {formatDate(w.endDate)}</p>
                    </div>
                    <div className="rounded-lg bg-slate-50 p-3">
                      <div className="flex items-center gap-2 text-xs text-slate-500 mb-1">
                        <Clock className="h-3.5 w-3.5" /> Journée type
                      </div>
                      <p className="text-sm font-semibold text-slate-700">{w.dailyHours}h / jour</p>
                    </div>
                  </div>

                  {/* Prochaine intervention */}
                  {nextAssignment ? (
                    <div className="rounded-lg border border-blue-100 bg-blue-50 p-3">
                      <p className="text-xs font-semibold text-blue-800 mb-1">Prochaine intervention</p>
                      <div className="flex items-center gap-2 text-xs text-blue-700">
                        <Calendar className="h-3.5 w-3.5" />
                        {new Intl.DateTimeFormat("fr-FR", { weekday: "long", day: "2-digit", month: "long" }).format(nextAssignment.date)}
                      </div>
                      <div className="flex items-center gap-2 text-xs text-blue-700 mt-0.5">
                        <Users className="h-3.5 w-3.5" />
                        {nextAssignment.team.name}
                      </div>
                    </div>
                  ) : w.status === "IN_PROGRESS" ? (
                    <p className="text-xs text-slate-400 italic">Aucune intervention planifiée prochainement.</p>
                  ) : null}

                  {/* Description */}
                  {w.description && (
                    <p className="text-xs text-slate-500 mt-3 border-t border-slate-100 pt-3">
                      {w.description}
                    </p>
                  )}
                </CardContent>
              </Card>
              </Link>
            )
          })}
        </div>
      )}
    </div>
  )
}
