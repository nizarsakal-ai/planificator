/**
 * Ticket #77 — Cœur testable de `checkTeamConflict` (hors "use server").
 *
 * Règle : une lecture d'affectation n'est servie que pour l'entreprise de la session,
 * et l'affectation retournée doit appartenir à cette entreprise par ses DEUX côtés
 * (équipe ET chantier). Sans `companyId` de session : refus (`null`), aucune requête.
 */

import type { Prisma } from "@prisma/client"
import { auth as nextAuth } from "@/auth"
import { prisma } from "@/lib/prisma"

export type TeamConflictSession = {
  user?: { id?: string; companyId?: string | null } | null
} | null

export type TeamConflictQuery = {
  companyId: string
  teamId: string
  date: Date
  excludeWorksiteId?: string
}

export type TeamConflictHit = { worksiteName: string } | null

export type TeamConflictDeps = {
  auth?: () => Promise<TeamConflictSession>
  findConflict?: (query: TeamConflictQuery) => Promise<TeamConflictHit>
}

/**
 * Clause `where` Prisma : les deux filtres d'entreprise sont obligatoires et ne dépendent
 * d'aucune condition. Exportée pour être vérifiée par les tests.
 */
export function buildTeamConflictWhere(query: TeamConflictQuery): Prisma.AssignmentWhereInput {
  return {
    teamId: query.teamId,
    date: query.date,
    team: { companyId: query.companyId },
    worksite: { companyId: query.companyId },
    ...(query.excludeWorksiteId ? { worksiteId: { not: query.excludeWorksiteId } } : {}),
  }
}

/** Adaptateur Prisma par défaut (non utilisé par les tests). */
export async function findTeamConflictWithPrisma(query: TeamConflictQuery): Promise<TeamConflictHit> {
  const existing = await prisma.assignment.findFirst({
    where: buildTeamConflictWhere(query),
    select: { worksite: { select: { name: true } } },
  })
  return existing ? { worksiteName: existing.worksite.name } : null
}

export async function checkTeamConflictCore(
  teamId: string,
  date: string,
  excludeWorksiteId: string | undefined,
  deps: TeamConflictDeps = {}
): Promise<TeamConflictHit> {
  const authenticate = deps.auth ?? nextAuth
  const session = await authenticate()
  if (!session?.user) return null

  const companyId = session.user.companyId
  if (typeof companyId !== "string" || companyId.length === 0) return null

  const findConflict = deps.findConflict ?? findTeamConflictWithPrisma
  return findConflict({
    companyId,
    teamId,
    date: new Date(date),
    ...(excludeWorksiteId ? { excludeWorksiteId } : {}),
  })
}
