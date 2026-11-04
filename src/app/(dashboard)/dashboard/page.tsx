import type { Metadata } from "next"
import { auth } from "@/auth"
import { prisma } from "@/lib/prisma"
import { redirect } from "next/navigation"
import Link from "next/link"
import { Card } from "@/components/ui/card"
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
  Clock,
  FileText,
  CalendarOff,
  Download,
} from "lucide-react"
import { formatDate } from "@/lib/utils"
import { AssignmentsChart } from "@/components/dashboard/AssignmentsChart"
import { WorksiteStatusChart } from "@/components/dashboard/WorksiteStatusChart"
import { NouvelleTacheDialog } from "@/components/tasks/NouvelleTacheDialog"

export const metadata: Metadata = { title: "Dashboard" }

// ─── Briques visuelles (V2) ──────────────────────────────────────────────────

const TINTS = {
  blue: "bg-blue-50 text-blue-600",
  green: "bg-green-50 text-green-600",
  orange: "bg-orange-50 text-orange-600",
  purple: "bg-purple-50 text-purple-600",
  slate: "bg-slate-100 text-slate-600",
  amber: "bg-amber-50 text-amber-600",
} as const

type Tint = keyof typeof TINTS

interface HeroProps {
  greeting: string
  firstName: string
  dateLabel: string
  roleLabel: string
}

