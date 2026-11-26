import { v2 as cloudinary } from "cloudinary"
import type { UploadApiErrorResponse } from "cloudinary"
import { verifyPrivateAttachment } from "@/lib/acquisition/attachments/verify-private-attachment"
import { buildAcquisitionAttachmentCloudinaryFolder } from "@/lib/acquisition/attachments/attachment-cloudinary-folder-prefix"
import type {
  AttachmentStorageDestroyInput,
  AttachmentStorageInput,
  AttachmentStorageResult,
} from "@/lib/acquisition/attachments/attachment.types"

type VerifyExistingInput = Omit<AttachmentStorageInput, "buffer"> & {
  storagePublicId: string
  sha256: string
  sizeBytes: number
}

export interface AttachmentStoragePort {
  store(input: AttachmentStorageInput): Promise<AttachmentStorageResult>
  destroy(input: AttachmentStorageDestroyInput): Promise<void>
  /** Confirme l’identité, la taille et le SHA-256 d’un objet privé existant. */
  verifyExisting?(input: VerifyExistingInput): Promise<{ storageUrl: string } | null>
}

/** Réponse Cloudinary documentée lorsque overwrite:false et le public_id existe déjà. */
export interface CloudinaryExistingUploadResponse {
  existing?: boolean
  public_id?: string
  secure_url?: string
}

export function isCloudinaryUploadApiError(error: unknown): error is UploadApiErrorResponse {
  if (typeof error !== "object" || error === null) return false
  return typeof (error as UploadApiErrorResponse).http_code === "number"
}

/**
 * Collision public_id — détection structurée uniquement (pas de parsing de message).
 * 1. Champ `existing: true` sur réponse upload (overwrite:false).
 * 2. http_code 409 documenté par l'Upload API (« Already exists »).
 */
export function isCloudinaryStorageCollisionError(error: unknown): boolean {
  if (!isCloudinaryUploadApiError(error)) return false
  return error.http_code === 409
}

export function isCloudinaryExistingAssetResponse(
  result: unknown
): result is CloudinaryExistingUploadResponse {
  if (typeof result !== "object" || result === null) return false
  return (result as CloudinaryExistingUploadResponse).existing === true
}

function collisionResult(publicId: string): AttachmentStorageResult {
  return { created: false, storagePublicId: publicId }
}

function resolveStorageIdentity({ companyId, acquisitionMessageId, attachmentId, generatedFilename }: Pick<
  AttachmentStorageInput, "companyId" | "acquisitionMessageId" | "attachmentId" | "generatedFilename"
>) {
  const folder = buildAcquisitionAttachmentCloudinaryFolder({ companyId, acquisitionMessageId, attachmentId })
  const publicIdStem = generatedFilename.replace(/\.[^.]+$/, "")
  return { folder, publicIdStem, deterministicPublicId: `${folder}/${publicIdStem}` }
}

/**
 * Stockage Cloudinary — dossier tenant isolé, accès authenticated (pas d'URL publique permanente).
 * Chemin logique : {folderPrefix}/{companyId}/acquisition/{messageId}/{attachmentId}/{generatedName}
 * folderPrefix via ACQUISITION_ATTACHMENT_CLOUDINARY_FOLDER_PREFIX (défaut planificator).
 *
 * Un objet préexistant est vérifié en lecture avant rattachement par le LOT-5.
 *
 * destroy() utilise le storagePublicId déjà enregistré — inchangé par le préfixe d'upload.
 */
