/**
 * Photos d'engins — résolution des dossiers Drive par IDENTITÉ (SPEC-WORKSITE-PHOTOS-001 §3.6, D15).
 *
 * `/Chantiers` (racine) → `<client>-<chantier>~<id6>` (chantier) → `<yyyy-MM-dd>` (jour).
 * Chaque dossier a une ligne `worksite_photo_drive_folders` réservée par `INSERT … ON CONFLICT DO NOTHING`
 * avec un identifiant Drive **préalloué** (`files.generateIds`) : la création est idempotente, deux uploads
 * concurrents pour le même chantier et le même jour créent un seul dossier (409 Drive = existant).
 * Le libellé est décoratif et figé à la création ; un renommage du chantier ne déplace rien.
 */
import { DriveProviderError } from "./drive.errors"
import { DRIVE_FOLDER_MIME, type DriveApiClient } from "./drive-api.client"
import { DRIVE_ROOT_FOLDER_NAME } from "../photo.domain"

export type DriveFolderState = "RESERVED" | "CREATED"

export interface DriveFolderRecord {
  id: string
  companyId: string
  worksiteId: string | null
  day: Date | null
  driveFolderId: string
  path: string
  state: DriveFolderState
}

/* eslint-disable @typescript-eslint/no-explicit-any */
export interface DriveFoldersDb {
  worksitePhotoDriveFolder: {
    findFirst: (args?: any) => Promise<DriveFolderRecord | null>
    /** Insertion tolérante au conflit d'identité : renvoie `null` si une ligne existe déjà (ON CONFLICT DO NOTHING). */
    createIfAbsent: (data: { companyId: string; worksiteId: string | null; day: Date | null; driveFolderId: string; path: string }) => Promise<DriveFolderRecord | null>
    update: (args?: any) => Promise<unknown>
    delete: (args?: any) => Promise<unknown>
  }
  worksitePhotoDriveConnection: {
    update: (args?: any) => Promise<unknown>
  }
}
/* eslint-enable @typescript-eslint/no-explicit-any */

export interface DriveFoldersDeps {
  db: DriveFoldersDb
  drive: DriveApiClient
  /** Jeton d'accès valide pour l'entreprise (drive-connection.client). */
  accessToken: string
  companyId: string
  /** Identifiant racine déjà connu (connexion), sinon créé puis mémorisé sur la connexion. */
  rootFolderId: string | null
}

export interface FolderIdentity { worksiteId: string | null; day: Date | null }

/** `day` normalisé à minuit UTC (convention des colonnes DATE du dépôt). */
export function normalizeDay(day: Date): Date {
  return new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate()))
}

async function findByIdentity(deps: DriveFoldersDeps, identity: FolderIdentity): Promise<DriveFolderRecord | null> {
  return deps.db.worksitePhotoDriveFolder.findFirst({ where: { companyId: deps.companyId, worksiteId: identity.worksiteId, day: identity.day } })
}

/**
 * Garantit l'existence d'un dossier identifié : réserve la ligne (identifiant préalloué), crée le dossier Drive
 * (409 = déjà créé), passe la ligne en CREATED. Si le dossier a été supprimé à la main (404 au contrôle),
 * la ligne est remplacée par une nouvelle réservation avec un nouvel identifiant.
 */
