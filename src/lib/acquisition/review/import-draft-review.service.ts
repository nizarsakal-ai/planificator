/**
 * PLAN-ACQ-005C-MVP — Autorité save / approve / reject (pas d’extraction).
 */

import type { Prisma, PrismaClient, Role, WorksiteImportDraftStatus } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import { isAcquisitionEnabled } from "@/lib/acquisition/acquisition-feature-flag"
import type { TransactionalOwnershipFence } from "@/lib/acquisition/conversion/conversion-ownership-fence.port"
import {
  approveImportDraftSchema,
  rejectImportDraftSchema,
  saveImportDraftCorrectionsSchema,
  type ApproveImportDraftInput,
  type RejectImportDraftInput,
  type SaveImportDraftCorrectionsInput,
} from "@/lib/acquisition/review/import-draft-review.schema"
import type {
  ApproveOutcome,
  RejectOutcome,
  ReviewActorContext,
  SaveCorrectionsOutcome,
} from "@/lib/acquisition/review/import-draft-review.types"
import { hasBlockingWarnings } from "@/lib/acquisition/review/consultation-ui"

const LOG_PREFIX = "[acquisition-review]"
const ALLOWED_ROLES = new Set<Role>(["ADMIN", "SUPER_ADMIN"])
const EDITABLE_STATUSES: WorksiteImportDraftStatus[] = ["PENDING_REVIEW", "FAILED"]

export type ReviewMutationOptions = {
  transactionalOwnershipFence?: TransactionalOwnershipFence
}

class ReviewLeaseNotOwnedError extends Error {
  readonly code = "LEASE_NOT_OWNED"
  constructor() {
    super("LEASE_NOT_OWNED")
  }
}

type ReviewDb = PrismaClient | Prisma.TransactionClient

function defaultLog(event: string, payload?: Record<string, unknown>): void {
  if (payload) console.log(`${LOG_PREFIX} ${event}`, payload)
  else console.log(`${LOG_PREFIX} ${event}`)
}

function parseDayUtc(ymd: string): Date {
  return new Date(`${ymd}T00:00:00.000Z`)
}

function toYmd(d: Date): string {
  return d.toISOString().slice(0, 10)
}

export type ImportDraftReviewServiceDeps = {
  db?: PrismaClient
  log?: (event: string, payload?: Record<string, unknown>) => void
  now?: () => Date
}

function authorize(
  ctx: ReviewActorContext
): { ok: true } | { ok: false; outcome: "FORBIDDEN"; code: string; message: string } {
  if (!ctx.companyId || !ctx.actorUserId) {
    return {
      ok: false,
      outcome: "FORBIDDEN",
      code: "REVIEW_FORBIDDEN",
      message: "Accès refusé",
    }
  }
  if (ctx.actorRole === "SYSTEM") return { ok: true }
  if (!ALLOWED_ROLES.has(ctx.actorRole)) {
    return {
      ok: false,
      outcome: "FORBIDDEN",
      code: "REVIEW_FORBIDDEN",
      message: "Accès refusé",
    }
  }
  return { ok: true }
}

function disabled(): SaveCorrectionsOutcome & ApproveOutcome & RejectOutcome {
  return {
    ok: false,
    outcome: "DISABLED",
    code: "ACQUISITION_DISABLED",
    message: "Acquisition désactivée",
  }
}

async function resolveUpdateMiss(
  db: ReviewDb,
  companyId: string,
  draftId: string,
  expectedVersion: number,
  allowedStatuses: WorksiteImportDraftStatus[]
): Promise<"NOT_FOUND" | "INVALID_STATE" | "STATE_CHANGED"> {
  const row = await db.worksiteImportDraft.findFirst({
    where: { id: draftId, companyId },
    select: { status: true, version: true },
  })
  if (!row) return "NOT_FOUND"
  if (!allowedStatuses.includes(row.status)) return "INVALID_STATE"
  if (row.version !== expectedVersion) return "STATE_CHANGED"
  return "STATE_CHANGED"
}

function leaseNotOwnedApprove(): ApproveOutcome {
  return {
    ok: false,
    outcome: "LEASE_NOT_OWNED",
    code: "LEASE_NOT_OWNED",
    message: "Ownership orchestrateur perdu",
  }
}

function leaseNotOwnedReject(): RejectOutcome {
  return {
    ok: false,
    outcome: "LEASE_NOT_OWNED",
    code: "LEASE_NOT_OWNED",
    message: "Ownership orchestrateur perdu",
  }
}

