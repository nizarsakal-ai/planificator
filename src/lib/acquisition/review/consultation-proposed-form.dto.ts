/**
 * PLAN-ACQ-005C-MVP — Construction DTO client formulaire (sans raw confidence/warnings).
 */

import type {
  ConsultationProposedFormDto,
  ImportDraftReviewBundle,
} from "@/lib/acquisition/review/import-draft-review.types"
import { dateToInputValue } from "@/lib/acquisition/review/consultation-ui"

export function toConsultationProposedFormDto(
  draft: ImportDraftReviewBundle["draft"],
  extractionEnabled: boolean
): ConsultationProposedFormDto {
  return {
    id: draft.id,
    status: draft.status,
    version: draft.version,
    proposedWorksiteName: draft.proposedWorksiteName,
    proposedClientName: draft.proposedClientName,
    proposedAddress: draft.proposedAddress,
    proposedPostalCode: draft.proposedPostalCode,
    proposedCity: draft.proposedCity,
    proposedStartDate: draft.proposedStartDate
      ? dateToInputValue(draft.proposedStartDate) || null
      : null,
    proposedEndDate: draft.proposedEndDate
      ? dateToInputValue(draft.proposedEndDate) || null
      : null,
    proposedDescription: draft.proposedDescription,
    proposedContactName: draft.proposedContactName,
    proposedContactEmail: draft.proposedContactEmail,
    proposedContactPhone: draft.proposedContactPhone,
    extractionEnabled,
  }
}
