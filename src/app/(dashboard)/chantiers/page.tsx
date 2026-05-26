import type { Metadata } from "next"
import { auth } from "@/auth"
import { redirect } from "next/navigation"
import { prisma } from "@/lib/prisma"
import Link from "next/link"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent } from "@/components/ui/card"
import { HardHat, MapPin, Calendar, Users, ChevronRight } from "lucide-react"
import { NouveauChantierDialog } from "@/components/chantiers/NouveauChantierDialog"

export const metadata: Metadata = { title: "Chantiers" }

const statusLabels: Record<string, { label: string; variant: "default" | "secondary" | "destructive" | "outline" }> = {
  PLANNED:     { label: "Planifié",    variant: "secondary" },
  IN_PROGRESS: { label: "En cours",   variant: "default" },
  EXTENDED:    { label: "Prolongé",   variant: "outline" },
  COMPLETED:   { label: "Terminé",    variant: "secondary" },
  ARCHIVED:    { label: "Archivé",    variant: "secondary" },
}

function formatDate(date: Date) {
  return new Intl.DateTimeFormat("fr-FR", { day: "2-digit", month: "short", year: "numeric" }).format(date)
}

export default async function ChantiersPage() {
  const session = await auth()
  if (!session?.user) redirect("/login")
  if (!["ADMIN", "SUPER_ADMIN"].includes(session.user.role)) redirect("/dashboard")

  const [chantiers, clients] = await Promise.all([
    prisma.worksite.findMany({
      where: { companyId: session.user.companyId! },
      include: {
        client: { select: { name: true } },
        _count: { select: { assignments: true } },
      },
      orderBy: { createdAt: "desc" },
    }),
    prisma.client.findMany({
      where: { companyId: session.user.companyId!, active: true },
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    }),
  ])

  const enCours   = chantiers.filter((c) => c.status === "IN_PROGRESS").length
  const planifies = chantiers.filter((c) => c.status === "PLANNED").length

  return (
    <div className="space-y-6">
      {/* En-tête */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Chantiers</h1>
          <p className="text-sm text-slate-500 mt-1">
            {enCours} en cours · {planifies} planifié{planifies > 1 ? "s" : ""}
          </p>
        </div>
        <NouveauChantierDialog clients={clients} />
      </div>

      {/* Liste */}
      {chantiers.length === 0 ? (
        <Card>
          <CardContent className="py-16 text-center">
            <HardHat className="h-10 w-10 text-slate-200 mx-auto mb-3" />
            <p className="text-slate-400 font-medium">Aucun chantier pour le moment.</p>
            <p className="text-slate-400 text-sm mt-1">
              Cliquez sur &quot;Nouveau chantier&quot; pour commencer.
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {chantiers.map((chantier) => {
            const status = statusLabels[chantier.status] ?? { label: chantier.status, variant: "secondary" as const }
            return (
              <Link key={chantier.id} href={`/chantiers/${chantier.id}`}>
                <Card className="hover:shadow-md transition-shadow cursor-pointer h-full">
                  <CardContent className="p-5 flex flex-col gap-3">
                    {/* Header */}
                    <div className="flex items-start justify-between">
                      <div className="flex items-center gap-3">
                        <div className="w-10 h-10 rounded-xl bg-slate-100 flex items-center justify-center shrink-0">
                          <HardHat className="h-5 w-5 text-slate-500" />
                        </div>
                        <div>
                          <p className="font-semibold text-slate-900 text-sm leading-tight">{chantier.name}</p>
                          <p className="text-xs text-slate-400 mt-0.5">{chantier.client.name}</p>
                        </div>
                      </div>
                      <div className="flex items-center gap-1">
                        <Badge variant={status.variant} className="text-xs shrink-0">{status.label}</Badge>
                        <ChevronRight className="h-4 w-4 text-slate-300" />
                      </div>
                    </div>

                    {/* Infos */}
                    <div className="space-y-1.5">
                      {chantier.address && (
                        <div className="flex items-center gap-2 text-xs text-slate-500">
                          <MapPin className="h-3.5 w-3.5 shrink-0" />
                          <span className="truncate">{chantier.address}</span>
                        </div>
                      )}
                      <div className="flex items-center gap-2 text-xs text-slate-500">
                        <Calendar className="h-3.5 w-3.5 shrink-0" />
                        {formatDate(chantier.startDate)} → {formatDate(chantier.endDate)}
                      </div>
                      <div className="flex items-center gap-2 text-xs text-slate-500">
                        <Users className="h-3.5 w-3.5 shrink-0" />
                        {chantier._count.assignments} affectation{chantier._count.assignments > 1 ? "s" : ""}
                      </div>
                    </div>
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
