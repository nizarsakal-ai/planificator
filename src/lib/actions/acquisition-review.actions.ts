"use server"

/**
 * PLAN-ACQ-005C-MVP — Server Actions revue consultations.
 * Entrée publique : `input` uniquement (pas de deps injectables côté client).
 */

import {
  approveImportDraftActionImpl,
  rejectImportDraftActionImpl,
  reExtractImportDraftActionImpl,
  saveImportDraftCorrectionsActionImpl,
} from "@/lib/actions/acquisition-review.actions.core"

export async function saveImportDraftCorrectionsAction(input: unknown) {
  return saveImportDraftCorrectionsActionImpl(input)
}

export async function approveImportDraftAction(input: unknown) {
  return approveImportDraftActionImpl(input)
}

export async function rejectImportDraftAction(input: unknown) {
  return rejectImportDraftActionImpl(input)
}

export async function reExtractImportDraftAction(input: unknown) {
  return reExtractImportDraftActionImpl(input)
}