export class ImportDraftReviewService {
  private readonly db: PrismaClient
  private readonly log: (event: string, payload?: Record<string, unknown>) => void
  private readonly now: () => Date

  constructor(deps: ImportDraftReviewServiceDeps = {}) {
    this.db = deps.db ?? prisma
    this.log = deps.log ?? defaultLog
    this.now = deps.now ?? (() => new Date())
  }

  async saveImportDraftCorrections(
    ctx: ReviewActorContext,
    raw: unknown
  ): Promise<SaveCorrectionsOutcome> {
    const authz = authorize(ctx)
    if (!authz.ok) return authz
    if (!isAcquisitionEnabled()) return disabled()

    const parsed = saveImportDraftCorrectionsSchema.safeParse(raw)
    if (!parsed.success) {
      return {
        ok: false,
        outcome: "VALIDATION_ERROR",
        code: "VALIDATION_ERROR",
        message: "Données de correction invalides",
      }
    }
    const input: SaveImportDraftCorrectionsInput = parsed.data

    const result = await this.db.worksiteImportDraft.updateMany({
      where: {
        id: input.draftId,
        companyId: ctx.companyId,
        version: input.expectedVersion,
        status: { in: EDITABLE_STATUSES },
      },
      data: {
        proposedWorksiteName: input.proposedWorksiteName,
        proposedClientName: input.proposedClientName,
        proposedAddress: input.proposedAddress,
        proposedPostalCode: input.proposedPostalCode,
        proposedCity: input.proposedCity,
        proposedStartDate: input.proposedStartDate
          ? parseDayUtc(input.proposedStartDate)
          : null,
        proposedEndDate: input.proposedEndDate ? parseDayUtc(input.proposedEndDate) : null,
        proposedDescription: input.proposedDescription,
        version: { increment: 1 },
      },
    })

    if (result.count === 0) {
      const miss = await resolveUpdateMiss(
        this.db,
        ctx.companyId,
        input.draftId,
        input.expectedVersion,
        EDITABLE_STATUSES
      )
      this.log("SAVE_FAILED", {
        companyId: ctx.companyId,
        draftId: input.draftId,
        outcome: miss,
        actorUserId: ctx.actorUserId,
      })
      return {
        ok: false,
        outcome: miss,
        code: miss,
        message:
          miss === "NOT_FOUND"
            ? "Consultation introuvable"
            : miss === "INVALID_STATE"
              ? "Statut non éditable"
              : "Version obsolète",
      }
    }

    const updated = await this.db.worksiteImportDraft.findFirst({
      where: { id: input.draftId, companyId: ctx.companyId },
      select: { version: true, status: true },
    })

    this.log("SAVE_OK", {
      companyId: ctx.companyId,
      draftId: input.draftId,
      outcome: "SAVED",
      actorUserId: ctx.actorUserId,
      status: updated?.status,
    })

    return {
      ok: true,
      outcome: "SAVED",
      draftId: input.draftId,
      version: updated?.version ?? input.expectedVersion + 1,
      status: updated?.status ?? "PENDING_REVIEW",
    }
  }

  async approveImportDraft(
    ctx: ReviewActorContext,
    raw: unknown,
    options?: ReviewMutationOptions
  ): Promise<ApproveOutcome> {
    const authz = authorize(ctx)
    if (!authz.ok) return authz
    if (!isAcquisitionEnabled()) return disabled()

    const parsed = approveImportDraftSchema.safeParse(raw)
    if (!parsed.success) {
      return {
        ok: false,
        outcome: "VALIDATION_ERROR",
        code: "VALIDATION_ERROR",
        message: "Données d’approbation invalides",
      }
    }
    const input: ApproveImportDraftInput = parsed.data
    const fence = options?.transactionalOwnershipFence

    // LOT-3G — SYSTEM sans fence : fail-closed avant tout accès DB.
    if (ctx.actorRole === "SYSTEM" && !fence) {
      this.log("APPROVE_LEASE_NOT_OWNED", {
        companyId: ctx.companyId,
        draftId: input.draftId,
        actorUserId: ctx.actorUserId,
        code: "LEASE_NOT_OWNED",
      })
      return leaseNotOwnedApprove()
    }

    if (fence) {
      try {
        return await this.db.$transaction(async (tx) => {
          const owned = await fence.assertOwnedAndLock(tx)
          if (owned !== "OWNED") throw new ReviewLeaseNotOwnedError()
          return this.executeApprove(tx, ctx, input)
        })
      } catch (err) {
        if (err instanceof ReviewLeaseNotOwnedError) {
          this.log("APPROVE_LEASE_NOT_OWNED", {
            companyId: ctx.companyId,
            draftId: input.draftId,
            actorUserId: ctx.actorUserId,
            code: "LEASE_NOT_OWNED",
          })
          return leaseNotOwnedApprove()
        }
        throw err
      }
    }

    return this.executeApprove(this.db, ctx, input)
  }

