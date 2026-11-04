/**
 * Veille prospection — persistance Prisma des opportunités (table `prospect_opportunities`).
 *
 * La collecte crée les nouvelles fiches, met à jour celles dont le contenu ou le score a changé et ne fait que
 * rafraîchir `lastSeenAt` pour les autres. Elle ne touche jamais au statut : il appartient au suivi humain.
 * Toutes les requêtes sont filtrées par `companyId`.
 */
import type { Prisma } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import { isRecentlyClosedWorthRecontact, priorityRankFor } from "@/lib/prospection/priority"
import type {
  ProspectBand,
  ProspectKind,
  ProspectSource,
  ProspectStatus,
  ScoreReason,
  ScoredCandidate,
} from "@/lib/prospection/prospection.types"

const CREATE_CHUNK = 500
const UPDATE_CONCURRENCY = 10

export interface UpsertSummary {
  created: number
  updated: number
  unchanged: number
}

export interface ProspectionRepositoryPort {
  upsertCandidates(companyId: string, candidates: readonly ScoredCandidate[], now: Date): Promise<UpsertSummary>
  applyAwards(companyId: string, awardedTo: ReadonlyMap<string, string[]>): Promise<number>
  countBySource(companyId: string, source: ProspectSource): Promise<number>
}

function signature(row: {
  priorityGroup: number
  title: string
  organization: string | null
  deadlineAt: Date | null
  eventStartAt: Date | null
  eventPeriod: string | null
  url: string | null
  score: number
  band: string
  winners: string[]
  departmentCodes: string[]
  alsoSeenIn: string[]
}): string {
  return JSON.stringify([
    row.priorityGroup, row.title, row.organization, row.deadlineAt?.toISOString() ?? null, row.eventStartAt?.toISOString() ?? null,
    row.eventPeriod, row.url, row.score, row.band, [...row.winners].sort(), [...row.departmentCodes].sort(), [...row.alsoSeenIn].sort(),
  ])
}

function dataFor(candidate: ScoredCandidate, now: Date) {
  return {
    kind: candidate.kind,
    title: candidate.title,
    organization: candidate.organization,
    departmentCodes: candidate.departmentCodes,
    locality: candidate.locality,
    publishedAt: candidate.publishedAt,
    deadlineAt: candidate.deadlineAt,
    eventStartAt: candidate.eventStartAt,
    eventPeriod: candidate.eventPeriod,
    url: candidate.url,
    winners: candidate.winners,
    linkedSourceIds: candidate.linkedSourceIds,
    descriptors: candidate.descriptors,
    alsoSeenIn: candidate.alsoSeenIn,
    priorityGroup: priorityRankFor(candidate),
    score: candidate.score,
    band: candidate.band,
    scoreReasons: candidate.reasons as unknown as Prisma.InputJsonValue,
    fingerprint: candidate.fingerprint,
    lastSeenAt: now,
  }
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const result: T[][] = []
  for (let i = 0; i < items.length; i += size) result.push(items.slice(i, i + size))
  return result
}

export const prospectionRepository: ProspectionRepositoryPort = {
  async upsertCandidates(companyId, candidates, now) {
    const summary: UpsertSummary = { created: 0, updated: 0, unchanged: 0 }
    const bySource = new Map<ProspectSource, ScoredCandidate[]>()
    for (const candidate of candidates) bySource.set(candidate.source, [...(bySource.get(candidate.source) ?? []), candidate])

    for (const [source, list] of bySource) {
      const existing = await prisma.prospectOpportunity.findMany({
        where: { companyId, source, sourceId: { in: list.map((candidate) => candidate.sourceId) } },
        select: {
          id: true, sourceId: true, priorityGroup: true, title: true, organization: true, deadlineAt: true, eventStartAt: true, eventPeriod: true,
          url: true, score: true, band: true, winners: true, departmentCodes: true, alsoSeenIn: true,
        },
      })
      const existingBySourceId = new Map(existing.map((row) => [row.sourceId, row]))

      const toCreate = list.filter((candidate) => !existingBySourceId.has(candidate.sourceId))
      for (const part of chunk(toCreate, CREATE_CHUNK)) {
        const result = await prisma.prospectOpportunity.createMany({
          data: part.map((candidate) => ({ companyId, source, sourceId: candidate.sourceId, firstSeenAt: now, ...dataFor(candidate, now) })),
          skipDuplicates: true,
        })
        summary.created += result.count
      }

      const toUpdate: ScoredCandidate[] = []
      const unchangedIds: string[] = []
      for (const candidate of list) {
        const row = existingBySourceId.get(candidate.sourceId)
        if (!row) continue
        if (signature(row) === signature({ ...candidate, priorityGroup: priorityRankFor(candidate) })) unchangedIds.push(row.id)
        else toUpdate.push(candidate)
      }

      for (const part of chunk(toUpdate, UPDATE_CONCURRENCY)) {
        await Promise.all(
          part.map((candidate) =>
            prisma.prospectOpportunity.update({
              where: { companyId_source_sourceId: { companyId, source, sourceId: candidate.sourceId } },
              data: dataFor(candidate, now),
            }),
          ),
        )
        summary.updated += part.length
      }

      for (const ids of chunk(unchangedIds, CREATE_CHUNK)) {
        await prisma.prospectOpportunity.updateMany({ where: { companyId, id: { in: ids } }, data: { lastSeenAt: now } })
      }
      summary.unchanged += unchangedIds.length
    }
    return summary
  },

  async applyAwards(companyId, awardedTo) {
    let updated = 0
    for (const [tenderId, winners] of awardedTo) {
      const result = await prisma.prospectOpportunity.updateMany({
        where: { companyId, source: "BOAMP", sourceId: tenderId },
        data: { awardedTo: winners },
      })
      updated += result.count
    }
    return updated
  },

  async countBySource(companyId, source) {
    return prisma.prospectOpportunity.count({ where: { companyId, source } })
  },
}

