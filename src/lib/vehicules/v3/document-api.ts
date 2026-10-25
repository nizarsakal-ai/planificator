/**
 * Véhicules V3 Lot 1 — adaptateurs HTTP testables du service documentaire.
 * Les routes Next injectent `deps` ; aucune connexion globale ici.
 */
import { MileageDomainError } from "../mileage-domain"
import { getVehicleDocumentMaxBytes } from "./document-domain"
import {
  authorizeDocumentWriteBeforeBody, authorizeReminderSettingsBeforeBody, archiveVehicleDocument, listVehicleDocuments, openVehicleDocumentFile, readReminderSettings, readVehicleDocument,
  replaceVehicleDocument, updateReminderSettings, uploadVehicleDocument, verifyVehicleDocumentVersion,
  type DocumentFileInput, type DocumentServiceDeps,
} from "./document-service"
import { idempotencyKeyOf, readV3BodyBytes, v3Json, v3JsonBody, v3Route, V3_HEADERS } from "./v3-http"

/** Marge d'en-têtes multipart au-delà de la taille maximale du fichier. */
const MULTIPART_OVERHEAD = 64 * 1024

/**
 * Lit un envoi multipart : champ `file` (fichier) et champ `payload` (JSON de la commande).
 * La taille annoncée est bornée avant toute lecture du corps.
 */
export async function readDocumentMultipart(request: Request, env: NodeJS.ProcessEnv = process.env): Promise<{ body: unknown; file: DocumentFileInput }> {
  const maxBytes = getVehicleDocumentMaxBytes(env)
  const contentType = request.headers.get("content-type") ?? ""
  if (!contentType.toLowerCase().startsWith("multipart/form-data")) throw new MileageDomainError("INVALID_PAYLOAD", 400)
  let form: FormData
  try { const bytes = await readV3BodyBytes(request, maxBytes + MULTIPART_OVERHEAD, "DOCUMENT_FILE_TOO_LARGE"); form = await new Response(new Uint8Array(bytes), { headers: { "Content-Type": contentType } }).formData() } catch (error) { if (error instanceof MileageDomainError) throw error; throw new MileageDomainError("INVALID_PAYLOAD", 400) }
  if (form.getAll("file").length !== 1 || form.getAll("payload").length !== 1 || [...form.keys()].some(key => !["file", "payload"].includes(key))) throw new MileageDomainError("INVALID_PAYLOAD", 400)
  const file = form.get("file")
  const payload = form.get("payload")
  if (!(file instanceof File) || typeof payload !== "string") throw new MileageDomainError("INVALID_PAYLOAD", 400)
  if (new TextEncoder().encode(payload).byteLength > 32 * 1024) throw new MileageDomainError("PAYLOAD_TOO_LARGE", 413)
  if (file.size > maxBytes) throw new MileageDomainError("DOCUMENT_FILE_TOO_LARGE", 413)
  let body: unknown
  try { body = JSON.parse(payload) } catch { throw new MileageDomainError("INVALID_JSON", 400) }
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new MileageDomainError("INVALID_PAYLOAD", 400)
  const bytes = new Uint8Array(await file.arrayBuffer())
  return { body, file: { filename: file.name, declaredMimeType: file.type, bytes } }
}

export function handleDocumentsGet(request: Request, truckId: string, deps: DocumentServiceDeps) {
  return v3Route(request, async () => v3Json(await listVehicleDocuments(truckId, deps)))
}

export function handleDocumentUpload(request: Request, truckId: string, deps: DocumentServiceDeps) {
  return v3Route(request, async () => {
    await authorizeDocumentWriteBeforeBody(truckId, null, deps)
    const { body, file } = await readDocumentMultipart(request, deps.env)
    const result = await uploadVehicleDocument(truckId, body, file, idempotencyKeyOf(request), deps)
    return v3Json(result.receipt, { status: 201, headers: { "Idempotency-Replayed": String(result.replayed) } })
  })
}

export function handleDocumentGet(request: Request, truckId: string, documentId: string, deps: DocumentServiceDeps) {
  return v3Route(request, async () => v3Json(await readVehicleDocument(truckId, documentId, deps)))
}

export function handleDocumentReplace(request: Request, truckId: string, documentId: string, deps: DocumentServiceDeps) {
  return v3Route(request, async () => {
    await authorizeDocumentWriteBeforeBody(truckId, documentId, deps)
    const { body, file } = await readDocumentMultipart(request, deps.env)
    const result = await replaceVehicleDocument(truckId, documentId, body, file, idempotencyKeyOf(request), deps)
    return v3Json(result.receipt, { status: 201, headers: { "Idempotency-Replayed": String(result.replayed) } })
  })
}

export function handleDocumentVerify(request: Request, truckId: string, documentId: string, deps: DocumentServiceDeps) {
  return v3Route(request, async () => { await authorizeDocumentWriteBeforeBody(truckId, documentId, deps, { requireActiveTruck: false }); return v3Json(await verifyVehicleDocumentVersion(truckId, documentId, await v3JsonBody(request), deps)) })
}

export function handleDocumentArchive(request: Request, truckId: string, documentId: string, deps: DocumentServiceDeps) {
  return v3Route(request, async () => { await authorizeDocumentWriteBeforeBody(truckId, documentId, deps, { requireActiveTruck: false, allowArchivedDocument: true }); return v3Json(await archiveVehicleDocument(truckId, documentId, await v3JsonBody(request), deps)) })
}

/** Proxy privé : flux du stockage, en-têtes sans cache partagé ni hors ligne, nom encodé. */
export function handleDocumentFile(request: Request, truckId: string, documentId: string, versionId: string, deps: DocumentServiceDeps) {
  return v3Route(request, async () => {
    const mode = new URL(request.url).searchParams.get("dl") === "1" ? "DOWNLOAD" : "VIEW"
    const file = await openVehicleDocumentFile(truckId, documentId, versionId, mode, deps)
    const headers: Record<string, string> = {
      ...V3_HEADERS,
      "Content-Type": file.mimeType,
      "Content-Disposition": `${mode === "DOWNLOAD" ? "attachment" : "inline"}; filename*=UTF-8''${encodeURIComponent(file.filename)}`,
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox",
      "Referrer-Policy": "no-referrer",
    }
    if (file.contentLength != null) headers["Content-Length"] = String(file.contentLength)
    return new Response(file.stream, { status: 200, headers })
  })
}

export function handleReminderSettingsGet(request: Request, deps: DocumentServiceDeps) {
  return v3Route(request, async () => v3Json(await readReminderSettings(deps)))
}

export function handleReminderSettingsPut(request: Request, deps: DocumentServiceDeps) {
  return v3Route(request, async () => { await authorizeReminderSettingsBeforeBody(deps); return v3Json(await updateReminderSettings(await v3JsonBody(request), deps)) })
}