  private async executeApprove(
    db: ReviewDb,
    ctx: ReviewActorContext,
    input: ApproveImportDraftInput
  ): Promise<ApproveOutcome> {
    const draft = await db.worksiteImportDraft.findFirst({
      where: { id: input.draftId, companyId: ctx.companyId },
      select: {
        status: true,
        version: true,
        proposedWorksiteName: true,
        proposedStartDate: true,
        proposedEndDate: true,
        warningData: true,
      },
    })

    if (!draft) {
      return {
        ok: false,
        outcome: "NOT_FOUND",
        code: "NOT_FOUND",
        message: "Consultation introuvable",
      }
    }
    if (draft.status !== "PENDING_REVIEW") {
      return {
        ok: false,
        outcome: "INVALID_STATE",
        code: "INVALID_STATE",
        message: "Seules les consultations à revoir peuvent être approuvées",
      }
    }
    if (draft.version !== input.expectedVersion) {
      return {
        ok: false,
        outcome: "STATE_CHANGED",
        code: "STATE_CHANGED",
        message: "Version obsolète",
      }
    }

    const name = draft.proposedWorksiteName?.trim() ?? ""
    if (!name) {
      return {
        ok: false,
        outcome: "VALIDATION_ERROR",
        code: "MISSING_WORKSITE_NAME",
        message: "Le nom du chantier est obligatoire",
      }
    }
    // PROVIDENCE-DATES-002 — null/null admissible ; partielle / inversée refusée.
    const hasStart = draft.proposedStartDate != null
    const hasEnd = draft.proposedEndDate != null
    if (hasStart !== hasEnd) {
      return {
        ok: false,
        outcome: "VALIDATION_ERROR",
        code: "MISSING_DATES",
        message: "Les dates de début et de fin doivent être toutes deux renseignées ou toutes deux absentes",
      }
    }
    if (
      hasStart &&
      hasEnd &&
      toYmd(draft.proposedStartDate!) > toYmd(draft.proposedEndDate!)
    ) {
      return {
        ok: false,
        outcome: "VALIDATION_ERROR",
        code: "DATE_RANGE_INVALID",
        message: "La date de fin doit être postérieure ou égale au début",
      }
    }
    if (hasBlockingWarnings(draft.warningData)) {
      return {
        ok: false,
        outcome: "BLOCKING_WARNINGS",
        code: "BLOCKING_WARNINGS",
        message: "Des avertissements bloquants empêchent l’approbation",
      }
    }

    const now = this.now()
    const updated = await db.worksiteImportDraft.updateMany({
      where: {
        id: input.draftId,
        companyId: ctx.companyId,
        status: "PENDING_REVIEW",
        version: input.expectedVersion,
      },
      data: {
        status: "APPROVED",
        reviewedByUserId: ctx.actorUserId,
        reviewedAt: now,
        rejectionReason: null,
        version: { increment: 1 },
      },
    })

    if (updated.count === 0) {
      const miss = await resolveUpdateMiss(
        db,
        ctx.companyId,
        input.draftId,
        input.expectedVersion,
        ["PENDING_REVIEW"]
      )
      this.log("APPROVE_FAILED", {
        companyId: ctx.companyId,
        draftId: input.draftId,
        outcome: miss,
        actorUserId: ctx.actorUserId,
      })
      return {
        ok: false,
        outcome:
          miss === "NOT_FOUND"
            ? "NOT_FOUND"
            : miss === "INVALID_STATE"
              ? "INVALID_STATE"
              : "STATE_CHANGED",
        code: miss,
        message: "Approbation concurrente échouée",
      }
    }

    const row = await db.worksiteImportDraft.findFirst({
      where: { id: input.draftId, companyId: ctx.companyId },
      select: { version: true },
    })

    this.log("APPROVE_OK", {
      companyId: ctx.companyId,
      draftId: input.draftId,
      outcome: "APPROVED",
      actorUserId: ctx.actorUserId,
    })

    return {
      ok: true,
      outcome: "APPROVED",
      draftId: input.draftId,
      version: row?.version ?? input.expectedVersion + 1,
    }
  }