/** Bandeau d'accueil bleu foncé, compact. Les actions sont des boutons blancs posés sur le bandeau. */
function DashboardHero({
  greeting, firstName, dateLabel, roleLabel, lead, actions,
}: HeroProps & { lead?: string; actions?: React.ReactNode }) {
  return (
    <section className="relative overflow-hidden rounded-3xl bg-[radial-gradient(60%_90%_at_100%_0%,rgba(96,140,255,0.55)_0,transparent_60%),radial-gradient(50%_80%_at_0%_100%,rgba(29,78,216,0.35)_0,transparent_60%),linear-gradient(135deg,#0b2747_0%,#0f3460_45%,#16457e_100%)] px-5 py-5 text-white shadow-[0_4px_10px_rgba(15,52,96,0.25),0_30px_60px_-30px_rgba(15,52,96,0.9)] md:px-7 md:py-6">
      {/* Trame fine, estompée vers le bas à gauche. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-50 [background-image:linear-gradient(rgba(255,255,255,0.05)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.05)_1px,transparent_1px)] [background-size:28px_28px] [mask-image:radial-gradient(70%_90%_at_85%_10%,#000_0,transparent_75%)]"
      />
      <div className="relative flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-white/65">{dateLabel}</p>
          <h1 className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-2xl font-bold tracking-tight md:text-[26px]">
            {greeting}, {firstName}
            <span className="rounded-full border border-white/25 bg-white/15 px-2.5 py-0.5 text-[11px] font-semibold tracking-normal">
              {roleLabel}
            </span>
          </h1>
          {lead && <p className="mt-1 text-sm text-white/80">{lead}</p>}
        </div>
        {actions && (
          <div className="shrink-0 [&_button]:w-full [&_button]:bg-white [&_button]:text-[#0f3460] [&_button]:shadow-[0_2px_4px_rgba(0,0,0,0.15),0_12px_24px_-12px_rgba(0,0,0,0.6)] [&_button:hover]:bg-white/90 md:[&_button]:w-auto">
            {actions}
          </div>
        )}
      </div>
    </section>
  )
}

function SectionHeading({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <div className="mb-3 flex items-center justify-between gap-3 px-1">
      <h2 className="text-[13px] font-bold uppercase tracking-[0.06em] text-slate-700">{title}</h2>
      {children}
    </div>
  )
}

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
  color?: Tint
}) {
  const isText = typeof value === "string" && !/^\d/.test(value)
  return (
    <Card className="flex flex-col gap-2.5 rounded-[22px] p-[18px]">
      <div className="flex items-center justify-between gap-2">
        <p className="text-[13px] font-semibold text-slate-700">{title}</p>
        <div className={`grid h-[34px] w-[34px] shrink-0 place-items-center rounded-[11px] ${TINTS[color]}`}>
          <Icon className="h-[17px] w-[17px]" />
        </div>
      </div>
      <div className={`font-bold leading-none tracking-tight text-slate-900 tabular-nums ${isText ? "text-2xl" : "text-[34px]"}`}>
        {value}
      </div>
      {description && <p className="text-xs text-slate-500">{description}</p>}
    </Card>
  )
}

/** Case de la bande « Ce mois-ci » ; les séparateurs suivent la grille 2 × 2 (mobile) puis 4 colonnes. */
const MONTH_CELL_BORDERS = ["", "border-l", "border-t lg:border-l lg:border-t-0", "border-l border-t lg:border-t-0"]

function MonthCell({
  index, title, value, unit, icon: Icon, description, color, warn = false,
}: {
  index: number
  title: string
  value: number | string
  unit?: string
  icon: React.ElementType
  description: string
  color: Tint
  warn?: boolean
}) {
  return (
    <div className={`flex flex-col gap-2 border-blue-100/70 p-4 md:px-5 md:py-[18px] ${MONTH_CELL_BORDERS[index]}`}>
      <p className="flex items-center gap-2 text-[12.5px] font-semibold text-slate-700">
        <span className={`grid h-[26px] w-[26px] shrink-0 place-items-center rounded-lg ${TINTS[color]}`}>
          <Icon className="h-3.5 w-3.5" />
        </span>
        {title}
      </p>
      <p className={`text-[26px] font-bold leading-none tracking-tight tabular-nums md:text-[30px] ${warn ? "text-amber-600" : "text-slate-900"}`}>
        {value}
        {unit && <span className="ml-0.5 text-base font-semibold text-slate-500">{unit}</span>}
      </p>
      <p className="text-xs text-slate-500">{description}</p>
    </div>
  )
}

function DateTile({ date }: { date: Date }) {
  return (
    <div className="flex h-[52px] w-12 shrink-0 flex-col items-center justify-center rounded-[14px] bg-slate-100">
      <span className="text-lg font-bold leading-none text-[#0f3460]">
        {new Intl.DateTimeFormat("fr-FR", { day: "2-digit" }).format(date)}
      </span>
      <span className="mt-1 text-[10px] font-semibold uppercase tracking-wider text-slate-500">
        {new Intl.DateTimeFormat("fr-FR", { month: "short" }).format(date)}
      </span>
    </div>
  )
}

const PILL = {
  ok: "bg-green-50 text-green-700",
  wait: "bg-amber-50 text-amber-700",
  ko: "bg-red-50 text-red-700",
  plan: "bg-blue-50 text-blue-700",
} as const

function Pill({ tone, children }: { tone: keyof typeof PILL; children: React.ReactNode }) {
  return (
    <span className={`ml-auto shrink-0 rounded-full px-2.5 py-1 text-[11.5px] font-semibold ${PILL[tone]}`}>{children}</span>
  )
}

function AgendaRow({ date, title, children }: { date: Date; title: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3.5 border-blue-100/70 px-3 py-2.5 [&+&]:border-t">
      <DateTile date={date} />
      <div className="min-w-0">
        <p className="truncate text-sm font-semibold text-slate-900">{title}</p>
        <p className="text-xs text-slate-500">{formatDate(date)}</p>
      </div>
      {children}
    </div>
  )
}

// ─── Dashboard Super Admin ───────────────────────────────────────────────────

async function SuperAdminDashboard({ hero }: { hero: HeroProps }) {
  const [companiesCount, usersCount] = await Promise.all([
    prisma.company.count({ where: { active: true } }),
    prisma.user.count({ where: { active: true } }),
  ])

  return (
    <div className="space-y-6">
      <DashboardHero {...hero} lead="Vue plateforme et pilotage de votre entreprise." />
      <section>
        <SectionHeading title="Plateforme" />
        <div className="grid grid-cols-1 gap-3.5 md:grid-cols-[1fr_1fr_1.3fr]">
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
          <Card className="flex flex-col justify-center gap-1.5 rounded-[22px] p-[18px]">
            <p className="text-sm font-semibold text-slate-900">Accès rapide</p>
            <p className="text-sm text-slate-500">
              Gérez les entreprises depuis le menu{" "}
              <span className="font-medium text-slate-700">Entreprises</span>{" "}
              dans la barre latérale.
            </p>
          </Card>
        </div>
      </section>
    </div>
  )
}

// ─── Dashboard Admin ─────────────────────────────────────────────────────────

/** `hero` absent : rendu sous « Mon entreprise » pour le Super Admin, sans second bandeau. */
async function AdminDashboard({ companyId, hero }: { companyId: string; hero?: HeroProps }) {
  const now   = new Date()
  const day30 = new Date(now); day30.setDate(day30.getDate() - 29); day30.setHours(0,0,0,0)

  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1)
  const endOfMonth   = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59)

  const [
    employeesCount, teamsCount, clientsCount,
    worksitesByStatus, recentAssignments, pendingAbsences,
    dailyReportsCount, _signaturesCount, hoursResult, activeWorksites,
    taskEmployees, taskWorksites,
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
    prisma.absence.count({ where: { companyId, status: "PENDING" } }),
    prisma.dailyReport.count({
      where: { worksite: { companyId }, date: { gte: startOfMonth, lte: endOfMonth } },
    }),
    prisma.signature.count({
      where: { assignment: { worksite: { companyId }, date: { gte: startOfMonth, lte: endOfMonth } } },
    }),
    prisma.dailyReport.aggregate({
      where: { worksite: { companyId }, date: { gte: startOfMonth, lte: endOfMonth } },
      _sum: { hoursWorked: true },
    }),
    prisma.worksite.count({
      where: { companyId, status: { in: ["IN_PROGRESS", "EXTENDED"] } },
    }),
    // Options du formulaire « Nouvelle tâche » — strictement filtrées par tenant.
    prisma.employee.findMany({
      where: { companyId, active: true },
      select: { id: true, firstName: true, lastName: true },
      orderBy: [{ lastName: "asc" }, { firstName: "asc" }],
    }),
    prisma.worksite.findMany({
      where: { companyId },
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    }),
  ])

  const totalHours = hoursResult._sum.hoursWorked ?? 0
  const currentMonth = now.getMonth() + 1
  const currentYear  = now.getFullYear()
  const monthLabel = new Intl.DateTimeFormat("fr-FR", { month: "long", year: "numeric" }).format(now)

  const worksitesCount = worksitesByStatus
    .filter((w) => ["PLANNED", "IN_PROGRESS", "EXTENDED"].includes(w.status))
    .reduce((s, w) => s + w._count._all, 0)

  // Graphique affectations : 30 derniers jours regroupés par semaine, dans l'ordre chronologique
  // (la dernière barre est la semaine en cours).
  const weekMap = new Map<number, { day: string; count: number }>()
  recentAssignments.forEach(({ date }) => {
    const d = new Date(date)
    const weekStart = new Date(d)
    weekStart.setDate(d.getDate() - ((d.getDay() + 6) % 7)) // lundi de la semaine (dimanche inclus)
    weekStart.setHours(0, 0, 0, 0)
    const week = weekMap.get(weekStart.getTime())
    if (week) week.count += 1
    else weekMap.set(weekStart.getTime(), {
      day: new Intl.DateTimeFormat("fr-FR", { day: "2-digit", month: "short" }).format(weekStart),
      count: 1,
    })
  })
  const chartData = [...weekMap.entries()].sort(([a], [b]) => a - b).map(([, week]) => week)
  const totalAssignments = recentAssignments.length

  // Graphique statuts chantiers
  const statusMap: Record<string, number> = {}
  worksitesByStatus.forEach((w) => { statusMap[w.status] = w._count._all })
  const pieData = [
    { name: "Planifié",   value: statusMap["PLANNED"]     ?? 0, color: "#94a3b8" },
    { name: "En cours",   value: statusMap["IN_PROGRESS"] ?? 0, color: "#0f3460" },
    { name: "Prolongé",   value: statusMap["EXTENDED"]    ?? 0, color: "#f59e0b" },
    { name: "Terminé",    value: statusMap["COMPLETED"]   ?? 0, color: "#22c55e" },
  ]

  const newTask = <NouvelleTacheDialog employees={taskEmployees} worksites={taskWorksites} />
  const lead =
    `${activeWorksites} chantier${activeWorksites > 1 ? "s" : ""} en cours` +
    (pendingAbsences > 0 ? ` · ${pendingAbsences} absence${pendingAbsences > 1 ? "s" : ""} à valider.` : ".")

  return (
    <div className="space-y-6">
      {hero ? (
        <DashboardHero {...hero} lead={lead} actions={newTask} />
      ) : (
        <div className="flex items-center justify-end">{newTask}</div>
      )}

      {/* Alerte absences en attente */}
      {pendingAbsences > 0 && (
        <div className="flex flex-wrap items-center gap-3 rounded-[18px] border border-amber-200 bg-amber-50 py-3 pl-4 pr-3.5">
          <span className="grid h-[30px] w-[30px] shrink-0 place-items-center rounded-[10px] bg-amber-100 text-amber-600">
            <AlertCircle className="h-4 w-4" />
          </span>
          <p className="text-sm text-amber-800">
            <span className="font-semibold">{pendingAbsences} absence{pendingAbsences > 1 ? "s" : ""}</span> en attente de validation.
          </p>
          <Link
            href="/absences"
            className="ml-[42px] inline-flex items-center gap-1.5 rounded-[11px] border border-amber-200 bg-white/70 px-3 py-1.5 text-sm font-semibold text-amber-800 outline-none transition-colors hover:bg-white focus-visible:ring-2 focus-visible:ring-amber-500 sm:ml-auto"
          >
            Voir les absences <ArrowRight className="h-3.5 w-3.5" />
          </Link>
        </div>
      )}

      {/* KPIs mensuels + Export PDF */}
      <section>
        <SectionHeading title={`Ce mois-ci · ${monthLabel}`}>
          <a
            href={`/api/pdf/mensuel?month=${currentMonth}&year=${currentYear}`}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-xl border border-[#0f3460]/15 bg-white px-3.5 py-2 text-xs font-semibold text-[#0f3460] shadow-[0_2px_4px_rgba(15,52,96,0.12),0_10px_20px_-10px_rgba(15,52,96,0.55)] outline-none transition-[background-color,box-shadow] hover:bg-[#0f3460]/[0.04] hover:shadow-[0_3px_6px_rgba(15,52,96,0.16),0_14px_26px_-10px_rgba(15,52,96,0.65)] focus-visible:ring-2 focus-visible:ring-blue-500 motion-reduce:transition-none"
          >
            <Download className="h-3.5 w-3.5" />
            <span>Export PDF<span className="hidden sm:inline"> mensuel</span></span>
          </a>
        </SectionHeading>
        <Card className="grid grid-cols-2 overflow-hidden rounded-[22px] lg:grid-cols-4">
          <MonthCell index={0} title="Heures totales" value={Math.round(totalHours)} unit="h" icon={Clock} description="Rapports du mois" color="blue" />
          <MonthCell index={1} title="Rapports journaliers" value={dailyReportsCount} icon={FileText} description="Ce mois" color="green" />
          <MonthCell index={2} title="Chantiers en cours" value={activeWorksites} icon={HardHat} description="En cours ou prolongés" color="slate" />
          <MonthCell index={3} title="Absences en attente" value={pendingAbsences} icon={CalendarOff} description="À valider" color="amber" warn={pendingAbsences > 0} />
        </Card>
      </section>

      {/* KPIs */}
      <section>
        <SectionHeading title="Effectifs & activité">
          <span className="text-xs text-slate-500">Données actives</span>
        </SectionHeading>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4 lg:gap-3.5">
          <StatCard title="Employés"          value={employeesCount} icon={Users}    description="Actifs"                              color="blue"   />
          <StatCard title="Équipes"           value={teamsCount}     icon={Layers}   description="Actives"                             color="green"  />
          <StatCard title="Clients"           value={clientsCount}   icon={UserCheck} description="Actifs"                             color="orange" />
          <StatCard title="Chantiers actifs"  value={worksitesCount} icon={HardHat}  description="Planifiés, en cours ou prolongés"    color="purple" />
        </div>
      </section>

      {/* Graphiques */}
      <div className="grid grid-cols-1 gap-3.5 lg:grid-cols-[1.65fr_1fr]">
        <Card className="rounded-[22px] px-5 pb-4 pt-[18px]">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h3 className="flex items-center gap-2 text-sm font-semibold text-slate-900">
                <TrendingUp className="h-4 w-4 text-[#0f3460]" /> Affectations
              </h3>
              <p className="mt-1 text-xs text-slate-500">30 derniers jours, par semaine</p>
            </div>
            <p className="text-right text-[26px] font-bold leading-none tracking-tight text-slate-900 tabular-nums">
              {totalAssignments}
              <span className="mt-1 block text-[11.5px] font-medium tracking-normal text-slate-500">
                affectation{totalAssignments > 1 ? "s" : ""}
              </span>
            </p>
          </div>
          <div className="mt-3">
            {chartData.length > 0 ? (
              <AssignmentsChart data={chartData} />
            ) : (
              <div className="h-[180px] flex items-center justify-center text-sm text-slate-300">
                Aucune affectation récente
              </div>
            )}
          </div>
        </Card>

        <Card className="flex flex-col rounded-[22px] px-5 pb-4 pt-[18px]">
          <h3 className="flex items-center gap-2 text-sm font-semibold text-slate-900">
            <HardHat className="h-4 w-4 text-[#0f3460]" /> Répartition des chantiers
          </h3>
          <p className="mt-1 text-xs text-slate-500">Tous statuts</p>
          <div className="flex flex-1 items-center pt-3">
            <div className="w-full">
              <WorksiteStatusChart data={pieData} />
            </div>
          </div>
        </Card>
      </div>

      {/* Bannière onboarding si l'entreprise est vide */}
      {employeesCount === 0 && clientsCount === 0 && (
        <div className="flex items-center justify-between gap-4 rounded-[22px] border border-dashed border-[#0f3460]/30 bg-[#0f3460]/5 px-5 py-4">
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
  hero,
}: {
  userId: string
  companyId: string
  hero: HeroProps
}) {
  const employee = await prisma.employee.findFirst({
    where: { userId, companyId },
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
      <DashboardHero {...hero} lead="Votre équipe et ses prochaines affectations." />
      <div className="grid grid-cols-1 gap-3.5 md:grid-cols-2">
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
        <Card className="rounded-[22px] p-2">
          <h3 className="px-3 pb-2.5 pt-3 text-[15px] font-semibold text-slate-900">Prochaines affectations</h3>
          {team.assignments.map((a) => (
            <AgendaRow key={a.id} date={a.date} title={a.worksite.name}>
              {a.status === "CONFIRMED" ? (
                <Pill tone="ok">Confirmé</Pill>
              ) : a.status === "REFUSED" ? (
                <Pill tone="ko">Refusé</Pill>
              ) : (
                <Pill tone="wait">En attente</Pill>
              )}
            </AgendaRow>
          ))}
        </Card>
      )}
    </div>
  )
}

// ─── Dashboard Employé ───────────────────────────────────────────────────────

async function EmployeeDashboard({ userId, companyId, days, hero }: { userId: string; companyId: string; days: 7 | 30; hero: HeroProps }) {
  const today = new Date()
  today.setHours(0, 0, 0, 0)

  const toDate = new Date(today)
  toDate.setDate(toDate.getDate() + days)

  const employee = await prisma.employee.findFirst({
    where: { userId, companyId },
    include: {
      teamMemberships: {
        where: { leftAt: null },
        include: { team: { include: { leader: true } } },
      },
      employeeAssignments: {
        where: { date: { gte: today, lte: toDate } },
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
      <DashboardHero {...hero} lead={`Votre planning des ${days} prochains jours.`} />
      <div className="grid grid-cols-1 gap-3.5 md:grid-cols-2">
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
          title="Jours planifiés"
          value={employee?.employeeAssignments.length ?? 0}
          icon={Calendar}
          description={`${days} prochains jours`}
          color="green"
        />
      </div>

      <Card className="rounded-[22px] p-2">
        <div className="flex flex-wrap items-center justify-between gap-2 px-3 pb-2.5 pt-3">
          <h3 className="text-[15px] font-semibold text-slate-900">Mon planning ({days} jours)</h3>
          {/* Toggle 7 / 30 jours */}
          <div className="flex items-center gap-0.5 rounded-xl bg-slate-100 p-[3px]">
            <Link
              href="/dashboard?days=7"
              className={`rounded-[9px] px-3 py-1.5 text-[12.5px] font-medium transition-colors ${
                days === 7 ? "bg-white font-semibold text-[#0f3460] shadow-sm" : "text-slate-500 hover:text-slate-700"
              }`}
            >
              7 jours
            </Link>
            <Link
              href="/dashboard?days=30"
              className={`rounded-[9px] px-3 py-1.5 text-[12.5px] font-medium transition-colors ${
                days === 30 ? "bg-white font-semibold text-[#0f3460] shadow-sm" : "text-slate-500 hover:text-slate-700"
              }`}
            >
              30 jours
            </Link>
          </div>
        </div>
        {employee && employee.employeeAssignments.length > 0 ? (
          employee.employeeAssignments.map((ea) => (
            <AgendaRow key={ea.id} date={ea.date} title={ea.assignment.worksite.name}>
              <Pill tone="plan">Planifié</Pill>
            </AgendaRow>
          ))
        ) : (
          <p className="py-6 text-center text-sm text-slate-400">
            Aucun chantier planifié dans les {days} prochains jours.
          </p>
        )}
      </Card>
    </div>
  )
}

// ─── Page principale Dashboard ───────────────────────────────────────────────

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ days?: string }>
}) {
  const session = await auth()
  if (!session?.user) redirect("/login")

  const { days: daysParam } = await searchParams
  const planningDays: 7 | 30 = daysParam === "30" ? 30 : 7

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

  const hero: HeroProps = {
    greeting,
    firstName: name?.split(" ")[0] ?? "—",
    dateLabel: new Date().toLocaleDateString("fr-FR", {
      weekday: "long",
      day: "numeric",
      month: "long",
      year: "numeric",
    }),
    roleLabel: roleLabel[role] ?? role,
  }

  // Contenu selon le rôle ; sans contenu propre au rôle, le bandeau d'accueil reste affiché seul.
  if (role === "SUPER_ADMIN") {
    return (
      <div className="space-y-6">
        <SuperAdminDashboard hero={hero} />
        {companyId && (
          <>
            <div className="flex items-center gap-3 pt-2">
              <div className="h-px flex-1 bg-slate-200" />
              <span className="text-xs font-semibold text-slate-400 uppercase tracking-wider">Mon entreprise</span>
              <div className="h-px flex-1 bg-slate-200" />
            </div>
            <AdminDashboard companyId={companyId} />
          </>
        )}
      </div>
    )
  }

  if (role === "ADMIN" && companyId) return <AdminDashboard companyId={companyId} hero={hero} />

  if (role === "TEAM_LEADER" && companyId) {
    return <TeamLeaderDashboard userId={userId} companyId={companyId} hero={hero} />
  }

  if (role === "EMPLOYEE" && companyId) {
    return <EmployeeDashboard companyId={companyId} userId={userId} days={planningDays} hero={hero} />
  }

  return <DashboardHero {...hero} />
}
