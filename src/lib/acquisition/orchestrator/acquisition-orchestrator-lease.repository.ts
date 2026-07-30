/**
 * Lease durable orchestrateur — SQL atomique, TX courte uniquement.
 * Expiration basée sur clock_timestamp() PostgreSQL (pas l’horloge Node).
 * Ne jamais garder une transaction ouverte pendant les workers.
 */

import type { PrismaClient } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import type {
  AcquisitionOrchestratorLeaseRepositoryPort,
  LeaseAcquireOutcome,
  LeaseOwnershipOutcome,
  LeaseReleaseOutcome,
} from "@/lib/acquisition/orchestrator/acquisition-orchestrator.types"

type Db = PrismaClient

export class PrismaAcquisitionOrchestratorLeaseRepository
  implements AcquisitionOrchestratorLeaseRepositoryPort
{
  constructor(private readonly db: Db = prisma) {}

  async acquire(input: {
    key: string
    ownerRunId: string
    leaseTtlMs: number
  }): Promise<LeaseAcquireOutcome> {
    const ttlMs = Math.max(1, Math.floor(input.leaseTtlMs))

    return this.db.$transaction(async (tx) => {
      await tx.$executeRaw`
        INSERT INTO "acquisition_orchestrator_leases" (
          "key",
          "ownerRunId",
          "leaseExpiresAt",
          "acquiredAt",
          "updatedAt"
        )
        VALUES (
          ${input.key},
          NULL,
          NULL,
          NULL,
          clock_timestamp()
        )
        ON CONFLICT ("key") DO NOTHING
      `

      // Libre ⇔ owner null OU (expires non null ET expiré). Pas owner+expires null.
      const rows = await tx.$queryRaw<Array<{ key: string }>>`
        UPDATE "acquisition_orchestrator_leases"
        SET
          "ownerRunId" = ${input.ownerRunId},
          "leaseExpiresAt" = clock_timestamp() + (${ttlMs}::bigint * interval '1 millisecond'),
          "acquiredAt" = clock_timestamp(),
          "updatedAt" = clock_timestamp()
        WHERE "key" = ${input.key}
          AND (
            "ownerRunId" IS NULL
            OR (
              "leaseExpiresAt" IS NOT NULL
              AND "leaseExpiresAt" < clock_timestamp()
            )
          )
        RETURNING "key"
      `

      if (rows.length === 0) {
        return { outcome: "ALREADY_RUNNING" as const }
      }
      return { outcome: "ACQUIRED" as const }
    })
  }

  async release(input: {
    key: string
    ownerRunId: string
  }): Promise<LeaseReleaseOutcome> {
    const result = await this.db.$executeRaw`
      UPDATE "acquisition_orchestrator_leases"
      SET
        "ownerRunId" = NULL,
        "leaseExpiresAt" = NULL,
        "acquiredAt" = NULL,
        "updatedAt" = clock_timestamp()
      WHERE "key" = ${input.key}
        AND "ownerRunId" = ${input.ownerRunId}
    `
    const count = typeof result === "number" ? result : Number(result)
    if (count > 0) return { outcome: "RELEASED" }

    const existing = await this.db.$queryRaw<Array<{ key: string }>>`
      SELECT "key" FROM "acquisition_orchestrator_leases" WHERE "key" = ${input.key} LIMIT 1
    `
    if (existing.length === 0) return { outcome: "NOT_FOUND" }
    return { outcome: "NOT_OWNER" }
  }

  async assertOwned(input: {
    key: string
    ownerRunId: string
  }): Promise<LeaseOwnershipOutcome> {
    const rows = await this.db.$queryRaw<Array<{ ownerRunId: string | null }>>`
      SELECT "ownerRunId"
      FROM "acquisition_orchestrator_leases"
      WHERE "key" = ${input.key}
        AND "ownerRunId" = ${input.ownerRunId}
        AND "leaseExpiresAt" IS NOT NULL
        AND "leaseExpiresAt" >= clock_timestamp()
      LIMIT 1
    `
    if (rows.length > 0) return { outcome: "OWNED" }

    const existing = await this.db.$queryRaw<Array<{ key: string }>>`
      SELECT "key" FROM "acquisition_orchestrator_leases" WHERE "key" = ${input.key} LIMIT 1
    `
    if (existing.length === 0) return { outcome: "NOT_FOUND" }
    return { outcome: "NOT_OWNER" }
  }

  async renew(input: {
    key: string
    ownerRunId: string
    leaseTtlMs: number
  }): Promise<LeaseOwnershipOutcome> {
    const ttlMs = Math.max(1, Math.floor(input.leaseTtlMs))
    const rows = await this.db.$queryRaw<Array<{ key: string }>>`
      UPDATE "acquisition_orchestrator_leases"
      SET
        "leaseExpiresAt" = clock_timestamp() + (${ttlMs}::bigint * interval '1 millisecond'),
        "updatedAt" = clock_timestamp()
      WHERE "key" = ${input.key}
        AND "ownerRunId" = ${input.ownerRunId}
        AND "leaseExpiresAt" IS NOT NULL
        AND "leaseExpiresAt" >= clock_timestamp()
      RETURNING "key"
    `
    if (rows.length > 0) return { outcome: "OWNED" }
    return this.assertOwned({ key: input.key, ownerRunId: input.ownerRunId })
  }
}

