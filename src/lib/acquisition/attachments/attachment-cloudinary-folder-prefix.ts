/**
 * Préfixe de dossier Cloudinary pour les nouveaux uploads Acquisition.
 * Variable non secrète : ACQUISITION_ATTACHMENT_CLOUDINARY_FOLDER_PREFIX.
 * Jamais déduit de NODE_ENV / VERCEL_ENV / hostname / URL.
 *
 * Validation volontairement stricte (acceptée produit) :
 * un segment ; minuscules ASCII, chiffres, tirets ;
 * pas de tiret initial/final ni de double tiret.
 */

export const DEFAULT_ACQUISITION_ATTACHMENT_CLOUDINARY_FOLDER_PREFIX = "planificator"

export const ACQUISITION_ATTACHMENT_CLOUDINARY_FOLDER_PREFIX_ENV =
  "ACQUISITION_ATTACHMENT_CLOUDINARY_FOLDER_PREFIX" as const

/** Un seul segment : minuscules ASCII, chiffres, tirets (pas init/fin/double). */
const FOLDER_PREFIX_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

export function resolveAcquisitionAttachmentCloudinaryFolderPrefix(
  raw: string | undefined = process.env.ACQUISITION_ATTACHMENT_CLOUDINARY_FOLDER_PREFIX
): string {
  if (raw == null) return DEFAULT_ACQUISITION_ATTACHMENT_CLOUDINARY_FOLDER_PREFIX
  const trimmed = raw.trim()
  if (!trimmed) throw new Error("ATTACHMENT_CLOUDINARY_FOLDER_PREFIX_INVALID")

  if (
    trimmed.includes("/") ||
    trimmed.includes("\\") ||
    trimmed.includes("..") ||
    /\s/.test(trimmed) ||
    /[A-Z]/.test(trimmed) ||
    !FOLDER_PREFIX_PATTERN.test(trimmed)
  ) {
    throw new Error("ATTACHMENT_CLOUDINARY_FOLDER_PREFIX_INVALID")
  }

  return trimmed
}

export function buildAcquisitionAttachmentCloudinaryFolder(input: {
  companyId: string
  acquisitionMessageId: string
  attachmentId: string
  /** Si fourni, soumis à la même normalisation/validation que l'env. */
  folderPrefix?: string
}): string {
  const prefix = resolveAcquisitionAttachmentCloudinaryFolderPrefix(input.folderPrefix)
  return `${prefix}/${input.companyId}/acquisition/${input.acquisitionMessageId}/${input.attachmentId}`
}
