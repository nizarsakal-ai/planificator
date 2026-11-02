import { FetchDriveApiClient, type DriveApiClient } from "@/lib/worksite-photos/drive/drive-api.client"
import { assertContent, HrError, MAX_PDF_BYTES } from "./domain"

export interface PrivateDrive {
  allocate(): Promise<string>
  checkPrivate(fileId: string, parentId?: string): Promise<void>
  createRoot(id: string): Promise<void>
  put(id: string, rootId: string, bytes: Uint8Array): Promise<void>
  read(id: string): Promise<Uint8Array>
}
export async function boundedBytes(stream: ReadableStream<Uint8Array>, limit = MAX_PDF_BYTES): Promise<Uint8Array> {
  const reader = stream.getReader(); const parts: Uint8Array[] = []; let size = 0
  try {
    while (true) {
      const {value, done} = await reader.read(); if (done) break
      size += value.length
      if (size > limit) { await reader.cancel(); throw new HrError("INVALID_PDF") }
      parts.push(value)
    }
  } finally { reader.releaseLock() }
  return Buffer.concat(parts)
}
/** No sharing, trash or delete operation is exposed by the RH adapter. */
export class GooglePrivateDrive implements PrivateDrive {
  constructor(private readonly token: string, private readonly account: string,
    private readonly api: DriveApiClient = new FetchDriveApiClient((url,init)=>fetch(url,{...init,cache:"no-store",signal:AbortSignal.timeout(30_000)})),
    private readonly fetcher: typeof fetch = fetch) {}
  async allocate() { return (await this.api.generateIds(this.token,1))[0] }
  async checkPrivate(id: string, parentId?: string) {
    const metadata = await this.api.getFile(this.token,id)
    if (metadata.trashed || (parentId && !metadata.parents.includes(parentId))) throw new HrError("DRIVE_PRIVATE_REQUIRED",409)
    if (!parentId && metadata.mimeType !== "application/vnd.google-apps.folder") throw new HrError("DRIVE_PRIVATE_REQUIRED",409)
    let page: string | undefined; let owners = 0
    for (let i=0; i<10; i++) {
      const params = new URLSearchParams({fields:"permissions(type,role,emailAddress,deleted),nextPageToken",pageSize:"100"})
      if (page) params.set("pageToken",page)
      const response = await this.fetcher(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}/permissions?${params}`, {
        headers:{Authorization:`Bearer ${this.token}`}, cache:"no-store", signal:AbortSignal.timeout(20_000),
      })
      if (!response.ok) throw new HrError("DRIVE_UNAVAILABLE",503)
      const body = await response.json() as {permissions?:{type?:string;role?:string;emailAddress?:string;deleted?:boolean}[];nextPageToken?:string}
      if (!Array.isArray(body.permissions) || !body.permissions.length) throw new HrError("DRIVE_PRIVATE_REQUIRED",409)
      for (const p of body.permissions) {
        if (p.deleted || p.type!=="user" || p.role!=="owner" || p.emailAddress?.toLowerCase()!==this.account) throw new HrError("DRIVE_PRIVATE_REQUIRED",409)
        owners++
      }
      page=body.nextPageToken
      if (!page) { if (owners!==1) throw new HrError("DRIVE_PRIVATE_REQUIRED",409); return }
    }
    throw new HrError("DRIVE_PRIVATE_REQUIRED",409)
  }
  async createRoot(id:string) {
    try { await this.api.createFolder(this.token,{id,name:"Planificator-RH-Prive",parentId:null}) }
    catch(e) { if (!(e instanceof Error && "code" in e && e.code==="DRIVE_ID_EXISTS")) throw e }
    await this.checkPrivate(id)
  }
  async put(id:string,rootId:string,bytes:Uint8Array) {
    await this.checkPrivate(rootId)
    try { await this.api.createFile(this.token,{id,name:`${id}.pdf`,parentId:rootId,mimeType:"application/pdf",bytes,appProperties:{module:"hr-documents"}}) }
    catch(e) { if (!(e instanceof Error && "code" in e && e.code==="DRIVE_ID_EXISTS")) throw e }
    await this.checkPrivate(id,rootId)
  }
  async read(id:string) {
    const download = await this.api.downloadFile(this.token,id)
    if (download.contentLength!==null && download.contentLength>MAX_PDF_BYTES) { await download.stream.cancel(); throw new HrError("INVALID_PDF") }
    return boundedBytes(download.stream)
  }
}
/** Check the actual bytes before releasing any to the client (no metadata/stream TOCTOU). */
export async function verifiedDownload(drive: PrivateDrive, doc:{driveFileId:string;rootId:string;sha256:string;size:number}) {
  await drive.checkPrivate(doc.rootId)
  await drive.checkPrivate(doc.driveFileId,doc.rootId)
  const bytes = await drive.read(doc.driveFileId)
  assertContent(bytes,doc.sha256,doc.size)
  await drive.checkPrivate(doc.rootId)
  await drive.checkPrivate(doc.driveFileId,doc.rootId)
  return bytes
}
