import type { Metadata } from "next"
import { auth } from "@/auth"
import { redirect } from "next/navigation"
import { prisma } from "@/lib/prisma"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent } from "@/components/ui/card"
import { UserCheck, Mail, Phone, MapPin, FileText, HardHat } from "lucide-react"
import { NouveauClientDialog } from "@/components/clients/NouveauClientDialog"
import { ClientActions } from "@/components/clients/ClientActions"

export const metadata: Metadata = { title: "Clients" }

export default async function ClientsPage() {
  const session = await auth()
  if (!session?.user) redirect("/login")
  if (!["ADMIN", "SUPER_ADMIN", "TEAM_LEADER"].includes(session.user.role)) redirect("/dashboard")

  const clients = await prisma.client.findMany({
    where: { companyId: session.user.companyId! },
    include: {
      _count: {
        select: { worksites: true },
      },
    },
    orderBy: { name: "asc" },
  })

  const actifs = clients.filter((c) => c.active).length

  return (
    <div className="space-y-6">
      {/* En-tête */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Clients</h1>
          <p className="text-sm text-slate-500 mt-1">
            {actifs} client{actifs > 1 ? "s" : ""} actif{actifs > 1 ? "s" : ""}
            {clients.length - actifs > 0 && ` · ${clients.length - actifs} inactif${clients.length - actifs > 1 ? "s" : ""}`}
          </p>
        </div>
        <NouveauClientDialog />
      </div>

      {/* Liste */}
      {clients.length === 0 ? (
        <Card>
          <CardContent className="py-16 text-center">
            <UserCheck className="h-10 w-10 text-slate-200 mx-auto mb-3" />
            <p className="text-slate-400 font-medium">Aucun client pour le moment.</p>
            <p className="text-slate-400 text-sm mt-1">
              Cliquez sur &quot;Nouveau client&quot; pour commencer.
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {clients.map((client) => (
            <Card
              key={client.id}
              className={`hover:shadow-md transition-shadow ${!client.active ? "opacity-60" : ""}`}
            >
              <CardContent className="p-5">
                {/* Header */}
                <div className="flex items-start justify-between mb-4">
                  <div className="flex items-center gap-3">
                    {/* Avatar initiale */}
                    <div className="w-11 h-11 rounded-xl bg-slate-100 flex items-center justify-center font-bold text-slate-600 text-sm shrink-0">
                      {client.name.charAt(0).toUpperCase()}
                    </div>
                    <div>
                      <p className="font-semibold text-slate-900 text-sm leading-tight">
                        {client.name}
                      </p>
                      <p className="text-xs text-slate-400 mt-0.5 flex items-center gap-1">
                        <HardHat className="h-3 w-3" />
                        {client._count.worksites} chantier{client._count.worksites > 1 ? "s" : ""}
                      </p>
                    </div>
                  </div>
                  <Badge variant={client.active ? "default" : "secondary"} className="text-xs shrink-0">
                    {client.active ? "Actif" : "Inactif"}
                  </Badge>
                </div>

                {/* Infos contact */}
                <div className="space-y-1.5 mb-4">
                  {client.email && (
                    <div className="flex items-center gap-2 text-xs text-slate-500">
                      <Mail className="h-3.5 w-3.5 shrink-0" />
                      <span className="truncate">{client.email}</span>
                    </div>
                  )}
                  {client.phone && (
                    <div className="flex items-center gap-2 text-xs text-slate-500">
                      <Phone className="h-3.5 w-3.5 shrink-0" />
                      {client.phone}
                    </div>
                  )}
                  {client.address && (
                    <div className="flex items-center gap-2 text-xs text-slate-500">
                      <MapPin className="h-3.5 w-3.5 shrink-0" />
                      <span className="truncate">{client.address}</span>
                    </div>
                  )}
                  {client.notes && (
                    <div className="flex items-start gap-2 text-xs text-slate-500">
                      <FileText className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                      <span className="line-clamp-2">{client.notes}</span>
                    </div>
                  )}
                  {!client.email && !client.phone && !client.address && (
                    <p className="text-xs text-slate-300 italic">Aucune information de contact.</p>
                  )}
                </div>

                {/* Actions */}
                <div className="border-t border-slate-100 pt-3 flex justify-end">
                  <ClientActions clientId={client.id} active={client.active} />
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  )
}
