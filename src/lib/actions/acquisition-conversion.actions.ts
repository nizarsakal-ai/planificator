"use server"

/**
 * PLAN-ACQ-005D — Server Actions conversion.
 * Entrée publique : `input` uniquement.
 */

import { convertImportDraftActionImpl } from "@/lib/actions/acquisition-conversion.actions.core"

export async function convertImportDraftAction(input: unknown) {
  return convertImportDraftActionImpl(input)
}
