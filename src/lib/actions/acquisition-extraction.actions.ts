"use server"

/**
 * PLAN-ACQ-005B-2 — Server Action Extract Draft.
 * Accessible ADMIN | SUPER_ADMIN uniquement. Feature flags OFF par défaut.
 */

import { auth } from "@/auth"
import { runDraftExtraction } from "@/lib/acquisition/extraction/extraction.service"
import type { ExtractDraftResult } from "@/lib/acquisition/extraction/extraction.types"

export async function extractWorksiteImportDraft(input: {
  draftId: string
  force?: boolean
}): Promise<ExtractDraftResult> {
  const session = await auth()
  if (!session?.user) {
    return {
      ok: false,
      outcome: "FORBIDDEN",
      code: "EXTRACTION_FORBIDDEN",
      message: "Non authentifié",
    }
  }

  return runDraftExtraction({
    actor: {
      userId: session.user.id,
      role: session.user.role,
      companyId: session.user.companyId ?? null,
    },
    draftId: input.draftId,
    force: input.force,
  })
}
