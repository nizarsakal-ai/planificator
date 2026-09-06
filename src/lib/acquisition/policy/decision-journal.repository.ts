/**
 * PLAN-ACQ-V2 Lot F / PLAN-ACQ-AGENTS-LOT-3D — Journal des décisions.
 * decisionCode est String libre (pas d’enum Prisma).
 * CORRECTION-4A — appendOnce + idempotencyKey (autorité PostgreSQL).
 */

import { createHash } from "node:crypto"
import { Prisma, type PrismaClient } from "@prisma/client"
import { prisma } from "@/lib/prisma"

/** Client Prisma root ou TransactionClient (CORRECTION-4B). */
export type DecisionJournalDbClient = PrismaClient | Prisma.TransactionClient

export const VALIDATION_DECISION_CODES = [
  "VALIDATION_PASS",
  "VALIDATION_QUARANTINE",
  "VALIDATION_FAIL_RETRYABLE",
  "VALIDATION_FAIL_TERMINAL",
] as const

export type ValidationDecisionCode = (typeof VALIDATION_DECISION_CODES)[number]

export type DecisionJournalEntry = {
  companyId: string
  draftId: string
  decisionCode: string
  reasons: string[]
  scores: Record<string, number>
  actorUserId: string | null
  metadata?: Record<string, unknown>
  /** CORRECTION-4A — optionnel pour legacy append ; requis pour appendOnce. */
  idempotencyKey?: string
}

export type ValidationJournalRow = {
  id: string
  companyId: string
  draftId: string
  decisionCode: ValidationDecisionCode
  reasons: unknown
  scores: unknown
  actorUserId: string | null
  metadata: unknown
  createdAt: Date
}

export type ValidationCycleIdentity = {
  contentHash: string
  extractionSchemaVersion: string | null
  draftVersion: number
}

/**
 * PLAN-ACQ-AGENTS-LOT-3E — Cycle figé dans metadata AUTO_* / CANCELLATION_*.
 * `validatedDraftVersion` = version AVANT approve/reject.
 */
export type FrozenValidationCycle = {
  contentHash: string
  extractionSchemaVersion: string | null
  validatedDraftVersion: number
}

export const AUTO_DECISION_INTENT_CODES = [
  "AUTO_APPROVE_ONLY",
  "AUTO_APPROVE_CONVERT",
  "AUTO_REJECT_CANCELLED",
  "HUMAN_REVIEW_REQUIRED",
] as const

export type AutoDecisionIntentCode = (typeof AUTO_DECISION_INTENT_CODES)[number]

export const CANCELLATION_FOLLOWUP_CODES = [
  "CANCELLATION_FOLLOWUP_APPLIED",
  "CANCELLATION_AFTER_CONVERSION",
  "CANCELLATION_TARGET_AMBIGUOUS",
  "CANCELLATION_NO_LINK",
] as const

export type CancellationFollowUpJournalCode =
  (typeof CANCELLATION_FOLLOWUP_CODES)[number]

export type JournalRow = {
  id: string
  companyId: string
  draftId: string
  decisionCode: string
  reasons: unknown
  scores: unknown
  actorUserId: string | null
  metadata: unknown
  createdAt: Date
  idempotencyKey?: string | null
}

export type AppendOnceResult = {
  outcome: "APPENDED" | "ALREADY_EXISTS"
  row: JournalRow
}

const VALIDATION_CODE_SET = new Set<string>(VALIDATION_DECISION_CODES)
const AUTO_INTENT_CODE_SET = new Set<string>(AUTO_DECISION_INTENT_CODES)
const FOLLOWUP_CODE_SET = new Set<string>(CANCELLATION_FOLLOWUP_CODES)

function isRecord(v: unknown): v is Record<string, unknown> {
  return v != null && typeof v === "object" && !Array.isArray(v)
}

