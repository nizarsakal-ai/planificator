/**
 * Photos d'engins — client REST Google Drive v3 en `fetch` natif (patron `gmail-api.client.ts`), aucune dépendance.
 *
 * Périmètre strict du module : identifiants préalloués (`files.generateIds`), dossiers et fichiers créés avec un
 * identifiant imposé (création idempotente : un second `create` sur le même id ⇒ 409 `DRIVE_ID_EXISTS`),
 * lecture de métadonnées, mise à la corbeille, suppression définitive (réservée au cron de réconciliation et à la purge).
 * Le jeton d'accès est fourni par l'appelant (drive-connection.client) et n'est jamais journalisé.
 */
import { DriveProviderError, mapDriveHttpError, readGoogleErrorReason } from "./drive.errors"

const DRIVE_BASE = "https://www.googleapis.com/drive/v3"
const DRIVE_UPLOAD_BASE = "https://www.googleapis.com/upload/drive/v3"
export const DRIVE_FOLDER_MIME = "application/vnd.google-apps.folder"

export interface DriveFileMetadata {
  id: string
  name: string
  mimeType: string
  size: number | null
  md5Checksum: string | null
  trashed: boolean
  parents: string[]
}

export interface CreateFolderInput { id: string; name: string; parentId: string | null }
export interface CreateFileInput {
  id: string
  name: string
  parentId: string
  mimeType: string
  bytes: Uint8Array
  appProperties: Record<string, string>
}

export interface DriveApiClient {
  generateIds(accessToken: string, count: number): Promise<string[]>
  createFolder(accessToken: string, input: CreateFolderInput): Promise<DriveFileMetadata>
  createFile(accessToken: string, input: CreateFileInput): Promise<DriveFileMetadata>
  getFile(accessToken: string, fileId: string): Promise<DriveFileMetadata>
  trashFile(accessToken: string, fileId: string): Promise<void>
  deleteFile(accessToken: string, fileId: string): Promise<void>
}

const FIELDS = "id,name,mimeType,size,md5Checksum,trashed,parents"

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

function toMetadata(raw: unknown): DriveFileMetadata {
  const r = (raw ?? {}) as Record<string, unknown>
  if (typeof r.id !== "string" || typeof r.name !== "string" || typeof r.mimeType !== "string") {
    throw new DriveProviderError("DRIVE_INVALID_RESPONSE", 502, false)
  }
  const size = typeof r.size === "string" && /^\d+$/.test(r.size) ? Number(r.size) : null
  return {
    id: r.id, name: r.name, mimeType: r.mimeType, size,
    md5Checksum: typeof r.md5Checksum === "string" ? r.md5Checksum : null,
    trashed: r.trashed === true,
    parents: Array.isArray(r.parents) ? r.parents.filter((p): p is string => typeof p === "string") : [],
  }
}

export class FetchDriveApiClient implements DriveApiClient {
  constructor(private readonly fetchImpl: FetchLike = (input, init) => fetch(input, init)) {}

  private async call(accessToken: string, url: string, init: RequestInit): Promise<Response> {
    let response: Response
    try {
      response = await this.fetchImpl(url, { ...init, headers: { ...(init.headers as Record<string, string> | undefined), Authorization: `Bearer ${accessToken}` } })
    } catch {
      throw new DriveProviderError("DRIVE_UNAVAILABLE", 502, true)
    }
    if (!response.ok) throw mapDriveHttpError(response.status, await readGoogleErrorReason(response))
    return response
  }

  private async json(response: Response): Promise<unknown> {
    try { return await response.json() } catch { throw new DriveProviderError("DRIVE_INVALID_RESPONSE", 502, false) }
  }

  async generateIds(accessToken: string, count: number): Promise<string[]> {
    const n = Math.max(1, Math.min(1000, Math.floor(count)))
    const params = new URLSearchParams({ count: String(n), space: "drive", type: "files" })
    const response = await this.call(accessToken, `${DRIVE_BASE}/files/generateIds?${params}`, { method: "GET" })
    const body = (await this.json(response)) as { ids?: unknown }
    if (!Array.isArray(body.ids) || body.ids.length === 0 || !body.ids.every((id) => typeof id === "string" && id.length > 0)) {
      throw new DriveProviderError("DRIVE_INVALID_RESPONSE", 502, false)
    }
    return body.ids as string[]
  }

  async createFolder(accessToken: string, input: CreateFolderInput): Promise<DriveFileMetadata> {
    const metadata: Record<string, unknown> = { id: input.id, name: input.name, mimeType: DRIVE_FOLDER_MIME }
    if (input.parentId) metadata.parents = [input.parentId]
    const response = await this.call(accessToken, `${DRIVE_BASE}/files?fields=${encodeURIComponent(FIELDS)}`, {
      method: "POST", headers: { "Content-Type": "application/json; charset=UTF-8" }, body: JSON.stringify(metadata),
    })
    return toMetadata(await this.json(response))
  }

  async createFile(accessToken: string, input: CreateFileInput): Promise<DriveFileMetadata> {
    const boundary = `planificator_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`
    const metadata = JSON.stringify({ id: input.id, name: input.name, parents: [input.parentId], mimeType: input.mimeType, appProperties: input.appProperties })
    const encoder = new TextEncoder()
    const head = encoder.encode(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n--${boundary}\r\nContent-Type: ${input.mimeType}\r\n\r\n`)
    const tail = encoder.encode(`\r\n--${boundary}--`)
    const body = new Uint8Array(head.byteLength + input.bytes.byteLength + tail.byteLength)
    body.set(head, 0); body.set(input.bytes, head.byteLength); body.set(tail, head.byteLength + input.bytes.byteLength)
    const params = new URLSearchParams({ uploadType: "multipart", fields: FIELDS })
    const response = await this.call(accessToken, `${DRIVE_UPLOAD_BASE}/files?${params}`, {
      method: "POST", headers: { "Content-Type": `multipart/related; boundary=${boundary}` }, body,
    })
    return toMetadata(await this.json(response))
  }

  async getFile(accessToken: string, fileId: string): Promise<DriveFileMetadata> {
    const response = await this.call(accessToken, `${DRIVE_BASE}/files/${encodeURIComponent(fileId)}?fields=${encodeURIComponent(FIELDS)}`, { method: "GET" })
    return toMetadata(await this.json(response))
  }

  async trashFile(accessToken: string, fileId: string): Promise<void> {
    await this.call(accessToken, `${DRIVE_BASE}/files/${encodeURIComponent(fileId)}?fields=id,trashed`, {
      method: "PATCH", headers: { "Content-Type": "application/json; charset=UTF-8" }, body: JSON.stringify({ trashed: true }),
    })
  }

  async deleteFile(accessToken: string, fileId: string): Promise<void> {
    await this.call(accessToken, `${DRIVE_BASE}/files/${encodeURIComponent(fileId)}`, { method: "DELETE" })
  }
}

export const fetchDriveApiClient: DriveApiClient = new FetchDriveApiClient()
