/**
 * PLAN-ACQ-005D — Cœur testable conversion (hors "use server").
 */

import { revalidatePath as nextRevalidatePath } from "next/cache"
import { auth as nextAuth } from "@/auth"
import type { Role } from "@prisma/client"
import { isAcquisitionConversionFullyEnabled } from "@/lib/acquisition/conversion/conversion-feature-flag"
import { importDraftConversionService } from "@/lib/acquisition/conversion/conversion.service"
import type {
  ConversionActorContext,
  ConvertImportDraftResult,
} from "@/lib/acquisition/conversion/conversion.types"

type AuthSession = {
  user: { id: string; role: Role; companyId: string | null }
} | null

export type AcquisitionConversionActionDeps = {
  auth?: () => Promise<AuthSession>
  isConversionEnabled?: () => boolean
  convertImportDraft?: (
    ctx: ConversionActorContext,
    input: unknown
  ) => Promise<ConvertImportDraftResult>
  revalidatePath?: (path: string) => void
}

async function requireConversionContext(
  deps: AcquisitionConversionActionDeps
): Promise<
  | { ok: true; ctx: ConversionActorContext }
  | { ok: false; outcome: "FORBIDDEN"; code: string; message: string }
> {
  const authenticate = deps.auth ?? nextAuth
  const session = await authenticate()
  if (!session?.user?.id) {
    return { ok: false, outcome: "FORBIDDEN", code: "UNAUTHENTICATED", message: "Non authentifié" }
  }
  const role = session.user.role as Role
  const companyId = session.user.companyId
  if (!["ADMIN", "SUPER_ADMIN"].includes(role) || !companyId) {
    return { ok: false, outcome: "FORBIDDEN", code: "CONVERSION_FORBIDDEN", message: "Accès refusé" }
  }
  return {
    ok: true,
    ctx: {
      actorUserId: session.user.id,
      actorRole: role,
      companyId,
    },
  }
}

export async function convertImportDraftActionImpl(
  input: unknown,
  deps: AcquisitionConversionActionDeps = {}
): Promise<ConvertImportDraftResult> {
  const authz = await requireConversionContext(deps)
  if (!authz.ok) {
    return { ok: false, outcome: authz.outcome, code: authz.code, message: authz.message }
  }

  const enabled = deps.isConversionEnabled ?? isAcquisitionConversionFullyEnabled
  if (!enabled()) {
    return {
      ok: false,
      outcome: "DISABLED",
      code: "CONVERSION_DISABLED",
      message: "Conversion désactivée",
    }
  }

  const convert =
    deps.convertImportDraft ??
    ((ctx, raw) => importDraftConversionService.convertImportDraft(ctx, raw))
  const result = await convert(authz.ctx, input)

  if (result.ok) {
    const revalidate = deps.revalidatePath ?? nextRevalidatePath
    revalidate("/consultations")
    if (input && typeof input === "object" && "draftId" in input) {
      const draftId = String((input as { draftId: unknown }).draftId ?? "")
      if (draftId) revalidate(`/consultations/${draftId}`)
    }
    revalidate("/chantiers")
    revalidate(`/chantiers/${result.worksiteId}`)
    if (result.clientCreated) {
      revalidate("/clients")
    }
  }

  return result
}
