/**
 * PLAN-INTEGRATION-PLATFORM-001 — LOT-1C
 * Orchestrateur Mail Shadow — convergence A–F, anti-écrasement CAS.
 */

import type { PrismaClient } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import type { InboundEnvelope } from "@/lib/integration/contracts/inbound-envelope"
import type { NormalizedInbound } from "@/lib/integration/contracts/normalized-inbound"
import { MAIL_SHADOW_CONNECTOR_TYPE } from "@/lib/integration/flags/platform-flag-names"
import {
  parseMailShadowInputDto,
  type MailShadowInputDto,
} from "@/lib/integration/connectors/mail-bridge/mail-shadow-input.dto"
import type {
  MailShadowBridgeContext,
  MailShadowBridgePort,
} from "@/lib/integration/connectors/mail-bridge/mail-shadow-bridge.port"
import {
  logMailShadow,
  logMailShadowError,
} from "@/lib/integration/connectors/mail-bridge/mail-shadow-log"
import { normalizeMessageFamily } from "@/lib/integration/normalizers/message/message-family-normalizer"
import { InboundEnvelopeRepository } from "@/lib/integration/persistence/inbound-envelope.repository"
import { NormalizedInboundRepository } from "@/lib/integration/persistence/normalized-inbound.repository"
import { IntegrationConnectionRepository } from "@/lib/integration/persistence/integration-connection.repository"
import {
  IntegrationInboundLifecycleConflictError,
  IntegrationInboundNormalizedVersionConflictError,
  IntegrationInboundNotFoundError,
  isIntegrationInboundError,
} from "@/lib/integration/persistence/integration-inbound.errors"
import { IntegrationConnectionNotFoundError } from "@/lib/integration/persistence/integration-connection.errors"
import { CONNECTION_STATUSES } from "@/lib/integration/types/connection-status"
import { SECRET_BACKENDS } from "@/lib/integration/types/secret-backend"
import { ENVELOPE_LIFECYCLE_STATUSES } from "@/lib/integration/types/envelope-lifecycle"
import { INBOUND_FAMILY } from "@/lib/integration/types/inbound-family"
import { PLATFORM_SCHEMA_VERSION_V1 } from "@/lib/integration/types/schema-version"

export type MailShadowBridgeDeps = {
  envelopeRepo: InboundEnvelopeRepository
  normalizedRepo: NormalizedInboundRepository
  connectionRepo: IntegrationConnectionRepository
}

function defaultDeps(db: PrismaClient): MailShadowBridgeDeps {
  return {
    envelopeRepo: new InboundEnvelopeRepository(db),
    normalizedRepo: new NormalizedInboundRepository(db),
    connectionRepo: new IntegrationConnectionRepository(db),
  }
}

async function findNormalizedV1(
  normalizedRepo: NormalizedInboundRepository,
  companyId: string,
  envelopeId: string
): Promise<NormalizedInbound | null> {
  try {
    return await normalizedRepo.findByEnvelopeVersion(
      companyId,
      envelopeId,
      INBOUND_FAMILY.MESSAGE,
      PLATFORM_SCHEMA_VERSION_V1
    )
  } catch (error) {
    if (error instanceof IntegrationInboundNotFoundError) return null
    throw error
  }
}

/**
 * Après conflit CAS / version : relire et converger sans écraser un succès.
 */
async function reconcileAfterConflict(
  deps: MailShadowBridgeDeps,
  companyId: string,
  envelopeId: string,
  ctx: MailShadowBridgeContext,
  durationMs: number
): Promise<void> {
  let envelope: InboundEnvelope
  try {
    envelope = await deps.envelopeRepo.findById(companyId, envelopeId)
  } catch {
    ctx.stats.shadowErrors++
    return
  }
  const normalized = await findNormalizedV1(
    deps.normalizedRepo,
    companyId,
    envelopeId
  )

  if (
    envelope.lifecycleStatus === ENVELOPE_LIFECYCLE_STATUSES.NORMALIZED &&
    normalized
  ) {
    ctx.stats.duplicate++
    logMailShadow("info", "mail_shadow_duplicate_after_conflict", {
      companyId,
      connectionId: envelope.connectionId,
      envelopeId,
      outcome: "duplicate",
      durationMs,
    })
    return
  }

  if (
    envelope.lifecycleStatus === ENVELOPE_LIFECYCLE_STATUSES.RECEIVED &&
    normalized
  ) {
    await casToNormalized(deps, companyId, envelopeId, ctx, durationMs)
    return
  }

  if (envelope.lifecycleStatus === ENVELOPE_LIFECYCLE_STATUSES.NORMALIZE_FAILED) {
    ctx.stats.normalizeFailed++
    return
  }
}

