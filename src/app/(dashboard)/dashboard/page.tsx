import type { Metadata } from "next"
import { auth } from "@/auth"
import { prisma } from "@/lib/prisma"
import { redirect } from "next/navigation"
import Link from "next/link"
import { Card } from "@/components/ui/card"
import { ArrowRight, Download } from "lucide-react"
import { AssignmentsChart } from "@/components/dashboard/AssignmentsChart"
import { WorksiteStatusChart } from "@/components/dashboard/WorksiteStatusChart"
import { NouvelleTacheDialog } from "@/components/tasks/NouvelleTacheDialog"
import { ProspectionBlock } from "@/components/dashboard/ProspectionBlock"
import { isProspectionNavVisible, isProspectionWatchEnabled } from "@/lib/prospection/prospection-feature-flag"

export const metadata: Metadata = { title: "Dashboard" }

// ─── Briques visuelles (V3, épurée) ─────────────────────────────────────────
// Principe : une seule couleur de marque (#0f3460), un seul signal (ambre) réservé à ce qui demande une action,
// des chiffres lisibles sans pictogrammes décoratifs, et aucune information répétée deux fois sur la page.

interface HeroProps {
  greeting: string
  firstName: string
  dateLabel: string
  roleLabel: string
}

/** En-tête de page : la date, la salutation et, en une phrase, l'état du jour. Pas de bandeau décoratif. */
function DashboardHero({
  greeting, firstName, dateLabel, roleLabel, lead, actions,
}: HeroProps & { lead?: React.ReactNode; actions?: React.ReactNode }) {
  return (
    <header className="flex flex-col gap-4 border-b border-slate-200 pb-5 md:flex-row md:items-end md:justify-between">
      <div className="min-w-0">
        <p className="text-sm text-slate-500">
          <span className="capitalize">{dateLabel}</span>
          <span aria-hidden> · </span>
          {roleLabel}
        </p>
        <h1 className="mt-1 text-[28px] font-semibold leading-tight tracking-tight text-slate-900 [overflow-wrap:anywhere] md:text-[32px]">
          {firstName ? `${greeting} ${firstName}` : greeting}
        </h1>
        {lead && <p className="mt-1.5 max-w-prose text-[15px] text-slate-600">{lead}</p>}
      </div>
      {actions && <div className="shrink-0 [&_button]:w-full md:[&_button]:w-auto">{actions}</div>}
    </header>
  )
}

function SectionHeading({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <div className="mb-2.5 flex items-baseline justify-between gap-3">
      <h2 className="text-[15px] font-semibold text-slate-900">{title}</h2>
      {children}
    </div>
  )
}

/** Un chiffre et son libellé ; `href` rend la case cliquable vers la liste concernée. */
interface Figure {
  label: string
  value: number | string
  unit?: string
  note?: string
  href?: string
  warn?: boolean
}

/** Rangée de chiffres dans une seule carte, séparés par des filets (2 colonnes sur mobile, n sur grand écran). */
function FigureRow({ items }: { items: Figure[] }) {
  const cols = items.length >= 4 ? "lg:grid-cols-4" : items.length === 3 ? "sm:grid-cols-3" : "sm:grid-cols-2"
  return (
    <Card className={`grid grid-cols-2 overflow-hidden ${cols}`}>
      {items.map((f) => {
        const body = (
          <>
            <p className="text-[13px] text-slate-500">{f.label}</p>
            <p className={`mt-1.5 text-[28px] font-semibold leading-none tracking-tight tabular-nums ${f.warn ? "text-amber-700" : "text-slate-900"}`}>
              {f.value}
              {f.unit && <span className="ml-0.5 text-base font-medium text-slate-400">{f.unit}</span>}
            </p>
            {f.note && <p className="mt-1.5 text-xs text-slate-500">{f.note}</p>}
          </>
        )
        const cell = "-ml-px -mt-px border-l border-t border-slate-100 px-4 py-4 md:px-5"
        return f.href ? (
          <Link
            key={f.label}
            href={f.href}
            className={`${cell} outline-none transition-colors hover:bg-slate-50 focus-visible:bg-slate-50 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#0f3460] motion-reduce:transition-none`}
          >
            {body}
          </Link>
        ) : (
          <div key={f.label} className={cell}>{body}</div>
        )
      })}
    </Card>
  )
}

function DateTile({ date }: { date: Date }) {
  return (
    <div className="flex w-11 shrink-0 flex-col items-center border-r border-slate-200 pr-3">
      <span className="text-lg font-semibold leading-none tabular-nums text-slate-900">
        {new Intl.DateTimeFormat("fr-FR", { day: "2-digit" }).format(date)}
      </span>
      <span className="mt-1 text-[11px] text-slate-500">
        {new Intl.DateTimeFormat("fr-FR", { month: "short" }).format(date)}
      </span>
    </div>
  )
}