export class CloudinaryAttachmentStorageAdapter implements AttachmentStoragePort {
  async store(input: AttachmentStorageInput): Promise<AttachmentStorageResult> {
    const { folder, publicIdStem, deterministicPublicId } = resolveStorageIdentity(input)

    return new Promise<AttachmentStorageResult>((resolve, reject) => {
      cloudinary.uploader
        .upload_stream(
          {
            folder,
            public_id: publicIdStem,
            resource_type: "raw",
            type: "authenticated",
            overwrite: false,
            unique_filename: false,
            use_filename: false,
          },
          (err, result) => {
            if (err) {
              if (isCloudinaryStorageCollisionError(err)) {
                resolve(collisionResult(deterministicPublicId))
                return
              }

              console.error("[acquisition][attachment-storage] Cloudinary upload failed", {
                httpCode: isCloudinaryUploadApiError(err) ? err.http_code : null,
              })
              reject(new Error("ATTACHMENT_STORAGE_FAILED"))
              return
            }

            if (!result || typeof result !== "object") {
              reject(new Error("ATTACHMENT_STORAGE_FAILED"))
              return
            }

            const apiError =
              "error" in result && result.error
                ? (result.error as UploadApiErrorResponse)
                : null
            if (apiError) {
              if (isCloudinaryStorageCollisionError(apiError)) {
                resolve(collisionResult(deterministicPublicId))
                return
              }

              console.error("[acquisition][attachment-storage] Cloudinary upload failed", {
                httpCode: isCloudinaryUploadApiError(apiError) ? apiError.http_code : null,
              })
              reject(new Error("ATTACHMENT_STORAGE_FAILED"))
              return
            }

            if (isCloudinaryExistingAssetResponse(result)) {
              resolve(collisionResult(result.public_id ?? deterministicPublicId))
              return
            }

            const uploadResult = result as {
              secure_url?: string
              public_id?: string
            }
            const secureUrl = String(uploadResult.secure_url ?? "")
            const publicId = String(uploadResult.public_id ?? "")
            if (!secureUrl || !publicId) {
              reject(new Error("ATTACHMENT_STORAGE_FAILED"))
              return
            }

            resolve({
              created: true,
              storageUrl: secureUrl,
              storagePublicId: publicId,
            })
          }
        )
        .end(input.buffer)
    })
  }

  async verifyExisting(input: VerifyExistingInput): Promise<{ storageUrl: string } | null> {
    const { companyId, acquisitionMessageId, attachmentId, generatedFilename, storagePublicId, sha256, sizeBytes } = input
    const identity = { companyId, acquisitionMessageId, attachmentId }
    if (![companyId, acquisitionMessageId, attachmentId, generatedFilename].every(
      value => /^[a-zA-Z0-9_-]+(?:\.[a-zA-Z0-9_-]+)?$/.test(value),
    )) return null

    try {
      const { deterministicPublicId: publicId } = resolveStorageIdentity({ ...identity, generatedFilename })
      if (storagePublicId !== publicId) return null

      const cloudName = cloudinary.config().cloud_name
      if (!cloudName || !/^[a-zA-Z0-9_-]+$/.test(cloudName)) return null
      const metadata = await cloudinary.api.resource(publicId, {
        resource_type: "raw",
        type: "authenticated",
        timeout: 4_000,
      })
      if (metadata.public_id !== publicId || metadata.resource_type !== "raw" ||
          metadata.type !== "authenticated" || metadata.bytes !== sizeBytes ||
          !Number.isSafeInteger(metadata.version) || metadata.version < 1) return null
      // La relecture est signée à partir du public_id vérifié, sans utiliser l’URL des métadonnées.
      const storageUrl = `https://res.cloudinary.com/${cloudName}/raw/authenticated/v${metadata.version}/${publicId}`

      const signedUrl = cloudinary.utils.private_download_url(publicId, "", {
        resource_type: "raw",
        type: "authenticated",
        expires_at: Math.floor(Date.now() / 1000) + 60,
        attachment: false,
      })
      const verified = await verifyPrivateAttachment({
        expected: { ...identity, publicId, sha256, sizeBytes },
        candidate: { ...identity, publicId, resourceType: "raw", deliveryType: "authenticated" },
        signedUrl,
        allowedOrigin: "https://api.cloudinary.com",
      }, (url, options) => fetch(url, {
        ...options,
        headers: { "Accept-Encoding": "identity" },
      }))
      return verified ? { storageUrl } : null
    } catch {
      return null
    }
  }

  async destroy(input: AttachmentStorageDestroyInput): Promise<void> {
    const resourceType = input.resourceType ?? "raw"
    const type = input.type ?? "authenticated"

    try {
      const result = await cloudinary.uploader.destroy(input.storagePublicId, {
        resource_type: resourceType,
        type,
      })
      if (result.result === "ok" || result.result === "not found") return
      throw new Error("ATTACHMENT_COMPENSATION_FAILED")
    } catch (error) {
      if (error instanceof Error && error.message === "ATTACHMENT_COMPENSATION_FAILED") throw error
      throw new Error("ATTACHMENT_COMPENSATION_FAILED")
    }
  }
}

export const cloudinaryAttachmentStorage = new CloudinaryAttachmentStorageAdapter()
