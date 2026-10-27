import { prisma } from "@/lib/prisma"
import { buildConsultationEvaluationContext } from "@/lib/acquisition/capabilities/consultation-evaluation-context"
import { importDraftConversionService } from "./conversion.service"
import type { ConversionActorContext, ConvertImportDraftResult } from "./conversion.types"

export type ApprovedDraftTransferDeps = {
  loadContext?: typeof buildConsultationEvaluationContext
  findPossibleDuplicate?: typeof prisma.worksite.findFirst
  convert?: typeof importDraftConversionService.convertImportDraft
}

/** Called only after an authenticated human approval, never from extraction or a GET. */
export async function transferApprovedDraft(
  ctx: ConversionActorContext,
  input: { draftId: string; expectedVersion: number },
  deps: ApprovedDraftTransferDeps = {}
): Promise<ConvertImportDraftResult> {
  if (ctx.actorRole !== "ADMIN" && ctx.actorRole !== "SUPER_ADMIN") {
    return { ok: false, outcome: "FORBIDDEN", code: "FORBIDDEN", message: "Validation humaine requise" }
  }
  const context = await (deps.loadContext ?? buildConsultationEvaluationContext)({ companyId: ctx.companyId, draftId: input.draftId })
  if (!context || context.draft.status !== "APPROVED" || context.draft.version !== input.expectedVersion) {
    return { ok: false, outcome: "STATE_CHANGED", code: "STATE_CHANGED", message: "Recharger la consultation avant le transfert" }
  }
  const clientId = context.clientMatch.ambiguous ? null : context.clientMatch.clientId
  if (!clientId) {
    return { ok: false, outcome: "CLIENT_NOT_FOUND", code: "CLIENT_NOT_FOUND", message: "Choisir le client donneur d’ordre pour transférer le chantier" }
  }
  let existingWorksiteId = context.duplicate.worksiteId
  // A manual worksite can have a shorter name and a more complete address.
  // Treat same client / dates / postcode as a possible duplicate, never overwrite it.
  const draft = context.draft
  if (!existingWorksiteId && draft.proposedStartDate && draft.proposedEndDate && draft.proposedPostalCode) {
    const possible = await (deps.findPossibleDuplicate ?? prisma.worksite.findFirst.bind(prisma.worksite))({
      where: { companyId: ctx.companyId, clientId, status: { in: ["PLANNED", "IN_PROGRESS", "EXTENDED"] },
        startDate: draft.proposedStartDate, endDate: draft.proposedEndDate,
        address: { contains: draft.proposedPostalCode, mode: "insensitive" } },
      select: { id: true },
    })
    existingWorksiteId = possible?.id ?? null
  }
  if (existingWorksiteId) {
    return { ok: false, outcome: "DUPLICATE_REQUIRES_ACK", code: "DUPLICATE_REQUIRES_ACK", existingWorksiteId,
      message: "Un chantier correspondant existe déjà : vérifier le chantier existant avant de poursuivre" }
  }
  const convert = deps.convert ?? importDraftConversionService.convertImportDraft.bind(importDraftConversionService)
  return convert(ctx, { ...input, clientMode: "EXISTING", existingClientId: clientId })
}