async function casToNormalized(
  deps: MailShadowBridgeDeps,
  companyId: string,
  envelopeId: string,
  ctx: MailShadowBridgeContext,
  durationMs: number
): Promise<void> {
  try {
    await deps.envelopeRepo.transitionLifecycle({
      companyId,
      envelopeId,
      expectedStatuses: [ENVELOPE_LIFECYCLE_STATUSES.RECEIVED],
      targetStatus: ENVELOPE_LIFECYCLE_STATUSES.NORMALIZED,
    })
    ctx.stats.normalized++
    logMailShadow("info", "mail_shadow_normalized", {
      companyId,
      envelopeId,
      outcome: "normalized",
      durationMs,
    })
  } catch (error) {
    if (error instanceof IntegrationInboundLifecycleConflictError) {
      await reconcileAfterConflict(deps, companyId, envelopeId, ctx, durationMs)
      return
    }
    throw error
  }
}

/**
 * UNIQUE chemin vers NORMALIZE_FAILED — expectedStatuses: [RECEIVED] only.
 */
async function casToNormalizeFailed(
  deps: MailShadowBridgeDeps,
  companyId: string,
  envelopeId: string,
  ctx: MailShadowBridgeContext,
  durationMs: number,
  errorCode: string
): Promise<void> {
  try {
    await deps.envelopeRepo.transitionLifecycle({
      companyId,
      envelopeId,
      expectedStatuses: [ENVELOPE_LIFECYCLE_STATUSES.RECEIVED],
      targetStatus: ENVELOPE_LIFECYCLE_STATUSES.NORMALIZE_FAILED,
    })
    ctx.stats.normalizeFailed++
    logMailShadow("warn", "mail_shadow_normalize_failed", {
      companyId,
      envelopeId,
      outcome: "normalize_failed",
      errorCode,
      durationMs,
    })
  } catch (error) {
    if (error instanceof IntegrationInboundLifecycleConflictError) {
      // Succès concurrent possible — ne jamais forcer FAILED
      await reconcileAfterConflict(deps, companyId, envelopeId, ctx, durationMs)
      return
    }
    throw error
  }
}

async function ensureNormalizedAndCas(
  deps: MailShadowBridgeDeps,
  dto: MailShadowInputDto,
  envelope: InboundEnvelope,
  ctx: MailShadowBridgeContext,
  durationStarted: number,
  isNewEnvelope: boolean
): Promise<void> {
  const durationMs = () => Date.now() - durationStarted
  const existing = await findNormalizedV1(
    deps.normalizedRepo,
    dto.companyId,
    envelope.id
  )

  if (existing) {
    // État B : RECEIVED + Normalized → CAS NORMALIZED seulement
    await casToNormalized(deps, dto.companyId, envelope.id, ctx, durationMs())
    return
  }

  // État A : RECEIVED sans Normalized
  const normalizedResult = normalizeMessageFamily(dto)
  if (!normalizedResult.ok) {
    await casToNormalizeFailed(
      deps,
      dto.companyId,
      envelope.id,
      ctx,
      durationMs(),
      normalizedResult.errorCode
    )
    return
  }

  try {
    await deps.normalizedRepo.create({
      companyId: dto.companyId,
      connectionId: envelope.connectionId,
      envelopeId: envelope.id,
      family: INBOUND_FAMILY.MESSAGE,
      occurredAt: dto.occurredAt,
      receivedAt: dto.receivedAt,
      normalizedHash: normalizedResult.normalizedHash,
      artifactRefs: [],
      schemaVersion: PLATFORM_SCHEMA_VERSION_V1,
      message: normalizedResult.message,
    })
    if (isNewEnvelope) ctx.stats.received++
    await casToNormalized(deps, dto.companyId, envelope.id, ctx, durationMs())
  } catch (error) {
    if (error instanceof IntegrationInboundNormalizedVersionConflictError) {
      // État F : conflit version — relire, converger, jamais FAILED si succès
      await reconcileAfterConflict(
        deps,
        dto.companyId,
        envelope.id,
        ctx,
        durationMs()
      )
      return
    }
    // Échec create autre — tenter FAILED uniquement depuis RECEIVED
    await casToNormalizeFailed(
      deps,
      dto.companyId,
      envelope.id,
      ctx,
      durationMs(),
      isIntegrationInboundError(error) ? error.code : "normalized_create_failed"
    )
  }
}

function isConnectionEligible(connection: {
  status: string
  secretBackend: string
  connectorType: string
}): boolean {
  return (
    connection.status === CONNECTION_STATUSES.ACTIVE &&
    connection.secretBackend === SECRET_BACKENDS.LEGACY_GMAIL &&
    connection.connectorType === MAIL_SHADOW_CONNECTOR_TYPE
  )
}

export class MailShadowBridgeService implements MailShadowBridgePort {
  private readonly deps: MailShadowBridgeDeps

  constructor(
    db: PrismaClient = prisma,
    deps?: Partial<MailShadowBridgeDeps>
  ) {
    const base = defaultDeps(db)
    this.deps = {
      envelopeRepo: deps?.envelopeRepo ?? base.envelopeRepo,
      normalizedRepo: deps?.normalizedRepo ?? base.normalizedRepo,
      connectionRepo: deps?.connectionRepo ?? base.connectionRepo,
    }
  }

