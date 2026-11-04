/**
 * Veille prospection — lectures du bloc « Opportunités prospection » du tableau de bord SUPER_ADMIN.
 * Lecture seule, toujours filtrée par `companyId`. Mêmes règles que la page `/opportunites` : bandes « À traiter » et
 * « À vérifier », hors Écarté / Perdu, appels d'offres clos exclus, ordre de priorité de Nizar puis score.
 */
import type { Prisma } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import { countOpportunitiesByKind } from "@/lib/prospection/prospection.repository"
import { DASHBOARD_TOP_LIMIT, NEW_OPPORTUNITY_WINDOW_MS } from "@/lib/prospection/prospection-dashboard"

function openOpportunityWhere(companyId: string, now: Date): Prisma.ProspectOpportunityWhereInput {
  return {
    companyId,
    band: { in: ["A_TRAITER", "A_VERIFIER"] },
    status: { notIn: ["ECARTE", "PERDU"] },
    OR: [{ kind: { not: "TENDER" } }, { deadlineAt: null }, { deadlineAt: { gte: now } }],
  }
}

export async function getDashboardProspection(companyId: string, now: Date) {
  const open = openOpportunityWhere(companyId, now)
  const [counts, top, newSince24h, lastRun] = await Promise.all([
    countOpportunitiesByKind(companyId, now),
    prisma.prospectOpportunity.findMany({
      where: open,
      orderBy: [{ priorityGroup: "asc" }, { score: "desc" }, { deadlineAt: { sort: "asc", nulls: "last" } }],
      take: DASHBOARD_TOP_LIMIT,
      select: {
        id: true, source: true, kind: true, title: true, organization: true, departmentCodes: true, locality: true,
        publishedAt: true, deadlineAt: true, eventStartAt: true, eventPeriod: true, winners: true, score: true,
        band: true, firstSeenAt: true,
      },
    }),
    prisma.prospectOpportunity.count({
      where: { ...open, firstSeenAt: { gte: new Date(now.getTime() - NEW_OPPORTUNITY_WINDOW_MS) } },
    }),
    prisma.prospectOpportunity.aggregate({ where: { companyId }, _max: { lastSeenAt: true } }),
  ])
  return { counts, top, newSince24h, lastCollectedAt: lastRun._max.lastSeenAt }
}

export type DashboardProspection = Awaited<ReturnType<typeof getDashboardProspection>>
