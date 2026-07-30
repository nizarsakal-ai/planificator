/**
 * PLAN-ACQ-005D — Autorité conversion APPROVED → Client/Worksite/Documents → CONVERTED.
 * Une seule transaction interactive. Pas de Gmail / IA / Cloudinary write.
 * Géocodage Nominatim : post-conversion hors TX (Lot G), non bloquant.
 */

import type {
  AcquisitionAttachmentCategory,
  DocumentType,
  PrismaClient,
  Role,
} from "@prisma/client"
import { prisma } from "@/lib/prisma"
import { isAcquisitionConversionFullyEnabled } from "@/lib/acquisition/conversion/conversion-feature-flag"
import {
  convertImportDraftSchema,
  type ConvertImportDraftInput,
} from "@/lib/acquisition/conversion/conversion.schema"
import {
  ConversionClaimConflictError,
  type ConversionActorContext,
  type ConvertImportDraftFailure,
  type ConvertImportDraftResult,
} from "@/lib/acquisition/conversion/conversion.types"
import { defaultGeocodePort, type GeocodePort } from "@/lib/geo/geocode.port"
import {
  findDuplicateWorksite,
  normalizeAddressKey,
} from "@/lib/acquisition/matching/client-match.service"

const LOG_PREFIX = "[acquisition-conversion]"
const ALLOWED_ROLES = new Set<Role>(["ADMIN", "SUPER_ADMIN"])

function defaultLog(event: string, payload?: Record<string, unknown>): void {
  if (payload) console.log(`${LOG_PREFIX} ${event}`, payload)
  else console.log(`${LOG_PREFIX} ${event}`)
}

export type ImportDraftConversionServiceDeps = {
  db?: PrismaClient
  log?: (event: string, payload?: Record<string, unknown>) => void
  geocode?: GeocodePort
}

function authorize(
  ctx: ConversionActorContext
): { ok: true } | { ok: false; outcome: "FORBIDDEN"; code: string; message: string } {
  if (!ctx.companyId || !ctx.actorUserId) {
    return { ok: false, outcome: "FORBIDDEN", code: "CONVERSION_FORBIDDEN", message: "Accès refusé" }
  }
  if (ctx.actorRole === "SYSTEM") return { ok: true }
  if (!ALLOWED_ROLES.has(ctx.actorRole)) {
    return { ok: false, outcome: "FORBIDDEN", code: "CONVERSION_FORBIDDEN", message: "Accès refusé" }
  }
  return { ok: true }
}

function fail(
  outcome: ConvertImportDraftFailure["outcome"],
  code: string,
  message: string
): ConvertImportDraftResult {
  return { ok: false, outcome, code, message }
}

export function buildWorksiteAddress(draft: {
  proposedAddress: string | null
  proposedPostalCode: string | null
  proposedCity: string | null
}): string | null {
  const parts = [draft.proposedAddress, draft.proposedPostalCode, draft.proposedCity]
    .map((p) => (typeof p === "string" ? p.trim() : ""))
    .filter(Boolean)
  if (parts.length === 0) return null
  return parts.join(", ")
}

export function mapAttachmentCategoryToDocumentType(
  category: AcquisitionAttachmentCategory
): DocumentType {
  if (category === "PLAN") return "PLAN"
  if (category === "PHOTO") return "PHOTO"
  return "DOCUMENT"
}

async function resolveAlreadyConverted(
  db: PrismaClient,
  companyId: string,
  draftId: string
): Promise<ConvertImportDraftResult> {
  const row = await db.worksiteImportDraft.findFirst({
    where: { id: draftId, companyId },
    select: {
      status: true,
      createdWorksiteId: true,
      createdWorksite: { select: { id: true, clientId: true } },
    },
  })
  if (row?.status === "CONVERTED" && row.createdWorksiteId && row.createdWorksite) {
    const documentCount = await db.document.count({
      where: { worksiteId: row.createdWorksiteId },
    })
    return {
      ok: true,
      outcome: "ALREADY_CONVERTED",
      worksiteId: row.createdWorksite.id,
      clientId: row.createdWorksite.clientId,
      clientCreated: false,
      documentCount,
      skippedAttachmentCount: 0,
    }
  }
  return fail("STATE_CHANGED", "STATE_CHANGED", "Version ou statut obsolète")
}

export class ImportDraftConversionService {
  private readonly db: PrismaClient
  private readonly log: (event: string, payload?: Record<string, unknown>) => void
  private readonly geocode: GeocodePort

  constructor(deps: ImportDraftConversionServiceDeps = {}) {
    this.db = deps.db ?? prisma
    this.log = deps.log ?? defaultLog
    this.geocode = deps.geocode ?? defaultGeocodePort
  }