  async project(input: unknown, ctx: MailShadowBridgeContext): Promise<void> {
    const started = Date.now()
    ctx.stats.admitted++

    let dto: MailShadowInputDto
    try {
      dto = parseMailShadowInputDto(input)
    } catch (error) {
      ctx.stats.shadowErrors++
      logMailShadowError(
        "mail_shadow_dto_invalid",
        { outcome: "dto_invalid", errorCode: "VALIDATION", durationMs: Date.now() - started },
        error
      )
      return
    }

    let connection
    try {
      connection = await this.deps.connectionRepo.findById(
        dto.companyId,
        dto.connectionId
      )
    } catch (error) {
      if (error instanceof IntegrationConnectionNotFoundError) {
        logMailShadow("warn", "mail_shadow_connection_not_eligible", {
          companyId: dto.companyId,
          connectionId: dto.connectionId,
          outcome: "connection_missing",
          errorCode: "NOT_FOUND",
          durationMs: Date.now() - started,
        })
        return
      }
      ctx.stats.shadowErrors++
      logMailShadowError(
        "mail_shadow_connection_lookup_failed",
        {
          companyId: dto.companyId,
          connectionId: dto.connectionId,
          durationMs: Date.now() - started,
        },
        error
      )
      return
    }

    if (!isConnectionEligible(connection)) {
      logMailShadow("warn", "mail_shadow_connection_not_eligible", {
        companyId: dto.companyId,
        connectionId: dto.connectionId,
        connectorType: connection.connectorType,
        outcome: "connection_missing",
        errorCode: "NOT_ELIGIBLE",
        durationMs: Date.now() - started,
      })
      return
    }

    if (
      dto.connectorTypeHint !== undefined &&
      dto.connectorTypeHint !== connection.connectorType
    ) {
      ctx.stats.shadowErrors++
      logMailShadow("warn", "mail_shadow_connector_type_mismatch", {
        companyId: dto.companyId,
        connectionId: dto.connectionId,
        outcome: "validation",
        errorCode: "VALIDATION",
        durationMs: Date.now() - started,
      })
      return
    }

    let envelope: InboundEnvelope
    let isNew = false
    try {
      const before = await this.deps.envelopeRepo
        .findByIdempotencyKey(
          dto.companyId,
          dto.connectionId,
          dto.idempotencyKey
        )
        .catch(() => null)

      envelope = await this.deps.envelopeRepo.createIdempotent({
        companyId: dto.companyId,
        connectionId: dto.connectionId,
        connectorType: connection.connectorType,
        externalId: dto.externalId,
        idempotencyKey: dto.idempotencyKey,
        receivedAt: dto.receivedAt,
        payloadRef: dto.payloadRef,
        contentType: dto.contentType,
        schemaVersion: dto.schemaVersion,
        rawPayloadHash: dto.rawPayloadHash,
      })
      isNew = before === null
    } catch (error) {
      ctx.stats.shadowErrors++
      logMailShadowError(
        "mail_shadow_envelope_failed",
        {
          companyId: dto.companyId,
          connectionId: dto.connectionId,
          durationMs: Date.now() - started,
          errorCode: isIntegrationInboundError(error) ? error.code : "PERSISTENCE",
        },
        error
      )
      return
    }

    const normalized = await findNormalizedV1(
      this.deps.normalizedRepo,
      dto.companyId,
      envelope.id
    )
    const durationMs = Date.now() - started

    // --- Matrice de convergence ---
    const life = envelope.lifecycleStatus

    if (life === ENVELOPE_LIFECYCLE_STATUSES.NORMALIZE_FAILED) {
      // État E
      ctx.stats.normalizeFailed++
      logMailShadow("info", "mail_shadow_already_failed", {
        companyId: dto.companyId,
        envelopeId: envelope.id,
        outcome: "normalize_failed",
        durationMs,
      })
      return
    }

    if (life === ENVELOPE_LIFECYCLE_STATUSES.NORMALIZED) {
      if (normalized) {
        // État C
        ctx.stats.duplicate++
        logMailShadow("info", "mail_shadow_duplicate", {
          companyId: dto.companyId,
          envelopeId: envelope.id,
          outcome: "duplicate",
          durationMs,
        })
        return
      }
      // État D — anomalie
      ctx.stats.inconsistent++
      logMailShadow("error", "mail_shadow_inconsistent_normalized_state", {
        companyId: dto.companyId,
        envelopeId: envelope.id,
        outcome: "inconsistent",
        errorCode: "inconsistent_normalized_state",
        durationMs,
      })
      return
    }

    if (life === ENVELOPE_LIFECYCLE_STATUSES.RECEIVED) {
      try {
        await ensureNormalizedAndCas(
          this.deps,
          dto,
          envelope,
          ctx,
          started,
          isNew
        )
      } catch (error) {
        ctx.stats.shadowErrors++
        logMailShadowError(
          "mail_shadow_project_failed",
          {
            companyId: dto.companyId,
            envelopeId: envelope.id,
            durationMs: Date.now() - started,
          },
          error
        )
      }
      return
    }

    // Lifecycle inattendu
    ctx.stats.unexpectedLifecycle++
    logMailShadow("warn", "mail_shadow_unexpected_lifecycle", {
      companyId: dto.companyId,
      envelopeId: envelope.id,
      outcome: "unexpected_lifecycle",
      errorCode: life,
      durationMs,
    })
  }
}
