import type { Metadata } from "next"
import { auth } from "@/auth"
import { redirect } from "next/navigation"
import { prisma } from "@/lib/prisma"
import { NouvelleEquipeDialog } from "@/components/equipes/NouvelleEquipeDialog"
import { EquipeStats } from "@/components/equipes/EquipeStats"
import { EquipesView } from "@/components/equipes/EquipesView"
import { EquipesSidePanel } from "@/components/equipes/EquipesSidePanel"
import type { EquipeTruckOption } from "@/components/equipes/EquipeActionsMenu"
import {
  addDbDays,
  assignmentsOnDbDate,
  buildInterventionMap,
  computeEquipeStats,
  getCurrentInterventions,
  getPlanningHref,
  getQuickActions,
  getUpcomingInterventions,
  parisTodayAsDbDate,
  toEquipeViewItems,
  UPCOMING_WINDOW_DAYS,
} from "@/lib/equipes/equipes-view"

export const metadata: Metadata = { title: "Équipes" }

/** Rôles autorisés sur la page ET par les mutations réutilisées (requireAdmin, PATCH/POST /api/trucks). */
const TEAM_MANAGER_ROLES = ["ADMIN", "SUPER_ADMIN", "TEAM_LEADER"]

const PERSON_SELECT = { id: true, firstName: true, lastName: true, companyId: true } as const

export default async function EquipesPage() {
  const session = await auth()
  if (!session?.user) redirect("/login")
  if (!TEAM_MANAGER_ROLES.includes(session.user.role)) redirect("/dashboard")
  const companyId = session.user.companyId
  if (!companyId) redirect("/dashboard")

  const today = parisTodayAsDbDate(new Date())

  const [teams, windowAssignments, employeesWithoutTeam, employees, trucks] = await Promise.all([
    prisma.team.findMany({
      where: { companyId },
      select: {
        id: true,
        companyId: true,
        name: true,
        color: true,
        active: true,
        leader: { select: PERSON_SELECT },
        members: {
          where: { leftAt: null },
          orderBy: { joinedAt: "asc" },
          select: { employee: { select: { ...PERSON_SELECT, avatarUrl: true, active: true } } },
        },
        truck: { select: { id: true, matricule: true, marque: true, companyId: true } },
      },
      orderBy: { name: "asc" },
    }),
    // Une seule requête : affectations CONFIRMED d'aujourd'hui (Europe/Paris) à J+30, toutes équipes actives du tenant.
    // Sert à la fois au chantier du jour (cartes, carte, onglet) et aux prochaines interventions.
    prisma.assignment.findMany({
      where: {
        date: { gte: today, lte: addDbDays(today, UPCOMING_WINDOW_DAYS) },
        status: "CONFIRMED",
        team: { companyId, active: true },
        worksite: { companyId },
      },
      orderBy: { date: "asc" },
      select: {
        teamId: true,
        status: true,
        date: true,
        worksite: { select: { id: true, name: true, latitude: true, longitude: true, companyId: true } },
      },
    }),
    prisma.employee.count({
      where: {
        companyId,
        active: true,
        teamMemberships: { none: { leftAt: null, team: { active: true, companyId } } },
      },
    }),
    // Pour NouvelleEquipeDialog (inchangé).
    prisma.employee.findMany({
      where: { companyId, active: true },
      orderBy: { firstName: "asc" },
      select: { id: true, firstName: true, lastName: true, jobTitle: true },
    }),
    // Pour TruckSelector : véhicules actifs du tenant (un véhicule archivé n'est jamais proposé).
    prisma.truck.findMany({
      where: { companyId, active: true },
      orderBy: { matricule: "asc" },
      select: { id: true, matricule: true, marque: true, chauffeurId: true, teamId: true },
    }),
  ])

  const items = toEquipeViewItems(teams, assignmentsOnDbDate(windowAssignments, today), companyId)
  const stats = computeEquipeStats(items, employeesWithoutTeam)

  const current = getCurrentInterventions(items)
  const map = buildInterventionMap(current)
  const upcoming = getUpcomingInterventions(windowAssignments, items, companyId, today)

  const teamNames = new Map(items.map((t) => [t.id, t.name]))
  const truckOptions: EquipeTruckOption[] = trucks.map((t) => ({
    id: t.id,
    matricule: t.matricule,
    marque: t.marque,
    chauffeurId: t.chauffeurId,
    teamId: t.teamId,
    teamName: t.teamId ? (teamNames.get(t.teamId) ?? null) : null,
  }))

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Équipes</h1>
          <p className="mt-1 text-sm text-slate-500">
            Gérez vos équipes, leurs membres, leurs véhicules et leurs affectations.
          </p>
        </div>
        <NouvelleEquipeDialog employees={employees} />
      </div>

      {/*
        Panneau droit dès 1168 px de viewport : zone utile = viewport − sidebar 256 px − padding 48 px = 864 px,
        soit 864 − 248 (panneau) − 16 (gap) = 600 px pour la Mosaïque → 2 colonnes d'environ 292 px
        (pied de carte complet : 4 avatars + « +N » + repère de taille, même avec une barre de défilement classique).
        En dessous (tablette, mobile), le panneau passe sous le contenu principal.
      */}
      <div className="grid gap-6 min-[1168px]:grid-cols-[minmax(0,1fr)_248px] min-[1168px]:items-start min-[1168px]:gap-4">
        <div className="min-w-0 space-y-6">
          <EquipeStats stats={stats} />

          <EquipesView
            teams={items}
            trucks={truckOptions}
            canManage={TEAM_MANAGER_ROLES.includes(session.user.role)}
          />
        </div>

        <EquipesSidePanel
          current={current}
          map={map}
          upcoming={upcoming}
          quickActions={getQuickActions(session.user.role)}
          planningHref={getPlanningHref(session.user.role)}
          employees={employees}
        />
      </div>
    </div>
  )
}