  async rejectImportDraft(
    ctx: ReviewActorContext,
    raw: unknown,
    options?: ReviewMutationOptions
  ): Promise<RejectOutcome> {
    const authz = authorize(ctx)
    if (!authz.ok) return authz
    if (!isAcquisitionEnabled()) return disabled()

    const parsed = rejectImportDraftSchema.safeParse(raw)
    if (!parsed.success) {
      return {
        ok: false,
        outcome: "VALIDATION_ERROR",
        code: "VALIDATION_ERROR",
        message: "Motif de rejet invalide (5 à 500 caractères)",
      }
    }
    const input: RejectImportDraftInput = parsed.data
    const fence = options?.transactionalOwnershipFence

    if (ctx.actorRole === "SYSTEM" && !fence) {
      this.log("REJECT_LEASE_NOT_OWNED", {
        companyId: ctx.companyId,
        draftId: input.draftId,
        actorUserId: ctx.actorUserId,
        code: "LEASE_NOT_OWNED",
      })
      return leaseNotOwnedReject()
    }

    if (fence) {
      try {
        return await this.db.$transaction(async (tx) => {
          const owned = await fence.assertOwnedAndLock(tx)
          if (owned !== "OWNED") throw new ReviewLeaseNotOwnedError()
          return this.executeReject(tx, ctx, input)
        })
      } catch (err) {
        if (err instanceof ReviewLeaseNotOwnedError) {
          this.log("REJECT_LEASE_NOT_OWNED", {
            companyId: ctx.companyId,
            draftId: input.draftId,
            actorUserId: ctx.actorUserId,
            code: "LEASE_NOT_OWNED",
          })
          return leaseNotOwnedReject()
        }
        throw err
      }
    }

    return this.executeReject(this.db, ctx, input)
  }

  private async executeReject(
    db: ReviewDb,
    ctx: ReviewActorContext,
    input: RejectImportDraftInput
  ): Promise<RejectOutcome> {
    const draft = await db.worksiteImportDraft.findFirst({
      where: { id: input.draftId, companyId: ctx.companyId },
      select: { status: true, version: true },
    })
    if (!draft) {
      return {
        ok: false,
        outcome: "NOT_FOUND",
        code: "NOT_FOUND",
        message: "Consultation introuvable",
      }
    }
    if (draft.status !== "PENDING_REVIEW") {
      return {
        ok: false,
        outcome: "INVALID_STATE",
        code: "INVALID_STATE",
        message: "Seules les consultations à revoir peuvent être rejetées",
      }
    }
    if (draft.version !== input.expectedVersion) {
      return {
        ok: false,
        outcome: "STATE_CHANGED",
        code: "STATE_CHANGED",
        message: "Version obsolète",
      }
    }

    const now = this.now()
    const updated = await db.worksiteImportDraft.updateMany({
      where: {
        id: input.draftId,
        companyId: ctx.companyId,
        status: "PENDING_REVIEW",
        version: input.expectedVersion,
      },
      data: {
        status: "REJECTED",
        reviewedByUserId: ctx.actorUserId,
        reviewedAt: now,
        rejectionReason: input.rejectionReason,
        version: { increment: 1 },
      },
    })

    if (updated.count === 0) {
      const miss = await resolveUpdateMiss(
        db,
        ctx.companyId,
        input.draftId,
        input.expectedVersion,
        ["PENDING_REVIEW"]
      )
      this.log("REJECT_FAILED", {
        companyId: ctx.companyId,
        draftId: input.draftId,
        outcome: miss,
        actorUserId: ctx.actorUserId,
      })
      return {
        ok: false,
        outcome:
          miss === "NOT_FOUND"
            ? "NOT_FOUND"
            : miss === "INVALID_STATE"
              ? "INVALID_STATE"
              : "STATE_CHANGED",
        code: miss,
        message: "Rejet concurrent échoué",
      }
    }

    const row = await db.worksiteImportDraft.findFirst({
      where: { id: input.draftId, companyId: ctx.companyId },
      select: { version: true },
    })

    this.log("REJECT_OK", {
      companyId: ctx.companyId,
      draftId: input.draftId,
      outcome: "REJECTED",
      actorUserId: ctx.actorUserId,
    })

    return {
      ok: true,
      outcome: "REJECTED",
      draftId: input.draftId,
      version: row?.version ?? input.expectedVersion + 1,
    }
  }
}

export const importDraftReviewService = new ImportDraftReviewService()