export interface OpportunityListFilters {
  companyId: string
  now: Date
  kind: ProspectKind
  includeHidden: boolean
  departmentCode: string | null
  status: ProspectStatus | null
  limit: number
}

export type OpportunityListItem = Awaited<ReturnType<typeof listOpportunities>>[number]

export async function listOpportunities(filters: OpportunityListFilters) {
  const visibleBands: ProspectBand[] = filters.includeHidden ? ["A_TRAITER", "A_VERIFIER", "MASQUE"] : ["A_TRAITER", "A_VERIFIER"]
  // Ordre de priorité de Nizar d'abord (mairies IDF, montage IDF, autres IDF, voisins, reste), puis le score.
  const orderBy: Prisma.ProspectOpportunityOrderByWithRelationInput[] = [
    { priorityGroup: "asc" },
    ...(filters.kind === "TENDER"
      ? [{ score: "desc" as const }, { deadlineAt: { sort: "asc" as const, nulls: "last" as const } }]
      : filters.kind === "AWARD"
        ? [{ score: "desc" as const }, { publishedAt: { sort: "desc" as const, nulls: "last" as const } }]
        : [{ score: "desc" as const }, { title: "asc" as const }]),
  ]

  return prisma.prospectOpportunity.findMany({
    where: {
      companyId: filters.companyId,
      kind: filters.kind,
      band: { in: visibleBands },
      // Un appel d'offres clos n'est plus une piste ouverte, même si son score a été calculé avant l'échéance.
      ...(filters.kind === "TENDER" ? openTenderWhere(filters.now) : {}),
      ...(filters.departmentCode ? { departmentCodes: { has: filters.departmentCode } } : {}),
      ...(filters.status ? { status: filters.status } : {}),
    },
    orderBy,
    take: filters.limit,
    select: {
      id: true, source: true, sourceId: true, kind: true, title: true, organization: true, departmentCodes: true,
      locality: true, publishedAt: true, deadlineAt: true, eventStartAt: true, eventPeriod: true, url: true,
      winners: true, awardedTo: true, descriptors: true, alsoSeenIn: true, priorityGroup: true, score: true, band: true,
      scoreReasons: true, status: true, statusUpdatedAt: true, firstSeenAt: true,
    },
  })
}

function openTenderWhere(now: Date): Prisma.ProspectOpportunityWhereInput {
  return { OR: [{ deadlineAt: null }, { deadlineAt: { gte: now } }] }
}

export async function countOpportunitiesByKind(companyId: string, now: Date): Promise<Record<ProspectKind, number>> {
  const rows = await prisma.prospectOpportunity.groupBy({
    by: ["kind"],
    where: {
      companyId,
      band: { in: ["A_TRAITER", "A_VERIFIER"] },
      status: { notIn: ["ECARTE", "PERDU"] },
      OR: [{ kind: { not: "TENDER" } }, ...(openTenderWhere(now).OR ?? [])],
    },
    _count: { _all: true },
  })
  const counts: Record<ProspectKind, number> = { TENDER: 0, AWARD: 0, EVENT: 0 }
  for (const row of rows) if (row.kind in counts) counts[row.kind as ProspectKind] = row._count._all
  return counts
}

const RECENTLY_CLOSED_SCAN_LIMIT = 50

/** Marchés clos récemment des groupes 1 et 2 (mairies IDF, montage IDF) qui auraient été retenus. */
export async function listRecentlyClosedTenders(companyId: string, now: Date) {
  const since = new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000)
  const rows = await prisma.prospectOpportunity.findMany({
    where: { companyId, kind: "TENDER", priorityGroup: { lte: 2 }, deadlineAt: { gte: since, lt: now }, status: { notIn: ["ECARTE"] } },
    orderBy: [{ priorityGroup: "asc" }, { deadlineAt: "desc" }],
    take: RECENTLY_CLOSED_SCAN_LIMIT,
    select: { id: true, title: true, organization: true, url: true, deadlineAt: true, priorityGroup: true, band: true, scoreReasons: true },
  })
  return rows.filter((row) =>
    isRecentlyClosedWorthRecontact({ ...row, kind: "TENDER", reasons: (Array.isArray(row.scoreReasons) ? row.scoreReasons : []) as unknown as ScoreReason[] }, now),
  )
}

export type RecentlyClosedTender = Awaited<ReturnType<typeof listRecentlyClosedTenders>>[number]

/** Suivi humain : seule action d'écriture de l'interface, filtrée par société. */
export async function updateOpportunityStatus(input: {
  companyId: string
  id: string
  status: ProspectStatus
  userId: string
  now: Date
}): Promise<boolean> {
  const result = await prisma.prospectOpportunity.updateMany({
    where: { id: input.id, companyId: input.companyId },
    data: { status: input.status, statusUpdatedAt: input.now, statusUpdatedById: input.userId },
  })
  return result.count === 1
}
