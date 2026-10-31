/**
 * Photos d'engins — port de stockage (SPEC-WORKSITE-PHOTOS-001 §9) et adaptateur Google Drive.
 *
 * Le service ne connaît que ce port : identifiant préalloué, dossier du jour, création idempotente (un second
 * `create` sur le même identifiant ⇒ `created: false`), lecture, flux de téléchargement, corbeille, suppression.
 * L'adaptateur Drive compose la connexion chiffrée (refresh, 401 ⇒ un refresh forcé), le client REST et la
 * résolution des dossiers par identité. Aucune URL Drive ne sort de ce fichier.
 */
import type { PrismaClient } from "@prisma/client"
import { DriveProviderError } from "./drive/drive.errors"
import { fetchDriveApiClient, type DriveApiClient, type DriveDownload, type DriveFileMetadata } from "./drive/drive-api.client"
import { findDriveConnection, withDriveAccess, type DriveConnectionDeps } from "./drive/drive-connection.client"
import { resolvePhotoFolders, type DriveFoldersDb } from "./drive/drive-folders"
import { prismaDriveFoldersDb } from "./drive/drive-folders.prisma-adapter"

export interface StoredFileInfo { id: string; size: number | null; md5: string | null; trashed: boolean }

export interface CreateStoredFileInput {
  id: string
  name: string
  parentId: string
  mimeType: string
  bytes: Uint8Array
  appProperties: Record<string, string>
}

export interface ResolveFoldersInput { worksiteId: string; worksiteLabel: string; day: Date; dayLabel: string }
export interface ResolvedFolders { dayFolderId: string; worksiteLabel: string; dayLabel: string }

export interface PhotoStoragePort {
  readonly provider: "drive"
  /** Identifiant unique préalloué (D15) : toutes les tentatives d'une réservation ciblent ce fichier. */
  preallocateFileId(companyId: string): Promise<string>
  resolveFolders(companyId: string, input: ResolveFoldersInput): Promise<ResolvedFolders>
  /** `created: false` si un fichier existe déjà sous cet identifiant (409 fournisseur). */
  createFile(companyId: string, input: CreateStoredFileInput): Promise<{ created: boolean; info: StoredFileInfo | null }>
  /** `null` si le fichier n'existe pas (404). */
  getFile(companyId: string, fileId: string): Promise<StoredFileInfo | null>
  download(companyId: string, fileId: string): Promise<DriveDownload>
  /**
   * Corbeille (récupérable ; jamais une suppression définitive), idempotente. `missing: true` = le fichier n'existait plus
   * côté fournisseur (404), traité comme « déjà en corbeille » ; l'appelant le journalise (`FILE_MISSING`).
   */
  trash(companyId: string, fileId: string): Promise<{ missing: boolean }>
  /** Suppression définitive : réservée au cron de réconciliation (orphelins) et à la purge. */
  delete(companyId: string, fileId: string): Promise<void>
}

function toInfo(meta: DriveFileMetadata): StoredFileInfo {
  return { id: meta.id, size: meta.size, md5: meta.md5Checksum, trashed: meta.trashed }
}

type StorageDb = DriveConnectionDeps["db"] & { worksitePhotoDriveFolder: DriveFoldersDb["worksitePhotoDriveFolder"] }

export interface DrivePhotoStorageDeps {
  db: StorageDb
  drive?: DriveApiClient
  connection?: Omit<DriveConnectionDeps, "db">
}

export class DrivePhotoStorage implements PhotoStoragePort {
  readonly provider = "drive" as const
  private readonly drive: DriveApiClient
  private readonly connectionDeps: DriveConnectionDeps
  private readonly foldersDb: DriveFoldersDb

  constructor(deps: DrivePhotoStorageDeps) {
    this.drive = deps.drive ?? fetchDriveApiClient
    this.connectionDeps = { ...deps.connection, db: deps.db }
    this.foldersDb = { worksitePhotoDriveFolder: deps.db.worksitePhotoDriveFolder, worksitePhotoDriveConnection: deps.db.worksitePhotoDriveConnection }
  }

  async preallocateFileId(companyId: string): Promise<string> {
    const [id] = await withDriveAccess(companyId, this.connectionDeps, (token) => this.drive.generateIds(token, 1))
    return id
  }

  async resolveFolders(companyId: string, input: ResolveFoldersInput): Promise<ResolvedFolders> {
    const connection = await findDriveConnection(companyId, this.connectionDeps)
    return withDriveAccess(companyId, this.connectionDeps, async (accessToken) => {
      const resolved = await resolvePhotoFolders(
        { db: this.foldersDb, drive: this.drive, accessToken, companyId, rootFolderId: connection?.rootFolderId ?? null },
        input,
      )
      return { dayFolderId: resolved.dayFolderId, worksiteLabel: resolved.worksiteLabel, dayLabel: resolved.dayLabel }
    })
  }

  async createFile(companyId: string, input: CreateStoredFileInput): Promise<{ created: boolean; info: StoredFileInfo | null }> {
    return withDriveAccess(companyId, this.connectionDeps, async (token) => {
      try {
        return { created: true, info: toInfo(await this.drive.createFile(token, input)) }
      } catch (error) {
        if (error instanceof DriveProviderError && error.code === "DRIVE_ID_EXISTS") return { created: false, info: null }
        throw error
      }
    })
  }

  async getFile(companyId: string, fileId: string): Promise<StoredFileInfo | null> {
    return withDriveAccess(companyId, this.connectionDeps, async (token) => {
      try { return toInfo(await this.drive.getFile(token, fileId)) } catch (error) {
        if (error instanceof DriveProviderError && error.code === "DRIVE_NOT_FOUND") return null
        throw error
      }
    })
  }

  download(companyId: string, fileId: string): Promise<DriveDownload> {
    return withDriveAccess(companyId, this.connectionDeps, (token) => this.drive.downloadFile(token, fileId))
  }

  trash(companyId: string, fileId: string): Promise<{ missing: boolean }> {
    return withDriveAccess(companyId, this.connectionDeps, async (token) => {
      try { await this.drive.trashFile(token, fileId); return { missing: false } } catch (error) {
        if (error instanceof DriveProviderError && error.code === "DRIVE_NOT_FOUND") return { missing: true }
        throw error
      }
    })
  }

  delete(companyId: string, fileId: string): Promise<void> {
    return withDriveAccess(companyId, this.connectionDeps, async (token) => {
      try { await this.drive.deleteFile(token, fileId) } catch (error) {
        if (error instanceof DriveProviderError && error.code === "DRIVE_NOT_FOUND") return
        throw error
      }
    })
  }
}

/** Composition de production : Prisma + client Drive `fetch`. */
export function createDrivePhotoStorage(prisma: Pick<PrismaClient, "worksitePhotoDriveConnection" | "worksitePhotoDriveFolder">): PhotoStoragePort {
  const folders = prismaDriveFoldersDb(prisma)
  return new DrivePhotoStorage({
    db: {
      worksitePhotoDriveConnection: prisma.worksitePhotoDriveConnection as unknown as StorageDb["worksitePhotoDriveConnection"],
      worksitePhotoDriveFolder: folders.worksitePhotoDriveFolder,
    },
  })
}
