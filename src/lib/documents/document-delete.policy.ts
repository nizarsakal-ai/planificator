/** PLAN-ACQ-005D — Politique destroy Cloudinary à la suppression Document. */
export function shouldDestroyCloudinaryOnDocumentDelete(doc: {
  sourceAcquisitionAttachmentId: string | null
  url: string | null
}): boolean {
  if (doc.sourceAcquisitionAttachmentId) return false
  return Boolean(doc.url?.includes("cloudinary.com"))
}
