import { v2 as cloudinary } from "cloudinary"
import type { UploadApiErrorResponse } from "cloudinary"
import type {
  AttachmentStorageDestroyInput,
  AttachmentStorageInput,
  AttachmentStorageResult,
} from "@/lib/acquisition/attachments/attachment.types"

export interface AttachmentStoragePort {
  store(input: AttachmentStorageInput): Promise<AttachmentStorageResult>
  destroy(input: AttachmentStorageDestroyInput): Promise<void>
}

/** Réponse Cloudinary documentée lorsque overwrite:false et le public_id existe déjà. */
export interface CloudinaryExistingUploadResponse {
  existing?: boolean
  public_id?: string
  secure_url?: string
}

function expectedPublicId(input: AttachmentStorageInput): string {
  const folder = `planificator/${input.companyId}/acquisition/${input.acquisitionMessageId}/${input.attachmentId}`
  const stem = input.generatedFilename.replace(/\.[^.]+$/, "")
  return `${folder}/${stem}`
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

/**
 * Stockage Cloudinary — dossier tenant isolé, accès authenticated (pas d'URL publique permanente).
 * Chemin logique : planificator/{companyId}/acquisition/{messageId}/{attachmentId}/{generatedName}
 *
 * Objet préexistant : non réutilisé automatiquement (pas de preuve de contenu/hash).
 * Une future réconciliation pourra lire métadonnées Cloudinary, vérifier hash ou marqueur
 * serveur fiable, puis décider de rattacher ou supprimer l'objet.
 */
export class CloudinaryAttachmentStorageAdapter implements AttachmentStoragePort {
  async store(input: AttachmentStorageInput): Promise<AttachmentStorageResult> {
    const folder = `planificator/${input.companyId}/acquisition/${input.acquisitionMessageId}/${input.attachmentId}`
    const publicIdStem = input.generatedFilename.replace(/\.[^.]+$/, "")
    const deterministicPublicId = expectedPublicId(input)

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
            const payload = result ?? err
            if (!payload || typeof payload !== "object") {
              reject(new Error("ATTACHMENT_STORAGE_FAILED"))
              return
            }

            const apiError =
              "error" in payload && payload.error ? (payload.error as UploadApiErrorResponse) : null
            if (apiError) {
              if (isCloudinaryStorageCollisionError(apiError)) {
                resolve(collisionResult(deterministicPublicId))
                return
              }
              reject(new Error("ATTACHMENT_STORAGE_FAILED"))
              return
            }

            if (isCloudinaryExistingAssetResponse(payload)) {
              resolve(collisionResult(payload.public_id ?? deterministicPublicId))
              return
            }

            const secureUrl = "secure_url" in payload ? String(payload.secure_url ?? "") : ""
            const publicId = "public_id" in payload ? String(payload.public_id ?? "") : ""
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
