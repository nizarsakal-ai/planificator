/**
 * T2bis (F4) — Cœur testable de `addEmployeeToBlock` (hors "use server").
 *
 * Règles d'isolation :
 *  - le chantier est résolu dans l'entreprise de session (SUPER_ADMIN : tout chantier) ;
 *  - l'employé doit appartenir à l'entreprise DU CHANTIER ;
 *  - seules les affectations dont le chantier ET l'équipe appartiennent à cette entreprise sont
 *    modifiées : une affectation incohérente (équipe étrangère) est ignorée ;
 *  - les conflits renvoyés (noms de chantier et d'équipe) sont bornés par chantier ET équipe.
 */

import type { Prisma } from "@prisma/client"

export type BlockSession = {
  user?: { id?: string; role?: string; companyId?: string | null } | null
} | null

export type AddEmployeeToBlockInput = {
  worksiteId: string
  teamId: string
  startDate: string
  endDate: string
  employeeId: string
}

export type BlockConflict = { iso: string; date: string; worksiteName: string; teamName: string }

/** Forme normalisée (propriétés absentes typées `undefined`) : identique au type que TypeScript
 *  inférait des littéraux d'origine, pour ne pas changer le contrat des composants appelants. */
export type AddEmployeeToBlockResult =
  | { success: true; added: number; skipped: number; conflicts: BlockConflict[]; error?: undefined }
  | { error: string; success?: undefined; added?: undefined; skipped?: undefined; conflicts?: undefined }

export type ConflictRow = {
  date: Date
  assignment: { worksite: { name: string }; team: { name: string } }
}

export type BlockDeps = {
  auth: () => Promise<BlockSession>
  findWorksite: (where: Prisma.WorksiteWhereInput) => Promise<{ id: string; companyId: string } | null>
  findEmployee: (where: Prisma.EmployeeWhereInput) => Promise<{ id: string } | null>
  findAssignments: (where: Prisma.AssignmentWhereInput) => Promise<{ id: string; date: Date }[]>
  /** Doit lever en cas de conflit d'unicité (employeeId, date), comme Prisma. */
  createEmployeeAssignment: (data: { assignmentId: string; employeeId: string; date: Date }) => Promise<unknown>
  findConflicts: (where: Prisma.EmployeeAssignmentWhereInput) => Promise<ConflictRow[]>
  revalidate: (path: string) => void
}

// ---- Clauses where (exportées pour les tests) --------------------------------------------------

export function buildBlockWorksiteWhere(worksiteId: string, companyId: string | undefined): Prisma.WorksiteWhereInput {
  return companyId === undefined ? { id: worksiteId } : { id: worksiteId, companyId }
}

export function buildBlockEmployeeWhere(employeeId: string, companyId: string): Prisma.EmployeeWhereInput {
  return { id: employeeId, companyId }
}

/** Affectations du bloc : chantier ET équipe dans l'entreprise du chantier. */
export function buildBlockAssignmentsWhere(
  input: Pick<AddEmployeeToBlockInput, "worksiteId" | "teamId" | "startDate" | "endDate">,
  companyId: string
): Prisma.AssignmentWhereInput {
  return {
    worksiteId: input.worksiteId,
    teamId: input.teamId,
    date: { gte: new Date(input.startDate), lte: new Date(input.endDate) },
    worksite: { companyId },
    team: { companyId },
  }
}

/** Conflits affichés : affectations existantes de l'employé dont chantier ET équipe sont dans l'entreprise. */
export function buildBlockConflictsWhere(
  employeeId: string,
  dates: Date[],
  companyId: string
): Prisma.EmployeeAssignmentWhereInput {
  return {
    employeeId,
    date: { in: dates },
    assignment: { worksite: { companyId }, team: { companyId } },
  }
}

// ---- Cœur --------------------------------------------------------------------------------------

export async function addEmployeeToBlockCore(
  input: AddEmployeeToBlockInput,
  deps: BlockDeps
): Promise<AddEmployeeToBlockResult> {
  const session = await deps.auth()
  if (!session?.user || !session.user.role || !["ADMIN", "SUPER_ADMIN"].includes(session.user.role)) {
    return { error: "Non autorisé" }
  }
  const isSuperAdmin = session.user.role === "SUPER_ADMIN"
  const sessionCompanyId = session.user.companyId ?? undefined
  if (!isSuperAdmin && !sessionCompanyId) return { error: "Non autorisé" }

  const worksite = await deps.findWorksite(
    buildBlockWorksiteWhere(input.worksiteId, isSuperAdmin ? undefined : sessionCompanyId)
  )
  if (!worksite) return { error: "Chantier introuvable" }

  const employee = await deps.findEmployee(buildBlockEmployeeWhere(input.employeeId, worksite.companyId))
  if (!employee) return { error: "Employé introuvable" }

  const assignments = await deps.findAssignments(buildBlockAssignmentsWhere(input, worksite.companyId))

  let added = 0
  const skippedDates: Date[] = []
  for (const assignment of assignments) {
    try {
      await deps.createEmployeeAssignment({ assignmentId: assignment.id, employeeId: employee.id, date: assignment.date })
      added++
    } catch {
      skippedDates.push(assignment.date)
    }
  }

  const conflicts: BlockConflict[] = []
  if (skippedDates.length > 0) {
    const existing = await deps.findConflicts(buildBlockConflictsWhere(employee.id, skippedDates, worksite.companyId))
    for (const ea of existing) {
      conflicts.push({
        iso: ea.date.toISOString().slice(0, 10),
        date: new Intl.DateTimeFormat("fr-FR", { day: "2-digit", month: "long" }).format(ea.date),
        worksiteName: ea.assignment.worksite.name,
        teamName: ea.assignment.team.name,
      })
    }
  }

  deps.revalidate(`/chantiers/${input.worksiteId}`)
  deps.revalidate("/planning")
  return { success: true, added, skipped: skippedDates.length, conflicts }
}
