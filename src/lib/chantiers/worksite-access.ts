/**
 * Accès d'un utilisateur interne aux chantiers de son entreprise — règle unique pour la liste, la fiche chantier,
 * les liens du calendrier et les documents du chantier.
 *
 * - ADMIN / SUPER_ADMIN : tous les chantiers de l'entreprise.
 * - TEAM_LEADER : chantiers affectés à l'une des équipes qu'il dirige (toutes, pas seulement la première) OU sur
 *   lesquels il est lui-même affecté.
 * - EMPLOYEE : chantiers sur lesquels il est affecté.
 * - Tout autre rôle (CLIENT…) : aucun accès par ces routes (le portail client a ses propres pages).
 *
 * Incident 18/11 : la liste montrait à un chef d'équipe tous les chantiers alors que la fiche n'acceptait que ceux
 * de sa première équipe → « 404 Page introuvable » sur son propre chantier.
 */
export type WorksiteViewer =
  | { kind: "ALL" }
  | { kind: "SCOPED"; employeeId: string; ledTeamIds: string[] }

export type WorksiteScope = Record<string, unknown>

/** Fragment Prisma à combiner avec `{ companyId }` ; `null` = aucun chantier accessible. */
export function worksiteAccessWhere(viewer: WorksiteViewer | null): WorksiteScope | null {
  if (!viewer) return null
  if (viewer.kind === "ALL") return {}
  const personal = { assignments: { some: { employeeAssignments: { some: { employeeId: viewer.employeeId } } } } }
  if (!viewer.ledTeamIds.length) return personal
  return { OR: [personal, { assignments: { some: { teamId: { in: viewer.ledTeamIds } } } }] }
}

type ViewerDb = {
  employee: {
    findFirst: (args: {
      where: { userId: string; companyId: string; active: boolean }
      select: { id: true; ledTeams: { where: { active: true }; select: { id: true } } }
    }) => Promise<{ id: string; ledTeams: { id: string }[] } | null>
  }
}

/** Résout le périmètre d'un utilisateur ; `null` si son rôle ou son profil salarié ne donne accès à aucun chantier. */
export async function resolveWorksiteViewer(
  db: ViewerDb,
  user: { id?: string | null; role?: string | null; companyId?: string | null },
): Promise<WorksiteViewer | null> {
  if (!user.id || !user.companyId) return null
  if (user.role === "ADMIN" || user.role === "SUPER_ADMIN") return { kind: "ALL" }
  if (user.role !== "TEAM_LEADER" && user.role !== "EMPLOYEE") return null
  const employee = await db.employee.findFirst({
    where: { userId: user.id, companyId: user.companyId, active: true },
    select: { id: true, ledTeams: { where: { active: true }, select: { id: true } } },
  })
  if (!employee) return null
  return { kind: "SCOPED", employeeId: employee.id, ledTeamIds: user.role === "TEAM_LEADER" ? employee.ledTeams.map(t => t.id) : [] }
}