export function parseValidationCycleIdentity(
  metadata: unknown
): ValidationCycleIdentity | null {
  if (!isRecord(metadata)) return null
  const contentHash =
    typeof metadata.contentHash === "string" ? metadata.contentHash : null
  if (!contentHash) return null
  const draftVersion = metadata.draftVersion
  if (typeof draftVersion !== "number" || !Number.isFinite(draftVersion)) {
    return null
  }
  const extractionSchemaVersion =
    metadata.extractionSchemaVersion === null
      ? null
      : typeof metadata.extractionSchemaVersion === "string"
        ? metadata.extractionSchemaVersion
        : null
  return {
    contentHash,
    extractionSchemaVersion,
    draftVersion,
  }
}

export function validationCyclesMatch(
  a: ValidationCycleIdentity,
  b: ValidationCycleIdentity
): boolean {
  return (
    a.contentHash === b.contentHash &&
    a.extractionSchemaVersion === b.extractionSchemaVersion &&
    a.draftVersion === b.draftVersion
  )
}

/** Convertit identité validation (draftVersion) → cycle figé intent. */
export function toFrozenValidationCycle(
  cycle: ValidationCycleIdentity
): FrozenValidationCycle {
  return {
    contentHash: cycle.contentHash,
    extractionSchemaVersion: cycle.extractionSchemaVersion,
    validatedDraftVersion: cycle.draftVersion,
  }
}

export function parseFrozenValidationCycle(
  metadata: unknown
): FrozenValidationCycle | null {
  if (!isRecord(metadata)) return null
  const nested = metadata.validationCycle
  if (!isRecord(nested)) return null
  const contentHash =
    typeof nested.contentHash === "string" ? nested.contentHash : null
  if (!contentHash) return null
  const validatedDraftVersion = nested.validatedDraftVersion
  if (
    typeof validatedDraftVersion !== "number" ||
    !Number.isFinite(validatedDraftVersion)
  ) {
    return null
  }
  const extractionSchemaVersion =
    nested.extractionSchemaVersion === null
      ? null
      : typeof nested.extractionSchemaVersion === "string"
        ? nested.extractionSchemaVersion
        : null
  return {
    contentHash,
    extractionSchemaVersion,
    validatedDraftVersion,
  }
}

export function frozenValidationCyclesMatch(
  a: FrozenValidationCycle,
  b: FrozenValidationCycle
): boolean {
  return (
    a.contentHash === b.contentHash &&
    a.extractionSchemaVersion === b.extractionSchemaVersion &&
    a.validatedDraftVersion === b.validatedDraftVersion
  )
}

/** Pre-mutation : draft PENDING_REVIEW doit matcher le cycle figé de l’intent. */
export function draftMatchesFrozenCycle(input: {
  contentHashAtExtraction: string | null
  extractionSchemaVersion: string | null
  version: number
  frozen: FrozenValidationCycle
}): boolean {
  if (!input.contentHashAtExtraction) return false
  return (
    input.contentHashAtExtraction === input.frozen.contentHash &&
    input.extractionSchemaVersion === input.frozen.extractionSchemaVersion &&
    input.version === input.frozen.validatedDraftVersion
  )
}

/** PLAN-ACQ-AGENTS-LOT-3F — pipeline marker écrit par le worker steps. */
export function isPostExtractionStepsPipeline(metadata: unknown): boolean {
  if (!isRecord(metadata)) return false
  return metadata.pipeline === "POST_EXTRACTION_STEPS"
}

/**
 * PLAN-ACQ-AGENTS-LOT-3F — identité extraction (hash+schema), sans validatedDraftVersion.
 * Post-approve : draft.version ≠ validatedDraftVersion.
 */
export function frozenMatchesExtractionIdentity(
  frozen: FrozenValidationCycle,
  identity: {
    contentHash: string
    extractionSchemaVersion: string | null
  }
): boolean {
  return (
    frozen.contentHash === identity.contentHash &&
    frozen.extractionSchemaVersion === identity.extractionSchemaVersion
  )
}

/**
 * PLAN-ACQ-AGENTS-LOT-3F Correction-1 — association directe approve :
 * APPROVED.version === validatedDraftVersion + 1 (un seul bump approve).
 */
