import type { Metadata } from "next"
import { auth } from "@/auth"
import { prisma } from "@/lib/prisma"
import { redirect } from "next/navigation"
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import {
  Users,
  Layers,
  Building2,
  UserCheck,
  Calendar,
  HardHat,
  TrendingUp,
  AlertCircle,
  ArrowRight,
} from "lucide-react"
import { formatDate } from "@/lib/utils"
import { AssignmentsChart } from "@/components/dashboard/AssignmentsChart"
import { WorksiteStatusChart } from "@/components/dashboard/WorksiteStatusChart"

export const metadata: Metadata = { title: "Dashboard" }

// ─── Composant carte statistique ────────────────────────────────────────────

function StatCard({
  title,
  value,
  icon: Icon,
  description,
  color = "blue",
}: {
  title: string
  value: number | string
  icon: React.ElementType
  description?: string
  color?: "blue" | "green" | "orange" | "purple"
}) {
  const colors = {
    blue: "bg-blue-50 text-blue-600",
    green: "bg-green-50 text-green-600",
    orange: "bg-orange-50 text-orange-600",
    purple: "bg-purple-50 text-purple-600",
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="text-sm font-medium text-slate-600">
          {title}
        </CardTitle>
        <div className={`p-2 rounded-lg ${colors[color]}`}>
          <Icon className="h-4 w-4" />
        </div>
      </CardHeader>
      <CardContent>
        <div className="text-3xl font-bold text-slate-900">{value}</div>
        {description && (
          <p className="text-xs text-slate-500 mt-1">{description}</p>
        )}
      </CardContent>
    </Card>
  )
}

// ─── Dashboard Super Admin ───────────────────────────────────────────────────

async function SuperAdminDashboard() {
  const [companiesCount, usersCount] = await Promise.all([
    prisma.company.count({ where: { active: true } }),
    prisma.user.count({ where: { active: true } }),
  ])

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <StatCard
          title="Entreprises actives"
          value={companiesCount}
          icon={Building2}
          description="Multi-tenant"
          color="blue"
        />
        <StatCard
          title="Utilisateurs totaux"
          value={usersCount}
          icon={Users}
          description="Tous rôles confondus"
          color="green"
        />
      </div>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Accès rapide</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-slate-500">
            Gérez les entreprises depuis le menu{" "}
            <span className="font-medium text-slate-700">Entreprises</span>{" "}
            dans la barre latérale.
          </p>
        </CardContent>
      </Card>
    </div>
  )
}

// ─── Dashboard Admin ─────────────────────────────────────────────────────────