export const acquisitionOrchestratorLeaseRepository =
  new PrismaAcquisitionOrchestratorLeaseRepository()

/** Implémentation mémoire — mêmes règles pour tests unitaires. */
export class InMemoryAcquisitionOrchestratorLeaseRepository
  implements AcquisitionOrchestratorLeaseRepositoryPort
{
  private readonly rows = new Map<
    string,
    {
      ownerRunId: string | null
      leaseExpiresAt: Date | null
      acquiredAt: Date | null
    }
  >()

  /** Horloge injectable pour simuler l’expiration. */
  nowFn: () => Date = () => new Date()

  async acquire(input: {
    key: string
    ownerRunId: string
    leaseTtlMs: number
  }): Promise<LeaseAcquireOutcome> {
    const now = this.nowFn()
    const existing = this.rows.get(input.key)
    if (!existing) {
      this.rows.set(input.key, {
        ownerRunId: input.ownerRunId,
        leaseExpiresAt: new Date(now.getTime() + input.leaseTtlMs),
        acquiredAt: now,
      })
      return { outcome: "ACQUIRED" }
    }

    const free =
      existing.ownerRunId == null ||
      (existing.leaseExpiresAt != null && existing.leaseExpiresAt < now)

    if (!free) return { outcome: "ALREADY_RUNNING" }

    this.rows.set(input.key, {
      ownerRunId: input.ownerRunId,
      leaseExpiresAt: new Date(now.getTime() + input.leaseTtlMs),
      acquiredAt: now,
    })
    return { outcome: "ACQUIRED" }
  }

  async release(input: {
    key: string
    ownerRunId: string
  }): Promise<LeaseReleaseOutcome> {
    const existing = this.rows.get(input.key)
    if (!existing) return { outcome: "NOT_FOUND" }
    if (existing.ownerRunId !== input.ownerRunId) return { outcome: "NOT_OWNER" }
    this.rows.set(input.key, {
      ownerRunId: null,
      leaseExpiresAt: null,
      acquiredAt: null,
    })
    return { outcome: "RELEASED" }
  }

  async assertOwned(input: {
    key: string
    ownerRunId: string
  }): Promise<LeaseOwnershipOutcome> {
    const now = this.nowFn()
    const existing = this.rows.get(input.key)
    if (!existing) return { outcome: "NOT_FOUND" }
    if (
      existing.ownerRunId === input.ownerRunId &&
      existing.leaseExpiresAt != null &&
      existing.leaseExpiresAt >= now
    ) {
      return { outcome: "OWNED" }
    }
    return { outcome: "NOT_OWNER" }
  }

  async renew(input: {
    key: string
    ownerRunId: string
    leaseTtlMs: number
  }): Promise<LeaseOwnershipOutcome> {
    const owned = await this.assertOwned(input)
    if (owned.outcome !== "OWNED") return owned
    const now = this.nowFn()
    this.rows.set(input.key, {
      ownerRunId: input.ownerRunId,
      leaseExpiresAt: new Date(now.getTime() + input.leaseTtlMs),
      acquiredAt: now,
    })
    return { outcome: "OWNED" }
  }

  peek(key: string) {
    return this.rows.get(key) ?? null
  }

  /** Force un état incohérent (tests prédicat). */
  seedCorrupt(key: string, ownerRunId: string) {
    this.rows.set(key, {
      ownerRunId,
      leaseExpiresAt: null,
      acquiredAt: this.nowFn(),
    })
  }

  /** Force un propriétaire (tests fence / steal). */
  forceOwner(key: string, ownerRunId: string, leaseTtlMs: number) {
    const now = this.nowFn()
    this.rows.set(key, {
      ownerRunId,
      leaseExpiresAt: new Date(now.getTime() + leaseTtlMs),
      acquiredAt: now,
    })
  }
}
