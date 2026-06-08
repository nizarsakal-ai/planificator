import type { Metadata } from "next"
import { auth } from "@/auth"
import { redirect } from "next/navigation"
import { prisma } from "@/lib/prisma"
import Link from "next/link"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent } from "@/components/ui/card"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Layers, Crown, Users, ChevronRight } from "lucide-react"
import { getInitials } from "@/lib/utils"
import { NouvelleEquipeDialog } from "@/components/equipes/NouvelleEquipeDialog"
import { MembreActions } from "@/components/equipes/MembreActions"

export const metadata: Metadata = { title: "Équipes" }

export default async function EquipesPage() {
  const session = await auth()
  if (!session?.user) redirect("/login")
  if (!["ADMIN", "SUPER_ADMIN", "TEAM_LEADER"].includes(session.user.role)) redirect("/dashboard")

  const [teams, employees] = await Promise.all([
    prisma.team.findMany({
      where: { companyId: session.user.companyId! },
      include: {
        leader: true,
        members: {
          where: { leftAt: null },
          include: { employee: true },
          orderBy: { joinedAt: "asc" },
        },
      },
      orderBy: { name: "asc" },
    }),
    prisma.employee.findMany({
      where: { companyId: session.user.companyId!, active: true },
      orderBy: { firstName: "asc" },
      select: { id: true, firstName: true, lastName: true, jobTitle: true },
    }),
  ])

  const actives = teams.filter((t) => t.active).length

  return (
    <div className="space-y-6">
      {/* En-tête */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Équipes</h1>
          <p className="text-sm text-slate-500 mt-1">
            {actives} équipe{actives > 1 ? "s" : ""} active{actives > 1 ? "s" : ""}
          </p>
        </div>
        <NouvelleEquipeDialog employees={employees} />
      </div>

      {/* Liste des équipes */}
      {teams.length === 0 ? (
        <Card>
          <CardContent className="py-16 text-center">
            <Layers className="h-10 w-10 text-slate-200 mx-auto mb-3" />
            <p className="text-slate-400 font-medium">Aucune équipe pour le moment.</p>
            <p className="text-slate-400 text-sm mt-1">
              Cliquez sur &quot;Nouvelle équipe&quot; pour commencer.
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
          {teams.map((team) => {
            const membresActifs = team.members.filter((m) => m.leftAt === null)

            return (
              <Card
                key={team.id}
                className={`overflow-hidden hover:shadow-md transition-shadow ${!team.active ? "opacity-60" : ""}`}
              >
                {/* Bande couleur en haut */}
                <div
                  className="h-1.5 w-full"
                  style={{ backgroundColor: team.color ?? "#0f3460" }}
                />

                <CardContent className="p-5">
                  {/* Header cliquable */}
                  <Link href={`/equipes/${team.id}`} className="flex items-start justify-between mb-4 group">
                    <div className="flex items-center gap-3">
                      <div
                        className="w-10 h-10 rounded-xl flex items-center justify-center text-white font-bold text-sm shrink-0"
                        style={{ backgroundColor: team.color ?? "#0f3460" }}
                      >
                        {team.name.charAt(0).toUpperCase()}
                      </div>
                      <div>
                        <h3 className="font-semibold text-slate-900 group-hover:text-[#0f3460] transition-colors">{team.name}</h3>
                        <p className="text-xs text-slate-400 flex items-center gap-1 mt-0.5">
                          <Users className="h-3 w-3" />
                          {membresActifs.length} membre{membresActifs.length > 1 ? "s" : ""}
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <Badge variant={team.active ? "default" : "secondary"}>
                        {team.active ? "Active" : "Archivée"}
                      </Badge>
                      <ChevronRight className="h-4 w-4 text-slate-400 group-hover:text-[#0f3460] transition-colors" />
                    </div>
                  </Link>

                  {/* Chef d'équipe */}
                  <div className="flex items-center gap-2 p-2.5 bg-amber-50 rounded-lg mb-4">
                    <Crown className="h-4 w-4 text-amber-500 shrink-0" />
                    <div>
                      <p className="text-xs text-amber-700 font-medium">Chef d'équipe</p>
                      <p className="text-sm font-semibold text-slate-800">
                        {team.leader.firstName} {team.leader.lastName}
                      </p>
                    </div>
                  </div>

                  {/* Membres */}
                  <div className="space-y-1">
                    <p className="text-xs font-medium text-slate-500 uppercase tracking-wide mb-2">
                      Membres
                    </p>
                    {membresActifs.length === 0 ? (
                      <p className="text-xs text-slate-400 italic py-2">
                        Aucun membre dans cette équipe.
                      </p>
                    ) : (
                      membresActifs.map((membre) => {
                        const isLeader = membre.employeeId === team.leaderId
                        const name = `${membre.employee.firstName} ${membre.employee.lastName}`

                        return (
                          <div
                            key={membre.id}
                            className="flex items-center justify-between py-1.5 px-2 rounded-lg hover:bg-slate-50"
                          >
                            <div className="flex items-center gap-2">
                              <Avatar className="h-7 w-7">
                                <AvatarImage src={membre.employee.avatarUrl ?? undefined} alt={name} />
                                <AvatarFallback
                                  className="text-white text-xs font-medium"
                                  style={{ backgroundColor: team.color ?? "#0f3460" }}
                                >
                                  {getInitials(name)}
                                </AvatarFallback>
                              </Avatar>
                              <div>
                                <p className="text-sm text-slate-800 font-medium leading-tight">
                                  {name}
                                </p>
                                {membre.employee.jobTitle && (
                                  <p className="text-xs text-slate-400">
                                    {membre.employee.jobTitle}
                                  </p>
                                )}
                              </div>
                            </div>
                            <MembreActions
                              teamId={team.id}
                              employeeId={membre.employeeId}
                              isLeader={isLeader}
                            />
                          </div>
                        )
                      })
                    )}
                  </div>

                  {/* Capacité */}
                  <div className="mt-4 pt-3 border-t border-slate-100">
                    <div className="flex items-center justify-between text-xs text-slate-400">
                      <span>Capacité recommandée : 5-6 membres</span>
                      <span
                        className={
                          membresActifs.length >= 5 && membresActifs.length <= 6
                            ? "text-green-600 font-medium"
                            : membresActifs.length > 6
                              ? "text-orange-500 font-medium"
                              : "text-slate-400"
                        }
                      >
                        {membresActifs.length}/6
                      </span>
                    </div>
                    <div className="mt-1.5 h-1.5 bg-slate-100 rounded-full overflow-hidden">
                      <div
                        className="h-full rounded-full transition-all"
                        style={{
                          width: `${Math.min((membresActifs.length / 6) * 100, 100)}%`,
                          backgroundColor: team.color ?? "#0f3460",
                        }}
                      />
                    </div>
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