export async function ensureFolder(deps: DriveFoldersDeps, identity: FolderIdentity, label: string, parentDriveId: string | null): Promise<DriveFolderRecord> {
  let record = await findByIdentity(deps, identity)
  if (!record) {
    const [driveFolderId] = await deps.drive.generateIds(deps.accessToken, 1)
    const path = parentPath(identity, label)
    record = (await deps.db.worksitePhotoDriveFolder.createIfAbsent({ companyId: deps.companyId, worksiteId: identity.worksiteId, day: identity.day, driveFolderId, path }))
      ?? (await findByIdentity(deps, identity))
    if (!record) throw new DriveProviderError("DRIVE_INVALID_RESPONSE", 500, false, null, "folder_row_missing_after_conflict")
  }
  if (record.state === "CREATED") {
    // Vérification légère : un dossier supprimé à la main est recréé sous un nouvel identifiant.
    try {
      const meta = await deps.drive.getFile(deps.accessToken, record.driveFolderId)
      if (!meta.trashed) return record
    } catch (error) {
      if (!(error instanceof DriveProviderError) || error.code !== "DRIVE_NOT_FOUND") throw error
    }
    await deps.db.worksitePhotoDriveFolder.delete({ where: { id: record.id } })
    return ensureFolder(deps, identity, label, parentDriveId)
  }
  try {
    await deps.drive.createFolder(deps.accessToken, { id: record.driveFolderId, name: record.path.split("/").pop() ?? label, parentId: parentDriveId })
  } catch (error) {
    if (!(error instanceof DriveProviderError) || error.code !== "DRIVE_ID_EXISTS") throw error
    // Collision d'identifiant reconnue (création concurrente ou reprise sur le même identifiant préalloué) :
    // la création n'est acquise que si l'objet distant est bien NOTRE dossier (L2-R5).
    const remote = await deps.drive.getFile(deps.accessToken, record.driveFolderId)
    const parentOk = parentDriveId === null || remote.parents.includes(parentDriveId)
    if (remote.trashed || remote.mimeType !== DRIVE_FOLDER_MIME || !parentOk) {
      throw new DriveProviderError("DRIVE_CONFLICT", 409, false, 409, "existing_object_mismatch")
    }
  }
  await deps.db.worksitePhotoDriveFolder.update({ where: { id: record.id }, data: { state: "CREATED" } })
  return { ...record, state: "CREATED" }
}

function parentPath(identity: FolderIdentity, label: string): string {
  // Le chemin complet est reconstitué par l'appelant (§7.1 drivePath) ; la ligne ne garde que le libellé du niveau.
  if (identity.worksiteId === null) return DRIVE_ROOT_FOLDER_NAME
  return label
}

export interface ResolvedPhotoFolders { rootId: string; worksiteFolderId: string; dayFolderId: string; worksiteLabel: string; dayLabel: string }

/**
 * Résout (et crée si besoin) racine → chantier → jour ; mémorise la racine sur la connexion la première fois.
 * Chemin rapide : si le dossier du jour est déjà CREATED et toujours présent sur Drive, ses parents le sont aussi
 * (Drive met un dossier et son contenu en corbeille ensemble) ⇒ un seul `files.get` par upload en régime établi.
 */
export async function resolvePhotoFolders(deps: DriveFoldersDeps, input: { worksiteId: string; worksiteLabel: string; day: Date; dayLabel: string }): Promise<ResolvedPhotoFolders> {
  const dayIdentity: FolderIdentity = { worksiteId: input.worksiteId, day: normalizeDay(input.day) }
  const cachedDay = await findByIdentity(deps, dayIdentity)
  if (cachedDay?.state === "CREATED") {
    const [cachedRoot, cachedWorksite] = await Promise.all([
      findByIdentity(deps, { worksiteId: null, day: null }),
      findByIdentity(deps, { worksiteId: input.worksiteId, day: null }),
    ])
    if (cachedRoot?.state === "CREATED" && cachedWorksite?.state === "CREATED") {
      try {
        const meta = await deps.drive.getFile(deps.accessToken, cachedDay.driveFolderId)
        if (!meta.trashed) {
          return { rootId: cachedRoot.driveFolderId, worksiteFolderId: cachedWorksite.driveFolderId, dayFolderId: cachedDay.driveFolderId, worksiteLabel: cachedWorksite.path, dayLabel: cachedDay.path }
        }
      } catch (error) {
        if (!(error instanceof DriveProviderError) || error.code !== "DRIVE_NOT_FOUND") throw error
      }
      // Dossier du jour absent ou en corbeille : chemin complet ci-dessous (vérifie et recrée ce qui manque).
    }
  }
  const root = await ensureFolder(deps, { worksiteId: null, day: null }, DRIVE_ROOT_FOLDER_NAME, null)
  if (deps.rootFolderId !== root.driveFolderId) {
    await deps.db.worksitePhotoDriveConnection.update({ where: { companyId: deps.companyId }, data: { rootFolderId: root.driveFolderId } })
  }
  const worksite = await ensureFolder(deps, { worksiteId: input.worksiteId, day: null }, input.worksiteLabel, root.driveFolderId)
  const day = await ensureFolder(deps, { worksiteId: input.worksiteId, day: normalizeDay(input.day) }, input.dayLabel, worksite.driveFolderId)
  return { rootId: root.driveFolderId, worksiteFolderId: worksite.driveFolderId, dayFolderId: day.driveFolderId, worksiteLabel: worksite.path, dayLabel: day.path }
}
