/**
 * T2bis (F1/F5) — Cœur testable des rapports journaliers (hors "use server").
 *
 * Règles d'isolation :
 *  - écriture : chef d'équipe de l'entreprise, équipe dirigée ET chantier de l'entreprise ;
 *    un rapport existant pour (équipe, date) rattaché à un chantier étranger n'est ni modifié
 *    ni « réparé » : refus explicite ;
 *  - lecture : rapport dont l'équipe ET le chantier appartiennent à l'entreprise de la session.
 */

import type { Prisma, WeatherCondition } from "@prisma/client"

export type DailyReportSession = {
  user?: { id?: string; role?: string; companyId?: string | null } | null
} | null

export type UpsertDailyReportInput = {
  worksiteId: string
  teamId: string
  date: string
  weather: WeatherCondition
  description: string
  issues: string
  hoursWorked: number
}

export type ExistingDailyReport = {
  id: string
  worksiteId: string
  worksite: { companyId: string }
}

export type DailyReportRow = {
  id: string
  worksiteId: string
  teamId: string
  date: Date
}

export type DailyReportDeps = {
  auth: () => Promise<DailyReportSession>
  findEmployee: (where: Prisma.EmployeeWhereInput) => Promise<{ id: string } | null>
  findTeam: (where: Prisma.TeamWhereInput) => Promise<{ id: string } | null>
  findWorksite: (where: Prisma.WorksiteWhereInput) => Promise<{ id: string } | null>
  findExistingReport: (where: Prisma.DailyReportWhereInput) => Promise<ExistingDailyReport | null>
  upsertReport: (args: {
    where: { teamId_date: { teamId: string; date: Date } }
    create: Prisma.DailyReportUncheckedCreateInput
    update: Prisma.DailyReportUncheckedUpdateInput
  }) => Promise<unknown>
  findReport: (where: Prisma.DailyReportWhereInput) => Promise<DailyReportRow | null>
  revalidate: (path: string) => void
}

/** Forme normalisée, identique au type inféré des littéraux d'origine (contrat des appelants inchangé). */
export type ActionResult = { success: true; error?: undefined } | { error: string; success?: undefined }

// ---- Clauses where (exportées pour les tests) --------------------------------------------------

export function buildEmployeeOfSessionWhere(userId: string, companyId: string): Prisma.EmployeeWhereInput {
  return { userId, companyId }
}

export function buildLedTeamWhere(teamId: string, leaderId: string, companyId: string): Prisma.TeamWhereInput {
  return { id: teamId, leaderId, companyId }
}

export function buildWorksiteOfCompanyWhere(worksiteId: string, companyId: string): Prisma.WorksiteWhereInput {
  return { id: worksiteId, companyId }
}

/** Le rapport existant est cherché par sa clé métier ; son appartenance est vérifiée ensuite. */
export function buildExistingReportWhere(teamId: string, date: Date): Prisma.DailyReportWhereInput {
  return { teamId, date }
}

export function buildReportReadWhere(teamId: string, date: Date, companyId: string): Prisma.DailyReportWhereInput {
  return { teamId, date, team: { companyId }, worksite: { companyId } }
}

// ---- Cœurs -------------------------------------------------------------------------------------

export async function upsertDailyReportCore(
  input: UpsertDailyReportInput,
  deps: DailyReportDeps
): Promise<ActionResult> {
  const session = await deps.auth()
  if (!session?.user || session.user.role !== "TEAM_LEADER") return { error: "Non autorisé" }
  const userId = session.user.id
  const companyId = session.user.companyId
  if (!userId || !companyId) return { error: "Non autorisé" }

  if (!input.worksiteId || !input.teamId || !input.date || !input.description) {
    return { error: "Champs obligatoires manquants" }
  }

  const employee = await deps.findEmployee(buildEmployeeOfSessionWhere(userId, companyId))
  if (!employee) return { error: "Employé introuvable" }

  const team = await deps.findTeam(buildLedTeamWhere(input.teamId, employee.id, companyId))
  if (!team) return { error: "Vous n'êtes pas chef de cette équipe" }

  const worksite = await deps.findWorksite(buildWorksiteOfCompanyWhere(input.worksiteId, companyId))
  if (!worksite) return { error: "Chantier introuvable" }

  const dateObj = new Date(input.date)

  // Un rapport existant rattaché à un chantier étranger ne doit être ni modifié ni réparé.
  const existing = await deps.findExistingReport(buildExistingReportWhere(input.teamId, dateObj))
  if (existing && existing.worksite.companyId !== companyId) {
    return { error: "Rapport introuvable" }
  }

  await deps.upsertReport({
    where: { teamId_date: { teamId: input.teamId, date: dateObj } },
    create: {
      worksiteId: input.worksiteId,
      teamId: input.teamId,
      createdById: employee.id,
      date: dateObj,
      weather: input.weather,
      description: input.description,
      issues: input.issues || null,
      hoursWorked: input.hoursWorked,
    },
    update: {
      weather: input.weather,
      description: input.description,
      issues: input.issues || null,
      hoursWorked: input.hoursWorked,
    },
  })

  deps.revalidate("/planning/equipe")
  deps.revalidate("/rapports")
  return { success: true }
}

export async function getDailyReportCore(
  teamId: string,
  date: string,
  deps: Pick<DailyReportDeps, "auth" | "findReport">
): Promise<DailyReportRow | null> {
  const session = await deps.auth()
  if (!session?.user) return null
  const companyId = session.user.companyId
  if (!companyId) return null
  return deps.findReport(buildReportReadWhere(teamId, new Date(date), companyId))
}