export function isDirectApprovalAssociation(input: {
  draftVersion: number
  validatedDraftVersion: number
}): boolean {
  return input.draftVersion === input.validatedDraftVersion + 1
}

function asValidationCode(code: string): ValidationDecisionCode | null {
  return VALIDATION_CODE_SET.has(code) ? (code as ValidationDecisionCode) : null
}

function asAutoIntentCode(code: string): AutoDecisionIntentCode | null {
  return AUTO_INTENT_CODE_SET.has(code)
    ? (code as AutoDecisionIntentCode)
    : null
}

function isUniqueConstraintError(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002"
  )
}

/** CORRECTION-4A-R2 — refuse un winner cross-tenant / cross-draft ; message sans IDs. */
function assertAppendOnceWinnerScope(
  entry: DecisionJournalEntry,
  row: Pick<JournalRow, "companyId" | "draftId">
): void {
  if (row.companyId !== entry.companyId || row.draftId !== entry.draftId) {
    throw new Error("DECISION_JOURNAL_IDEMPOTENCY_SCOPE_MISMATCH")
  }
}

function sha256Canonical(parts: unknown[]): string {
  return createHash("sha256").update(JSON.stringify(parts), "utf8").digest("hex")
}

/** CORRECTION-4A — slot VALIDATION_* par tentative (decisionCode hors clé). */
export function buildValidationDecisionIdempotencyKey(input: {
  companyId: string
  draftId: string
  cycle: ValidationCycleIdentity
  validationAttempt: number
}): string {
  const digest = sha256Canonical([
    "validation",
    input.companyId,
    input.draftId,
    input.cycle.contentHash,
    input.cycle.extractionSchemaVersion,
    input.cycle.draftVersion,
    input.validationAttempt,
  ])
  return `v1:validation:${digest}`
}

/** CORRECTION-4A — un slot intent AUTO_* / HUMAN par FrozenValidationCycle. */
export function buildAutoIntentIdempotencyKey(input: {
  companyId: string
  draftId: string
  frozen: FrozenValidationCycle
}): string {
  const digest = sha256Canonical([
    "auto-intent",
    input.companyId,
    input.draftId,
    input.frozen.contentHash,
    input.frozen.extractionSchemaVersion,
    input.frozen.validatedDraftVersion,
  ])
  return `v1:auto-intent:${digest}`
}

/** CORRECTION-4A — un slot SYSTEM_ACTOR_INVALID par FrozenValidationCycle. */
export function buildSystemActorInvalidIdempotencyKey(input: {
  companyId: string
  draftId: string
  frozen: FrozenValidationCycle
}): string {
  const digest = sha256Canonical([
    "system-actor-invalid",
    input.companyId,
    input.draftId,
    input.frozen.contentHash,
    input.frozen.extractionSchemaVersion,
    input.frozen.validatedDraftVersion,
  ])
  return `v1:system-actor-invalid:${digest}`
}

/** CORRECTION-4B — un slot CANCELLATION_* par FrozenValidationCycle (decisionCode hors clé). */
export function buildCancellationFollowUpIdempotencyKey(input: {
  companyId: string
  sourceDraftId: string
  frozen: FrozenValidationCycle
}): string {
  const digest = sha256Canonical([
    "cancellation-followup",
    input.companyId,
    input.sourceDraftId,
    input.frozen.contentHash,
    input.frozen.extractionSchemaVersion,
    input.frozen.validatedDraftVersion,
  ])
  return `v1:cancellation-followup:${digest}`
}

/**
 * Tentative de validation pour un cycle (CORRECTION-4A).
 * - aucun VALIDATION_* cycle → 1
 * - dernier = FAIL_RETRYABLE attempt=N → N+1
 * - legacy sans attempt → traité comme 1 puis +1
 */