  async convertImportDraft(
    ctx: ConversionActorContext,
    raw: unknown
  ): Promise<ConvertImportDraftResult> {
    const authz = authorize(ctx)
    if (!authz.ok) return authz
    if (!isAcquisitionConversionFullyEnabled()) {
      return fail("DISABLED", "CONVERSION_DISABLED", "Conversion désactivée")
    }

    const parsed = convertImportDraftSchema.safeParse(raw)
    if (!parsed.success) {
      return fail("VALIDATION_ERROR", "VALIDATION_ERROR", "Données de conversion invalides")
    }
    const input: ConvertImportDraftInput = parsed.data

    // Idempotence rapide hors tx
    const early = await this.db.worksiteImportDraft.findFirst({
      where: { id: input.draftId, companyId: ctx.companyId },
      select: {
        status: true,
        createdWorksiteId: true,
        createdWorksite: { select: { id: true, clientId: true } },
      },
    })
    if (!early) {
      return fail("NOT_FOUND", "NOT_FOUND", "Consultation introuvable")
    }
    if (early.status === "CONVERTED" && early.createdWorksiteId && early.createdWorksite) {
      const documentCount = await this.db.document.count({
        where: { worksiteId: early.createdWorksiteId },
      })
      return {
        ok: true,
        outcome: "ALREADY_CONVERTED",
        worksiteId: early.createdWorksite.id,
        clientId: early.createdWorksite.clientId,
        clientCreated: false,
        documentCount,
        skippedAttachmentCount: 0,
      }
    }
    if (early.status !== "APPROVED") {
      return fail(
        "INVALID_STATE",
        "INVALID_STATE",
        "Seules les consultations approuvées peuvent être converties"
      )
    }

    try {
      const result = await this.db.$transaction(async (tx) => {
        const draft = await tx.worksiteImportDraft.findFirst({
          where: { id: input.draftId, companyId: ctx.companyId },
          select: {
            id: true,
            status: true,
            version: true,
            acquisitionMessageId: true,
            proposedWorksiteName: true,
            proposedDescription: true,
            proposedAddress: true,
            proposedPostalCode: true,
            proposedCity: true,
            proposedStartDate: true,
            proposedEndDate: true,
          },
        })

        if (!draft) {
          throw Object.assign(new Error("NOT_FOUND"), { code: "NOT_FOUND" })
        }
        if (draft.status !== "APPROVED") {
          throw Object.assign(new Error("INVALID_STATE"), { code: "INVALID_STATE" })
        }
        if (draft.version !== input.expectedVersion) {
          throw new ConversionClaimConflictError()
        }

        const name = draft.proposedWorksiteName?.trim() ?? ""
        if (!name) {
          throw Object.assign(new Error("MISSING_WORKSITE_NAME"), {
            code: "VALIDATION_ERROR",
          })
        }
        if (name.length > 100) {
          throw Object.assign(new Error("WORKSITE_NAME_TOO_LONG"), {
            code: "VALIDATION_ERROR",
          })
        }
        if (!draft.proposedStartDate || !draft.proposedEndDate) {
          throw Object.assign(new Error("MISSING_DATES"), { code: "VALIDATION_ERROR" })
        }
        if (draft.proposedStartDate > draft.proposedEndDate) {
          throw Object.assign(new Error("DATE_RANGE_INVALID"), { code: "VALIDATION_ERROR" })
        }

        const addressKey = normalizeAddressKey({
          address: draft.proposedAddress,
          postalCode: draft.proposedPostalCode,
          city: draft.proposedCity,
        })
        const dup = await findDuplicateWorksite({
          companyId: ctx.companyId,
          addressKey,
          postalCode: draft.proposedPostalCode,
          db: tx,
        })
        if (dup.worksiteId) {
          if (ctx.actorRole === "SYSTEM" || !input.acknowledgeDuplicateWorksite) {
            throw Object.assign(new Error("DUPLICATE_REQUIRES_ACK"), {
              code: "DUPLICATE_REQUIRES_ACK",
              existingWorksiteId: dup.worksiteId,
            })
          }
          this.log("DUPLICATE_WORKSITE_ACKNOWLEDGED", {
            companyId: ctx.companyId,
            draftId: input.draftId,
            existingWorksiteId: dup.worksiteId,
            actorUserId: ctx.actorUserId,
          })
        }

        let clientId: string
        let clientCreated = false

        if (input.clientMode === "EXISTING") {
          const client = await tx.client.findFirst({
            where: { id: input.existingClientId!, companyId: ctx.companyId },
            select: { id: true },
          })
          if (!client) {
            throw Object.assign(new Error("CLIENT_NOT_FOUND"), { code: "CLIENT_NOT_FOUND" })
          }
          clientId = client.id
        } else {
          const created = await tx.client.create({
            data: {
              name: input.newClient!.name,
              email: input.newClient!.email,
              phone: input.newClient!.phone,
              address: input.newClient!.address,
              companyId: ctx.companyId,
            },
            select: { id: true },
          })
          clientId = created.id
          clientCreated = true
        }

        const worksite = await tx.worksite.create({
          data: {
            name,
            description: draft.proposedDescription,
            address: buildWorksiteAddress(draft),
            startDate: draft.proposedStartDate,
            endDate: draft.proposedEndDate,
            dailyHours: 10,
            status: "PLANNED",
            clientId,
            companyId: ctx.companyId,
            createdById: ctx.actorUserId,
            latitude: null,
            longitude: null,
          },
          select: { id: true },
        })

        const attachments = await tx.acquisitionAttachment.findMany({
          where: {
            companyId: ctx.companyId,
            acquisitionMessageId: draft.acquisitionMessageId,
          },
          select: {
            id: true,
            filename: true,
            mimeType: true,
            sizeBytes: true,
            category: true,
            status: true,
            storagePublicId: true,
          },
        })

        let documentCount = 0
        let skippedAttachmentCount = 0
        for (const att of attachments) {
          if (att.status !== "STORED" || !att.storagePublicId) {
            skippedAttachmentCount++
            continue
          }
          await tx.document.create({
            data: {
              worksiteId: worksite.id,
              name: att.filename,
              url: null,
              size: att.sizeBytes,
              mimeType: att.mimeType,
              type: mapAttachmentCategoryToDocumentType(att.category),
              storagePublicId: att.storagePublicId,
              sourceAcquisitionAttachmentId: att.id,
            },
          })
          documentCount++
        }

        const claimed = await tx.worksiteImportDraft.updateMany({
          where: {
            id: input.draftId,
            companyId: ctx.companyId,
            status: "APPROVED",
            version: input.expectedVersion,
          },
          data: {
            status: "CONVERTED",
            createdWorksiteId: worksite.id,
            version: { increment: 1 },
          },
        })

        if (claimed.count !== 1) {
          throw new ConversionClaimConflictError()
        }

        return {
          ok: true as const,
          outcome: "CONVERTED" as const,
          worksiteId: worksite.id,
          clientId,
          clientCreated,
          documentCount,
          skippedAttachmentCount,
        }
      })

      this.log("CONVERT_OK", {
        companyId: ctx.companyId,
        draftId: input.draftId,
        outcome: result.outcome,
        actorUserId: ctx.actorUserId,
        worksiteId: result.worksiteId,
        documentCount: result.documentCount,
        skippedAttachmentCount: result.skippedAttachmentCount,
      })

      // Lot G — géocodage post-conversion (hors TX, non bloquant).
      if (result.outcome === "CONVERTED") {
        void this.applyGeocodeAfterConvert(ctx.companyId, result.worksiteId)
      }

      return result
    } catch (err) {
      if (err instanceof ConversionClaimConflictError) {
        const remapped = await resolveAlreadyConverted(this.db, ctx.companyId, input.draftId)
        this.log("CONVERT_CONFLICT", {
          companyId: ctx.companyId,
          draftId: input.draftId,
          outcome: remapped.ok ? remapped.outcome : remapped.outcome,
          actorUserId: ctx.actorUserId,
        })
        return remapped
      }
      const code =
        err && typeof err === "object" && "code" in err
          ? String((err as { code: unknown }).code)
          : ""
      if (code === "NOT_FOUND") {
        return fail("NOT_FOUND", "NOT_FOUND", "Consultation introuvable")
      }
      if (code === "INVALID_STATE") {
        return fail(
          "INVALID_STATE",
          "INVALID_STATE",
          "Seules les consultations approuvées peuvent être converties"
        )
      }
      if (code === "CLIENT_NOT_FOUND") {
        return fail("CLIENT_NOT_FOUND", "CLIENT_NOT_FOUND", "Client introuvable")
      }
      if (code === "DUPLICATE_REQUIRES_ACK") {
        const existingWorksiteId =
          err && typeof err === "object" && "existingWorksiteId" in err
            ? String((err as { existingWorksiteId: unknown }).existingWorksiteId)
            : undefined
        return {
          ok: false,
          outcome: "DUPLICATE_REQUIRES_ACK",
          code: "DUPLICATE_REQUIRES_ACK",
          message:
            "Chantier probable déjà existant — confirmer acknowledgeDuplicateWorksite",
          ...(existingWorksiteId ? { existingWorksiteId } : {}),
        }
      }
      if (code === "VALIDATION_ERROR" || code === "MISSING_WORKSITE_NAME" || code === "MISSING_DATES" || code === "DATE_RANGE_INVALID") {
        return fail("VALIDATION_ERROR", code || "VALIDATION_ERROR", "Données de conversion invalides")
      }

      this.log("CONVERT_INTERNAL_ERROR", {
        companyId: ctx.companyId,
        draftId: input.draftId,
        actorUserId: ctx.actorUserId,
        code: "INTERNAL_ERROR",
      })
      return fail("INTERNAL_ERROR", "INTERNAL_ERROR", "Erreur interne de conversion")
    }
  }

  private async applyGeocodeAfterConvert(
    companyId: string,
    worksiteId: string
  ): Promise<void> {
    try {
      const worksite = await this.db.worksite.findFirst({
        where: { id: worksiteId, companyId },
        select: { id: true, address: true },
      })
      if (!worksite?.address) return
      const geo = await this.geocode.geocodeAddress(worksite.address)
      if (!geo) return
      await this.db.worksite.updateMany({
        where: { id: worksiteId, companyId },
        data: { latitude: geo.latitude, longitude: geo.longitude },
      })
      this.log("GEOCODE_OK", { companyId, worksiteId })
    } catch {
      this.log("GEOCODE_SKIPPED", { companyId, worksiteId })
    }
  }
}

export const importDraftConversionService = new ImportDraftConversionService()
