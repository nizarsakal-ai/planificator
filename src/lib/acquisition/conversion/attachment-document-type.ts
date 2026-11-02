import type { AcquisitionAttachmentCategory, DocumentType } from "@prisma/client"

/** Catégorie de pièce jointe Acquisition → type de Document du chantier. */
export function mapAttachmentCategoryToDocumentType(
  category: AcquisitionAttachmentCategory
): DocumentType {
  if (category === "PLAN") return "PLAN"
  if (category === "PHOTO") return "PHOTO"
  return "DOCUMENT"
}