export function resolveValidationAttemptNumber(
  existing: ValidationJournalRow | null
): number {
  if (!existing) return 1
  if (existing.decisionCode !== "VALIDATION_FAIL_RETRYABLE") return 1
  const meta =
    existing.metadata &&
    typeof existing.metadata === "object" &&
    !Array.isArray(existing.metadata)
      ? (existing.metadata as Record<string, unknown>)
      : {}
  const attempt =
    typeof meta.attempt === "number" && Number.isFinite(meta.attempt)
      ? Math.max(0, Math.floor(meta.attempt))
      : 1
  return attempt + 1
}

export class AcquisitionDecisionJournalRepository {
  constructor(private readonly db: DecisionJournalDbClient = prisma) {}

  async append(entry: DecisionJournalEntry): Promise<void> {
    await this.db.acquisitionDecisionJournal.create({
      data: {
        companyId: entry.companyId,
        draftId: entry.draftId,
        decisionCode: entry.decisionCode,
        reasons: entry.reasons as Prisma.InputJsonValue,
        scores: entry.scores as Prisma.InputJsonValue,
        actorUserId: entry.actorUserId,
        metadata: (entry.metadata ?? undefined) as Prisma.InputJsonValue | undefined,
        ...(entry.idempotencyKey
          ? { idempotencyKey: entry.idempotencyKey }
          : {}),
      },
    })
  }

  /**
   * CORRECTION-4A — create atomique sous unique idempotencyKey.
   * P2002 → relecture stricte par clé → ALREADY_EXISTS ; sinon rethrow.
   */
  async appendOnce(entry: DecisionJournalEntry): Promise<AppendOnceResult> {
    const key = entry.idempotencyKey?.trim()
    if (!key) {
      throw new Error("IDEMPOTENCY_KEY_REQUIRED")
    }

    try {
      const row = await this.db.acquisitionDecisionJournal.create({
        data: {
          companyId: entry.companyId,
          draftId: entry.draftId,
          decisionCode: entry.decisionCode,
          reasons: entry.reasons as Prisma.InputJsonValue,
          scores: entry.scores as Prisma.InputJsonValue,
          actorUserId: entry.actorUserId,
          metadata: (entry.metadata ?? undefined) as
            | Prisma.InputJsonValue
            | undefined,
          idempotencyKey: key,
        },
        select: {
          id: true,
          companyId: true,
          draftId: true,
          decisionCode: true,
          reasons: true,
          scores: true,
          actorUserId: true,
          metadata: true,
          createdAt: true,
          idempotencyKey: true,
        },
      })
      return { outcome: "APPENDED", row }
    } catch (error) {
      if (!isUniqueConstraintError(error)) throw error
      const existing = await this.findByIdempotencyKey(key)
      if (!existing) throw error
      assertAppendOnceWinnerScope(entry, existing)
      return { outcome: "ALREADY_EXISTS", row: existing }
    }
  }

  /**
   * LOT-3G — append sûr dans une interactive TX déjà ouverte.
   * Pré-lecture par clé puis create (pas de catch P2002 : abort TX sinon).
   * Collision unique concurrente inattendue → laisse remonter.
   */
  async appendOnceInTransaction(
    entry: DecisionJournalEntry
  ): Promise<AppendOnceResult> {
    const key = entry.idempotencyKey?.trim()
    if (!key) {
      throw new Error("IDEMPOTENCY_KEY_REQUIRED")
    }

    const existing = await this.findByIdempotencyKey(key)
    if (existing) {
      assertAppendOnceWinnerScope(entry, existing)
      return { outcome: "ALREADY_EXISTS", row: existing }
    }

    const row = await this.db.acquisitionDecisionJournal.create({
      data: {
        companyId: entry.companyId,
        draftId: entry.draftId,
        decisionCode: entry.decisionCode,
        reasons: entry.reasons as Prisma.InputJsonValue,
        scores: entry.scores as Prisma.InputJsonValue,
        actorUserId: entry.actorUserId,
        metadata: (entry.metadata ?? undefined) as
          | Prisma.InputJsonValue
          | undefined,
        idempotencyKey: key,
      },
      select: {
        id: true,
        companyId: true,
        draftId: true,
        decisionCode: true,
        reasons: true,
        scores: true,
        actorUserId: true,
        metadata: true,
        createdAt: true,
        idempotencyKey: true,
      },
    })
    return { outcome: "APPENDED", row }
  }

