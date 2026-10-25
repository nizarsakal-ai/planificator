/**
 * Véhicules V3 Lot 1 — port de stockage privé des pièces véhicule.
 * Adaptateur Cloudinary dédié : resource_type raw, type authenticated, dossier isolé par
 * entreprise/camion/dossier, clé opaque déterministe (version + empreinte), jamais d'URL
 * publique persistée. Le chantier (upload public) et l'adaptateur Acquisition
 * (lié message/pièce jointe) ne sont pas réutilisés directement, conformément à l'audit.
 */
import { v2 as cloudinary } from "cloudinary"
import { isCloudinaryStorageCollisionError, isCloudinaryUploadApiError, isCloudinaryExistingAssetResponse } from "@/lib/acquisition/attachments/attachment-storage.port"
import { ensureCloudinaryConfigured } from "../cloudinary-config"

export interface DocumentStorageLocation {
  companyId: string
  truckId: string
  documentId: string
  versionId: string
  sha256: string
  extension: string
}

export interface DocumentStorageStoreResult {
  storageKey: string
  /** true si l'objet a été créé par cet appel ; false si une clé identique existait déjà. */
  created: boolean
}

export interface DocumentStoragePort {
  readonly provider: "cloudinary"
  store(location: DocumentStorageLocation, bytes: Uint8Array): Promise<DocumentStorageStoreResult>
  /** Compensation best-effort après échec de rattachement ; ne jette jamais pour un objet absent. */
  destroy(storageKey: string): Promise<void>
  /** Lien signé bref, utilisé uniquement côté serveur par le proxy ; jamais journalisé ni renvoyé. */
  createSignedUrl(storageKey: string, expiresAt: Date): Promise<string>
}

const FOLDER_PREFIX_ENV = "VEHICLE_DOCUMENT_CLOUDINARY_FOLDER_PREFIX"
const SEGMENT = /^[A-Za-z0-9_-]{1,64}$/

export function buildDocumentStorageKey(location: DocumentStorageLocation, env: NodeJS.ProcessEnv = process.env): string {
  const prefix = (env[FOLDER_PREFIX_ENV] ?? "planificator").trim()
  for (const [name, value] of Object.entries({ prefix, companyId: location.companyId, truckId: location.truckId, documentId: location.documentId, versionId: location.versionId })) {
    if (!SEGMENT.test(value)) throw new Error(`VEHICLE_DOCUMENT_STORAGE_SEGMENT_INVALID:${name}`)
  }
  if (!/^[0-9a-f]{64}$/.test(location.sha256)) throw new Error("VEHICLE_DOCUMENT_STORAGE_SHA_INVALID")
  const ext = location.extension.replace(/^\./, "").toLowerCase()
  if (!/^[a-z0-9]{1,8}$/.test(ext)) throw new Error("VEHICLE_DOCUMENT_STORAGE_EXT_INVALID")
  return `${prefix}/${location.companyId}/vehicles/${location.truckId}/documents/${location.documentId}/${location.versionId}-${location.sha256.slice(0, 16)}.${ext}`
}

/** Code 503 renvoyé si ni le triplet CLOUDINARY_* ni CLOUDINARY_URL ne sont disponibles ; aucun octet envoyé. */
export const DOCUMENT_STORAGE_NOT_CONFIGURED = "DOCUMENT_STORAGE_NOT_CONFIGURED"

export class CloudinaryDocumentStorageAdapter implements DocumentStoragePort {
  readonly provider = "cloudinary" as const

  async store(location: DocumentStorageLocation, bytes: Uint8Array): Promise<DocumentStorageStoreResult> {
    ensureCloudinaryConfigured(DOCUMENT_STORAGE_NOT_CONFIGURED)
    const storageKey = buildDocumentStorageKey(location)
    const folder = storageKey.slice(0, storageKey.lastIndexOf("/"))
    const publicId = storageKey.slice(storageKey.lastIndexOf("/") + 1)
    return new Promise<DocumentStorageStoreResult>((resolve, reject) => {
      cloudinary.uploader.upload_stream(
        { folder, public_id: publicId, resource_type: "raw", type: "authenticated", overwrite: false, unique_filename: false, use_filename: false },
        (error, result) => {
          if (error) {
            if (isCloudinaryStorageCollisionError(error)) return resolve({ storageKey, created: false })
            console.error("[vehicle-documents][storage] upload failed", { httpCode: isCloudinaryUploadApiError(error) ? error.http_code : null })
            return reject(new Error("DOCUMENT_STORAGE_FAILED"))
          }
          if (!result || typeof result !== "object") return reject(new Error("DOCUMENT_STORAGE_FAILED"))
          if (isCloudinaryExistingAssetResponse(result)) return resolve({ storageKey, created: false })
          const publicIdReturned = String((result as { public_id?: string }).public_id ?? "")
          if (publicIdReturned !== storageKey) {
            console.error("[vehicle-documents][storage] unexpected public id")
            return reject(new Error("DOCUMENT_STORAGE_FAILED"))
          }
          resolve({ storageKey, created: true })
        },
      ).end(Buffer.from(bytes))
    })
  }

  async destroy(storageKey: string): Promise<void> {
    ensureCloudinaryConfigured(DOCUMENT_STORAGE_NOT_CONFIGURED)
    try {
      const result = await cloudinary.uploader.destroy(storageKey, { resource_type: "raw", type: "authenticated" })
      if (result.result === "ok" || result.result === "not found") return
    } catch {
      /* journalisé ci-dessous sans URL ni secret */
    }
    console.error("[vehicle-documents][storage] compensation failed", { storageKey })
    throw new Error("DOCUMENT_STORAGE_COMPENSATION_FAILED")
  }

  async createSignedUrl(storageKey: string, expiresAt: Date): Promise<string> {
    ensureCloudinaryConfigured(DOCUMENT_STORAGE_NOT_CONFIGURED)
    try {
      return cloudinary.utils.private_download_url(storageKey, "", {
        resource_type: "raw", type: "authenticated", expires_at: Math.floor(expiresAt.getTime() / 1000), attachment: false,
      })
    } catch {
      throw new Error("DOCUMENT_STORAGE_SIGN_FAILED")
    }
  }
}

export const cloudinaryDocumentStorage: DocumentStoragePort = new CloudinaryDocumentStorageAdapter()