/** Statut d'affectation : un point de couleur et un mot, sans pastille pleine. */
const PILL = {
  ok: "bg-green-600",
  wait: "bg-amber-500",
  ko: "bg-red-600",
  plan: "bg-[#0f3460]",
} as const

function Pill({ tone, children }: { tone: keyof typeof PILL; children: React.ReactNode }) {
  return (
    <span className="ml-auto inline-flex shrink-0 items-center gap-1.5 text-[13px] text-slate-600">
      <span aria-hidden className={`h-2 w-2 rounded-full ${PILL[tone]}`} />
      {children}
    </span>
  )
}

function AgendaRow({ date, title, children }: { date: Date; title: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3 border-slate-100 px-4 py-3 [&+&]:border-t">
      <DateTile date={date} />
      <div className="min-w-0">
        <p className="truncate text-sm font-medium text-slate-900">{title}</p>
        <p className="text-xs capitalize text-slate-500">
          {new Intl.DateTimeFormat("fr-FR", { weekday: "long" }).format(date)}
        </p>
      </div>
      {children}
    </div>
  )
}

// ─── Dashboard Super Admin ───────────────────────────────────────────────────

/** `prospectionCompanyId` : société pour laquelle afficher la veille prospection (garde vérifiée par la page). */
async function SuperAdminDashboard({ hero, prospectionCompanyId }: { hero: HeroProps; prospectionCompanyId: string | null }) {
  const [companiesCount, usersCount] = await Promise.all([
    prisma.company.count({ where: { active: true } }),
    prisma.user.count({ where: { active: true } }),
  ])

  const lead = (
    <>
      Plateforme :{" "}
      <Link href="/super-admin/entreprises" className="font-medium text-[#0f3460] underline-offset-2 hover:underline">
        {companiesCount} entreprise{companiesCount > 1 ? "s" : ""} active{companiesCount > 1 ? "s" : ""}
      </Link>
      {" "}et {usersCount} utilisateur{usersCount > 1 ? "s" : ""}.
    </>
  )

  return (
    <div className="space-y-7">
      <DashboardHero {...hero} lead={lead} />
      {prospectionCompanyId && <ProspectionBlock companyId={prospectionCompanyId} />}
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
  const plural = (n: number, w: string) => `${n} ${w}${n > 1 ? "s" : ""}`
  // L'état du jour en une phrase ; les absences à valider sont le seul point qui demande une action.
  const lead = (
    <>
      {plural(activeWorksites, "chantier")} en cours
      {pendingAbsences > 0 ? (
        <>
          {", "}
          <Link href="/absences" className="font-medium text-amber-700 underline underline-offset-2 hover:text-amber-800">
            {plural(pendingAbsences, "absence")} à valider
          </Link>
          .
        </>
      ) : (
        ", aucune absence à valider."
      )}
    </>
  )

  return (
    <div className="space-y-7">
      {hero ? (
        <DashboardHero {...hero} lead={lead} actions={newTask} />
      ) : (
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-[15px] text-slate-600">{lead}</p>
          {newTask}
        </div>
      )}

      <section>
        <SectionHeading title={`Ce mois-ci, ${monthLabel}`}>
          <a
            href={`/api/pdf/mensuel?month=${currentMonth}&year=${currentYear}`}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-lg px-2 py-1 text-[13px] font-medium text-[#0f3460] outline-none hover:bg-[#0f3460]/5 focus-visible:ring-2 focus-visible:ring-[#0f3460]"
          >
            <Download className="h-3.5 w-3.5" aria-hidden />
            Bilan PDF du mois
          </a>
        </SectionHeading>
        <FigureRow
          items={[
            { label: "Heures travaillées", value: Math.round(totalHours), unit: "h", note: "Selon les rapports journaliers" },
            { label: "Rapports journaliers", value: dailyReportsCount, href: "/rapports" },
            { label: "Affectations", value: totalAssignments, note: "30 derniers jours", href: "/planning" },
            { label: "Absences à valider", value: pendingAbsences, href: "/absences", warn: pendingAbsences > 0 },
          ]}
        />
      </section>

      <section>
        <SectionHeading title="Chantiers et effectifs" />
        <FigureRow
          items={[
            { label: "Chantiers", value: worksitesCount, note: `dont ${activeWorksites} en cours`, href: "/chantiers" },
            { label: "Clients", value: clientsCount, href: "/clients" },
            { label: "Employés", value: employeesCount, href: "/employes" },
            { label: "Équipes", value: teamsCount, href: "/equipes" },
          ]}
        />
      </section>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1.65fr_1fr]">
        <Card className="px-5 pb-4 pt-4">
          <h3 className="text-[15px] font-semibold text-slate-900">Affectations par semaine</h3>
          <p className="mt-0.5 text-xs text-slate-500">30 derniers jours</p>
          <div className="mt-3">
            {chartData.length > 0 ? (
              <AssignmentsChart data={chartData} />
            ) : (
              <div className="flex h-[180px] items-center justify-center text-sm text-slate-500">
                Aucune affectation sur les 30 derniers jours.{" "}
                <Link href="/planning" className="ml-1 font-medium text-[#0f3460] hover:underline">Ouvrir le planning</Link>
              </div>
            )}
          </div>
        </Card>

        <Card className="flex flex-col px-5 pb-4 pt-4">
          <h3 className="text-[15px] font-semibold text-slate-900">Chantiers par statut</h3>
          <p className="mt-0.5 text-xs text-slate-500">Tous les chantiers</p>
          <div className="flex flex-1 items-center pt-3">
            <div className="w-full">
              <WorksiteStatusChart data={pieData} />
            </div>
          </div>
        </Card>
      </div>

      {employeesCount === 0 && clientsCount === 0 && (
        <div className="flex flex-col gap-3 rounded-2xl border border-dashed border-slate-300 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-sm font-semibold text-slate-900">Votre espace est vide</p>
            <p className="mt-0.5 text-sm text-slate-500">Créez vos équipes, vos clients et vos premiers chantiers avec le guide de démarrage.</p>
          </div>
          <Link
            href="/onboarding"
            className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-[#0f3460] px-4 py-2 text-sm font-semibold text-white outline-none hover:bg-[#0f3460]/90 focus-visible:ring-2 focus-visible:ring-[#0f3460] focus-visible:ring-offset-2"
          >
            Ouvrir le guide <ArrowRight className="h-3.5 w-3.5" aria-hidden />
          </Link>
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
    <div className="space-y-7">
      <DashboardHero {...hero} lead="Votre équipe et ses prochaines affectations." />
      <FigureRow
        items={[
          { label: "Membres de l'équipe", value: team?.members.length ?? 0, note: team ? `Équipe ${team.name}` : "Aucune équipe ne vous est confiée" },
          { label: "Affectations à venir", value: team?.assignments.length ?? 0, note: "Les 5 prochaines au plus" },
        ]}
      />

      {team && team.assignments.length > 0 && (
        <section>
          <SectionHeading title="Prochaines affectations" />
          <Card className="overflow-hidden">
            {team.assignments.map((a) => (
              <AgendaRow key={a.id} date={a.date} title={a.worksite.name}>
                {a.status === "CONFIRMED" ? (
                  <Pill tone="ok">Confirmée</Pill>
                ) : a.status === "REFUSED" ? (
                  <Pill tone="ko">Refusée</Pill>
                ) : (
                  <Pill tone="wait">En attente</Pill>
                )}
              </AgendaRow>
            ))}
          </Card>
        </section>
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
    <div className="space-y-7">
      <DashboardHero {...hero} lead={`Votre planning des ${days} prochains jours.`} />
      <FigureRow
        items={[
          {
            label: "Mon équipe",
            value: currentTeam?.name ?? "—",
            note: currentTeam ? `Chef : ${currentTeam.leader.firstName} ${currentTeam.leader.lastName}` : "Vous n'êtes dans aucune équipe",
          },
          { label: "Jours planifiés", value: employee?.employeeAssignments.length ?? 0, note: `Sur les ${days} prochains jours` },
        ]}
      />

      <section>
        <SectionHeading title="Mon planning">
          <nav aria-label="Période affichée" className="flex items-center gap-0.5 rounded-lg bg-slate-100 p-0.5">
            {([7, 30] as const).map((d) => (
              <Link
                key={d}
                href={`/dashboard?days=${d}`}
                aria-current={days === d ? "page" : undefined}
                className={`rounded-md px-3 py-1 text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-[#0f3460] ${
                  days === d ? "bg-white font-medium text-slate-900 shadow-sm" : "text-slate-500 hover:text-slate-800"
                }`}
              >
                {d} jours
              </Link>
            ))}
          </nav>
        </SectionHeading>
        <Card className="overflow-hidden">
          {employee && employee.employeeAssignments.length > 0 ? (
            employee.employeeAssignments.map((ea) => (
              <AgendaRow key={ea.id} date={ea.date} title={ea.assignment.worksite.name}>
                <Pill tone="plan">Planifié</Pill>
              </AgendaRow>
            ))
          ) : (
            <p className="px-4 py-6 text-center text-sm text-slate-500">
              Aucun chantier prévu sur les {days} prochains jours.
            </p>
          )}
        </Card>
      </section>
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
    // Un compte sans nom renseigné a son e-mail comme nom : on salue alors sans prénom.
    firstName: name && !name.includes("@") ? name.split(" ")[0] : "",
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
    // Veille prospection : drapeau serveur + SUPER_ADMIN + société active (même garde que la page /opportunites).
    const prospectionVisible = isProspectionNavVisible({ enabled: isProspectionWatchEnabled(), role, companyId })
    return (
      <div className="space-y-7">
        <SuperAdminDashboard hero={hero} prospectionCompanyId={prospectionVisible && companyId ? companyId : null} />
        {companyId && (
          <>
            <h2 className="border-t border-slate-200 pt-6 text-xl font-semibold tracking-tight text-slate-900">Mon entreprise</h2>
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