async function AdminDashboard({ companyId }: { companyId: string }) {
  const now   = new Date()
  const day30 = new Date(now); day30.setDate(day30.getDate() - 29); day30.setHours(0,0,0,0)

  const [
    employeesCount, teamsCount, clientsCount,
    worksitesByStatus, recentAssignments, pendingAbsences,
  ] = await Promise.all([
    prisma.employee.count({ where: { companyId, active: true } }),
    prisma.team.count({ where: { companyId, active: true } }),
    prisma.client.count({ where: { companyId, active: true } }),
    prisma.worksite.groupBy({
      by: ["status"],
      where: { companyId },
      _count: { _all: true },
    }),
    prisma.assignment.findMany({
      where: { worksite: { companyId }, date: { gte: day30 } },
      select: { date: true },
    }),
    prisma.absence.count({ where: { companyId: companyId, status: "PENDING" } }),
  ])

  const worksitesCount = worksitesByStatus
    .filter((w) => ["PLANNED", "IN_PROGRESS", "EXTENDED"].includes(w.status))
    .reduce((s, w) => s + w._count._all, 0)

  // Graphique affectations : 30 derniers jours regroupés par semaine
  const weekMap: Record<string, number> = {}
  recentAssignments.forEach(({ date }) => {
    const d = new Date(date)
    const weekStart = new Date(d)
    weekStart.setDate(d.getDate() - d.getDay() + 1)
    const key = new Intl.DateTimeFormat("fr-FR", { day: "2-digit", month: "short" }).format(weekStart)
    weekMap[key] = (weekMap[key] ?? 0) + 1
  })
  const chartData = Object.entries(weekMap).map(([day, count]) => ({ day, count }))

  // Graphique statuts chantiers
  const statusMap: Record<string, number> = {}
  worksitesByStatus.forEach((w) => { statusMap[w.status] = w._count._all })
  const pieData = [
    { name: "Planifié",   value: statusMap["PLANNED"]     ?? 0, color: "#94a3b8" },
    { name: "En cours",   value: statusMap["IN_PROGRESS"] ?? 0, color: "#0f3460" },
    { name: "Prolongé",   value: statusMap["EXTENDED"]    ?? 0, color: "#f59e0b" },
    { name: "Terminé",    value: statusMap["COMPLETED"]   ?? 0, color: "#22c55e" },
  ]

  return (
    <div className="space-y-6">
      {/* KPIs */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard title="Employés"          value={employeesCount} icon={Users}    description="Actifs"                              color="blue"   />
        <StatCard title="Équipes"           value={teamsCount}     icon={Layers}   description="Actives"                             color="green"  />
        <StatCard title="Clients"           value={clientsCount}   icon={UserCheck} description="Actifs"                             color="orange" />
        <StatCard title="Chantiers actifs"  value={worksitesCount} icon={HardHat}  description="Planifiés, en cours ou prolongés"    color="purple" />
      </div>

      {/* Alerte absences en attente */}
      {pendingAbsences > 0 && (
        <div className="flex items-center gap-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3">
          <AlertCircle className="h-4 w-4 text-amber-600 shrink-0" />
          <p className="text-sm text-amber-800">
            <span className="font-semibold">{pendingAbsences} absence{pendingAbsences > 1 ? "s" : ""}</span> en attente de validation.
          </p>
        </div>
      )}

      {/* Graphiques */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-semibold flex items-center gap-2">
              <TrendingUp className="h-4 w-4" /> Affectations (30 derniers jours)
            </CardTitle>
          </CardHeader>
          <CardContent>
            {chartData.length > 0 ? (
              <AssignmentsChart data={chartData} />
            ) : (
              <div className="h-[180px] flex items-center justify-center text-sm text-slate-300">
                Aucune affectation récente
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-semibold flex items-center gap-2">
              <HardHat className="h-4 w-4" /> Répartition des chantiers
            </CardTitle>
          </CardHeader>
          <CardContent>
            <WorksiteStatusChart data={pieData} />
          </CardContent>
        </Card>
      </div>

      {/* Bannière onboarding si l'entreprise est vide */}
      {employeesCount === 0 && clientsCount === 0 && (
        <div className="flex items-center justify-between gap-4 rounded-xl border border-[#0f3460]/20 bg-[#0f3460]/5 px-5 py-4">
          <div>
            <p className="text-sm font-semibold text-[#0f3460]">Configurez votre espace</p>
            <p className="text-xs text-slate-500 mt-0.5">Suivez le guide de démarrage pour créer vos équipes et chantiers.</p>
          </div>
          <a
            href="/onboarding"
            className="shrink-0 inline-flex items-center gap-1.5 rounded-lg bg-[#0f3460] px-4 py-2 text-xs font-semibold text-white hover:bg-[#0f3460]/90 transition-colors"
          >
            Démarrer <ArrowRight className="h-3.5 w-3.5" />
          </a>
        </div>
      )}
    </div>
  )
}

// ─── Dashboard Chef d'équipe ─────────────────────────────────────────────────

async function TeamLeaderDashboard({
  userId,
  companyId,
}: {
  userId: string
  companyId: string
}) {
  const employee = await prisma.employee.findUnique({
    where: { userId },
    include: {
      ledTeams: {
        where: { active: true },
        include: {
          members: {
            where: { leftAt: null },
            include: { employee: true },
          },
          assignments: {
            where: {
              date: { gte: new Date() },
              status: { in: ["PENDING", "CONFIRMED"] },
            },
            include: { worksite: true },
            orderBy: { date: "asc" },
            take: 5,
          },
        },
      },
    },
  })

  const team = employee?.ledTeams[0]

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <StatCard
          title="Membres dans mon équipe"
          value={team?.members.length ?? 0}
          icon={Users}
          description={team ? `Équipe ${team.name}` : "Aucune équipe assignée"}
          color="blue"
        />
        <StatCard
          title="Affectations à venir"
          value={team?.assignments.length ?? 0}
          icon={Calendar}
          description="Dans les prochains jours"
          color="green"
        />
      </div>

      {team && team.assignments.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Prochaines affectations</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              {team.assignments.map((a) => (
                <div
                  key={a.id}
                  className="flex items-center justify-between p-3 rounded-lg bg-slate-50"
                >
                  <div>
                    <p className="font-medium text-sm">{a.worksite.name}</p>
                    <p className="text-xs text-slate-500">
                      {formatDate(a.date)}
                    </p>
                  </div>
                  <Badge
                    variant={
                      a.status === "CONFIRMED"
                        ? "default"
                        : a.status === "REFUSED"
                          ? "destructive"
                          : "secondary"
                    }
                  >
                    {a.status === "CONFIRMED"
                      ? "Confirmé"
                      : a.status === "REFUSED"
                        ? "Refusé"
                        : "En attente"}
                  </Badge>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  )
}

// ─── Dashboard Employé ───────────────────────────────────────────────────────

async function EmployeeDashboard({ userId }: { userId: string }) {
  const today = new Date()
  today.setHours(0, 0, 0, 0)

  const nextWeek = new Date(today)
  nextWeek.setDate(nextWeek.getDate() + 7)

  const employee = await prisma.employee.findUnique({
    where: { userId },
    include: {
      teamMemberships: {
        where: { leftAt: null },
        include: { team: { include: { leader: true } } },
      },
      employeeAssignments: {
        where: { date: { gte: today, lte: nextWeek } },
        include: {
          assignment: {
            include: { worksite: true },
          },
        },
        orderBy: { date: "asc" },
      },
    },
  })

  const currentTeam = employee?.teamMemberships[0]?.team

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <StatCard
          title="Mon équipe"
          value={currentTeam?.name ?? "—"}
          icon={Layers}
          description={
            currentTeam
              ? `Chef : ${currentTeam.leader.firstName} ${currentTeam.leader.lastName}`
              : "Non assigné à une équipe"
          }
          color="blue"
        />
        <StatCard
          title="Jours planifiés cette semaine"
          value={employee?.employeeAssignments.length ?? 0}
          icon={Calendar}
          description="7 prochains jours"
          color="green"
        />
      </div>

      {employee && employee.employeeAssignments.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Mon planning (7 jours)</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              {employee.employeeAssignments.map((ea) => (
                <div
                  key={ea.id}
                  className="flex items-center justify-between p-3 rounded-lg bg-slate-50"
                >
                  <div>
                    <p className="font-medium text-sm">
                      {ea.assignment.worksite.name}
                    </p>
                    <p className="text-xs text-slate-500">
                      {formatDate(ea.date)}
                    </p>
                  </div>
                  <Badge variant="secondary">Planifié</Badge>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {employee?.employeeAssignments.length === 0 && (
        <Card>
          <CardContent className="py-8 text-center text-sm text-slate-400">
            Aucun chantier planifié dans les 7 prochains jours.
          </CardContent>
        </Card>
      )}
    </div>
  )
}

// ─── Page principale Dashboard ───────────────────────────────────────────────

export default async function DashboardPage() {
  const session = await auth()
  if (!session?.user) redirect("/login")

  const { id: userId, role, companyId, name } = session.user

  const greeting = (() => {
    const h = new Date().getHours()
    if (h < 12) return "Bonjour"
    if (h < 18) return "Bon après-midi"
    return "Bonsoir"
  })()

  const roleLabel: Record<string, string> = {
    SUPER_ADMIN: "Super Administrateur",
    ADMIN: "Administrateur",
    TEAM_LEADER: "Chef d'équipe",
    EMPLOYEE: "Employé",
    CLIENT: "Client",
  }

  return (
    <div className="space-y-6">
      {/* En-tête */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">
            {greeting}, {name?.split(" ")[0] ?? "—"} 👋
          </h1>
          <p className="text-slate-500 text-sm mt-1">
            {new Date().toLocaleDateString("fr-FR", {
              weekday: "long",
              day: "numeric",
              month: "long",
              year: "numeric",
            })}
          </p>
        </div>
        <Badge variant="secondary" className="text-xs">
          {roleLabel[role] ?? role}
        </Badge>
      </div>

      {/* Contenu selon le rôle */}
      {role === "SUPER_ADMIN" && <SuperAdminDashboard />}

      {role === "ADMIN" && companyId && (
        <AdminDashboard companyId={companyId} />
      )}

      {role === "TEAM_LEADER" && companyId && (
        <TeamLeaderDashboard userId={userId} companyId={companyId} />
      )}

      {role === "EMPLOYEE" && (
        <EmployeeDashboard userId={userId} />
      )}
    </div>
  )
}