  async findByIdempotencyKey(idempotencyKey: string): Promise<JournalRow | null> {
    const row = await this.db.acquisitionDecisionJournal.findUnique({
      where: { idempotencyKey },
      select: {
        id: true,
        companyId: true,
        draftId: true,
        decisionCode: true,
        reasons: true,
        scores: true,
        actorUserId: true,
        metadata: true,
        createdAt: true,
        idempotencyKey: true,
      },
    })
    return row
  }

  /**
   * Dernière décision VALIDATION_* pour un draft (tenant-safe).
   * Indépendant du cycle — le caller compare l’identité.
   */
  async findLatestValidationDecision(input: {
    companyId: string
    draftId: string
  }): Promise<ValidationJournalRow | null> {
    const row = await this.db.acquisitionDecisionJournal.findFirst({
      where: {
        companyId: input.companyId,
        draftId: input.draftId,
        decisionCode: { in: [...VALIDATION_DECISION_CODES] },
      },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        companyId: true,
        draftId: true,
        decisionCode: true,
        reasons: true,
        scores: true,
        actorUserId: true,
        metadata: true,
        createdAt: true,
      },
    })
    if (!row) return null
    const code = asValidationCode(row.decisionCode)
    if (!code) return null
    return { ...row, decisionCode: code }
  }

  /**
   * Dernière VALIDATION_* dont le cycle metadata correspond.
   * Pagination déterministe — aucune borne arbitraire qui masque un match.
   */
  async findLatestValidationDecisionForCycle(input: {
    companyId: string
    draftId: string
    cycle: ValidationCycleIdentity
  }): Promise<ValidationJournalRow | null> {
    const pageSize = 50
    let cursor: { createdAt: Date; id: string } | null = null

    type JournalSelectRow = {
      id: string
      companyId: string
      draftId: string
      decisionCode: string
      reasons: unknown
      scores: unknown
      actorUserId: string | null
      metadata: unknown
      createdAt: Date
    }

    for (;;) {
      const rows: JournalSelectRow[] =
        await this.db.acquisitionDecisionJournal.findMany({
          where: {
            companyId: input.companyId,
            draftId: input.draftId,
            decisionCode: { in: [...VALIDATION_DECISION_CODES] },
            ...(cursor
              ? {
                  OR: [
                    { createdAt: { lt: cursor.createdAt } },
                    {
                      AND: [
                        { createdAt: cursor.createdAt },
                        { id: { lt: cursor.id } },
                      ],
                    },
                  ],
                }
              : {}),
          },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          take: pageSize,
          select: {
            id: true,
            companyId: true,
            draftId: true,
            decisionCode: true,
            reasons: true,
            scores: true,
            actorUserId: true,
            metadata: true,
            createdAt: true,
          },
        })

      if (rows.length === 0) return null

      for (const row of rows) {
        const code = asValidationCode(row.decisionCode)
        if (!code) continue
        const cycle = parseValidationCycleIdentity(row.metadata)
        if (!cycle) continue
        if (validationCyclesMatch(cycle, input.cycle)) {
          return { ...row, decisionCode: code }
        }
      }

      if (rows.length < pageSize) return null
      const last: JournalSelectRow = rows[rows.length - 1]!
      cursor = { createdAt: last.createdAt, id: last.id }
    }
  }

  /**
   * Dernier intent AUTO_* / HUMAN dont metadata.validationCycle matche.
   * Pagination — pas de borne arbitraire qui tronque la recherche.
   */
  async findLatestAutoIntentForCycle(input: {
    companyId: string
    draftId: string
    frozen: FrozenValidationCycle
  }): Promise<(JournalRow & { decisionCode: AutoDecisionIntentCode }) | null> {
    return this.findLatestMatchingDecision({
      companyId: input.companyId,
      draftId: input.draftId,
      codes: [...AUTO_DECISION_INTENT_CODES],
      matchFrozen: input.frozen,
      asCode: asAutoIntentCode,
    })
  }

  /**
   * PLAN-ACQ-AGENTS-LOT-3F — Latest intent post-extraction pour une identité
   * extraction (hash+schema), sans exiger validatedDraftVersion.
   * Inclut ONLY / CONVERT / REJECT / HUMAN : un HUMAN plus récent invalide
   * un ancien CONVERT (caller vérifie le code).
   */
  async findLatestPostExtractionAutoIntentForExtractionIdentity(input: {
    companyId: string
    draftId: string
    contentHash: string
    extractionSchemaVersion: string | null
  }): Promise<(JournalRow & { decisionCode: AutoDecisionIntentCode }) | null> {
    const pageSize = 50
    let cursor: { createdAt: Date; id: string } | null = null

    type JournalSelectRow = {
      id: string
      companyId: string
      draftId: string
      decisionCode: string
      reasons: unknown
      scores: unknown
      actorUserId: string | null
      metadata: unknown
      createdAt: Date
    }

    for (;;) {
      const rows: JournalSelectRow[] =
        await this.db.acquisitionDecisionJournal.findMany({
          where: {
            companyId: input.companyId,
            draftId: input.draftId,
            decisionCode: { in: [...AUTO_DECISION_INTENT_CODES] },
            ...(cursor
              ? {
                  OR: [
                    { createdAt: { lt: cursor.createdAt } },
                    {
                      AND: [
                        { createdAt: cursor.createdAt },
                        { id: { lt: cursor.id } },
                      ],
                    },
                  ],
                }
              : {}),
          },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          take: pageSize,
          select: {
            id: true,
            companyId: true,
            draftId: true,
            decisionCode: true,
            reasons: true,
            scores: true,
            actorUserId: true,
            metadata: true,
            createdAt: true,
          },
        })

      if (rows.length === 0) return null

      for (const row of rows) {
        const code = asAutoIntentCode(row.decisionCode)
        if (!code) continue
        if (!isPostExtractionStepsPipeline(row.metadata)) continue
        const frozen = parseFrozenValidationCycle(row.metadata)
        if (!frozen) continue
        if (
          !frozenMatchesExtractionIdentity(frozen, {
            contentHash: input.contentHash,
            extractionSchemaVersion: input.extractionSchemaVersion,
          })
        ) {
          continue
        }
        return { ...row, decisionCode: code }
      }

      if (rows.length < pageSize) return null
      const last: JournalSelectRow = rows[rows.length - 1]!
      cursor = { createdAt: last.createdAt, id: last.id }
    }
  }

  /**
   * Dernier journal CANCELLATION_* pour le même validationCycle figé.
   */
  async findLatestCancellationFollowUpForCycle(input: {
    companyId: string
    draftId: string
    frozen: FrozenValidationCycle
  }): Promise<(JournalRow & { decisionCode: CancellationFollowUpJournalCode }) | null> {
    return this.findLatestMatchingDecision({
      companyId: input.companyId,
      draftId: input.draftId,
      codes: [...CANCELLATION_FOLLOWUP_CODES],
      matchFrozen: input.frozen,
      asCode: (c) =>
        FOLLOWUP_CODE_SET.has(c)
          ? (c as CancellationFollowUpJournalCode)
          : null,
    })
  }

  async findLatestSystemActorInvalidForCycle(input: {
    companyId: string
    draftId: string
    frozen: FrozenValidationCycle
  }): Promise<JournalRow | null> {
    return this.findLatestMatchingDecision({
      companyId: input.companyId,
      draftId: input.draftId,
      codes: ["SYSTEM_ACTOR_INVALID"],
      matchFrozen: input.frozen,
      asCode: (c) => (c === "SYSTEM_ACTOR_INVALID" ? c : null),
    })
  }

  /**
   * Dernier AUTO_REJECT_CANCELLED avec validationCycle parseable (post-mutation).
   * Ne compare PAS à draft.version courant.
   */
  async findLatestAutoRejectIntentAny(input: {
    companyId: string
    draftId: string
  }): Promise<(JournalRow & { decisionCode: AutoDecisionIntentCode }) | null> {
    const pageSize = 50
    let cursor: { createdAt: Date; id: string } | null = null

    type JournalSelectRow = {
      id: string
      companyId: string
      draftId: string
      decisionCode: string
      reasons: unknown
      scores: unknown
      actorUserId: string | null
      metadata: unknown
      createdAt: Date
    }

    for (;;) {
      const rows: JournalSelectRow[] =
        await this.db.acquisitionDecisionJournal.findMany({
          where: {
            companyId: input.companyId,
            draftId: input.draftId,
            decisionCode: "AUTO_REJECT_CANCELLED",
            ...(cursor
              ? {
                  OR: [
                    { createdAt: { lt: cursor.createdAt } },
                    {
                      AND: [
                        { createdAt: cursor.createdAt },
                        { id: { lt: cursor.id } },
                      ],
                    },
                  ],
                }
              : {}),
          },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          take: pageSize,
          select: {
            id: true,
            companyId: true,
            draftId: true,
            decisionCode: true,
            reasons: true,
            scores: true,
            actorUserId: true,
            metadata: true,
            createdAt: true,
          },
        })
      if (rows.length === 0) return null
      for (const row of rows) {
        const frozen = parseFrozenValidationCycle(row.metadata)
        if (!frozen) continue
        return {
          ...row,
          decisionCode: "AUTO_REJECT_CANCELLED",
        }
      }
      if (rows.length < pageSize) return null
      const last: JournalSelectRow = rows[rows.length - 1]!
      cursor = { createdAt: last.createdAt, id: last.id }
    }
  }

  private async findLatestMatchingDecision<T extends string>(input: {
    companyId: string
    draftId: string
    codes: string[]
    matchFrozen: FrozenValidationCycle
    asCode: (code: string) => T | null
  }): Promise<(JournalRow & { decisionCode: T }) | null> {
    const pageSize = 50
    let cursor: { createdAt: Date; id: string } | null = null

    type JournalSelectRow = {
      id: string
      companyId: string
      draftId: string
      decisionCode: string
      reasons: unknown
      scores: unknown
      actorUserId: string | null
      metadata: unknown
      createdAt: Date
    }

    for (;;) {
      const rows: JournalSelectRow[] =
        await this.db.acquisitionDecisionJournal.findMany({
          where: {
            companyId: input.companyId,
            draftId: input.draftId,
            decisionCode: { in: input.codes },
            ...(cursor
              ? {
                  OR: [
                    { createdAt: { lt: cursor.createdAt } },
                    {
                      AND: [
                        { createdAt: cursor.createdAt },
                        { id: { lt: cursor.id } },
                      ],
                    },
                  ],
                }
              : {}),
          },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          take: pageSize,
          select: {
            id: true,
            companyId: true,
            draftId: true,
            decisionCode: true,
            reasons: true,
            scores: true,
            actorUserId: true,
            metadata: true,
            createdAt: true,
          },
        })

      if (rows.length === 0) return null

      for (const row of rows) {
        const code = input.asCode(row.decisionCode)
        if (!code) continue
        const frozen = parseFrozenValidationCycle(row.metadata)
        if (!frozen) continue
        if (frozenValidationCyclesMatch(frozen, input.matchFrozen)) {
          return { ...row, decisionCode: code }
        }
      }

      if (rows.length < pageSize) return null
      const last: JournalSelectRow = rows[rows.length - 1]!
      cursor = { createdAt: last.createdAt, id: last.id }
    }
  }
}

export const acquisitionDecisionJournalRepository =
  new AcquisitionDecisionJournalRepository()
