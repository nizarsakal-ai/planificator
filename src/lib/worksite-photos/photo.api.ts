/**
 * Photos d'engins — adaptateurs HTTP testables des routes ouvriers (SPEC-WORKSITE-PHOTOS-001 §6.1).
 * Les routes Next injectent `deps`. Enveloppe commune : drapeau (404), origine des mutations, erreurs normalisées
 * `{ code, error }` sans détail interne, réponses privées non mises en cache.
 */
import { HttpGuardError } from "@/lib/http/guard-error"
import { readBoundedBodyBytes } from "@/lib/http/bounded-body"
import { assertMutationOrigin } from "@/lib/http/request-origin"
import { DriveProviderError } from "./drive/drive.errors"
import { isWorksitePhotosEnabled } from "./feature-flag"
import { MULTIPART_OVERHEAD_BYTES, PAYLOAD_MAX_BYTES, WorksitePhotoDomainError, getPhotoMaxBytes } from "./photo.domain"
import { authorizeUploadTarget, listPhotos, listUploadContext, openPhotoFile, uploadPhoto, type PhotoServiceDeps, type PhotoSession } from "./photo.service"

export interface PhotoApiDeps extends PhotoServiceDeps {
  auth: () => Promise<PhotoSession | null>
}

export const PRIVATE_HEADERS: Record<string, string> = { "Cache-Control": "private, no-store", Vary: "Cookie" }

export function photoJson(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}): Response {
  return Response.json(body, { status: init.status ?? 200, headers: { ...PRIVATE_HEADERS, ...init.headers } })
}

const PUBLIC_MESSAGES: Record<string, string> = {
  UNAUTHENTICATED: "Non autorisé", FORBIDDEN: "Accès refusé", INVALID_ORIGIN: "Accès refusé", FEATURE_DISABLED: "Introuvable",
  WORKSITE_NOT_FOUND: "Chantier introuvable", TRUCK_NOT_FOUND: "Engin introuvable", PHOTO_NOT_FOUND: "Photo introuvable", PHOTO_FILE_MISSING: "Fichier introuvable",
  WORKSITE_ARCHIVED: "Chantier archivé", TRUCK_ARCHIVED: "Engin archivé",
  UPLOAD_IN_PROGRESS: "Envoi déjà en cours, réessayez dans un instant", UPLOAD_SUPERSEDED: "Envoi repris par une autre tentative, réessayez", UPLOAD_ABORTED: "Envoi abandonné, recommencez la prise de photo",
  IDEMPOTENCY_CONFLICT: "Clé d'envoi déjà utilisée pour un autre fichier", IDEMPOTENCY_KEY_REQUIRED: "Clé d'envoi manquante",
  PHOTO_FILE_TOO_LARGE: "Photo trop volumineuse", PHOTO_TYPE_NOT_ALLOWED: "Format non accepté (JPEG ou PNG)", PHOTO_TYPE_MISMATCH: "Format incohérent", PHOTO_FILE_EMPTY: "Fichier vide",
  PHOTO_CHECKSUM_MISMATCH: "Fichier altéré pendant l'envoi, réessayez", PHOTO_FILENAME_INVALID: "Nom de fichier invalide", PAYLOAD_MISMATCH: "Chantier ou engin incohérent", INVALID_PAYLOAD: "Requête invalide", INVALID_JSON: "Requête invalide",
  INVALID_CONTENT_LENGTH: "Requête invalide", PAYLOAD_TOO_LARGE: "Requête trop volumineuse",
  DRIVE_NOT_CONNECTED: "Stockage non connecté : prévenez votre responsable", DRIVE_QUOTA_EXCEEDED: "Espace de stockage plein : prévenez votre responsable",
  DRIVE_UNAVAILABLE: "Stockage indisponible, réessayez", DRIVE_RATE_LIMITED: "Stockage saturé, réessayez dans un instant", DRIVE_FORBIDDEN: "Stockage refusé : prévenez votre responsable",
  DRIVE_UNAUTHORIZED: "Stockage indisponible, réessayez", DRIVE_INVALID_RESPONSE: "Stockage indisponible, réessayez", DRIVE_NOT_FOUND: "Fichier introuvable", DRIVE_ID_EXISTS: "Stockage indisponible, réessayez",
  DRIVE_CONFLICT: "Conflit de stockage : reprenez la photo", DRIVE_OAUTH_MISCONFIGURED: "Stockage mal configuré : prévenez votre responsable", DRIVE_OAUTH_PROTOCOL_ERROR: "Stockage indisponible : prévenez votre responsable",
}

export function photoFailure(error: unknown, log: (event: string, payload?: Record<string, unknown>) => void = () => undefined): Response {
  if (error instanceof WorksitePhotoDomainError || error instanceof DriveProviderError || error instanceof HttpGuardError) {
    const retryAfter = error instanceof WorksitePhotoDomainError && error.code === "UPLOAD_IN_PROGRESS" ? { "Retry-After": "5" } : {}
    if (error instanceof DriveProviderError) log("DRIVE_ERROR", { code: error.code, httpStatus: error.httpStatus, reason: error.reason })
    return photoJson({ code: error.code, error: PUBLIC_MESSAGES[error.code] ?? "Opération refusée" }, { status: error.status, headers: retryAfter })
  }
  log("SERVER_ERROR", { name: error instanceof Error ? error.name : typeof error })
  return photoJson({ code: "SERVER_ERROR", error: "Erreur serveur" }, { status: 500 })
}

function defaultLog(event: string, payload?: Record<string, unknown>): void {
  if (payload) console.warn(`[worksite-photos] ${event}`, payload)
  else console.warn(`[worksite-photos] ${event}`)
}

/** Enveloppe standard : drapeau, origine pour les mutations, erreurs normalisées. */
export async function photoRoute(request: Request, deps: PhotoApiDeps, handler: () => Promise<Response>): Promise<Response> {
  const env = deps.env ?? process.env
  try {
    if (!isWorksitePhotosEnabled(env)) throw new WorksitePhotoDomainError("FEATURE_DISABLED", 404)
    if (!["GET", "HEAD", "OPTIONS"].includes(request.method.toUpperCase())) assertMutationOrigin(request, "INVALID_ORIGIN", env)
    return await handler()
  } catch (error) {
    return photoFailure(error, defaultLog)
  }
}

/** Lit un envoi multipart (`file` + `payload`) borné : le flux réel est compté, `Content-Length` n'est jamais une preuve. */
export async function readPhotoMultipart(request: Request, env: NodeJS.ProcessEnv): Promise<{ payload: unknown; file: { filename: string; declaredMimeType: string; bytes: Uint8Array } }> {
  const maxBytes = getPhotoMaxBytes(env)
  const contentType = request.headers.get("content-type") ?? ""
  if (!contentType.toLowerCase().startsWith("multipart/form-data")) throw new WorksitePhotoDomainError("INVALID_PAYLOAD", 400)
  const reject = (code: string, status: number): never => { throw new WorksitePhotoDomainError(code, status) }
  let form: FormData
  try {
    const bytes = await readBoundedBodyBytes(request, maxBytes + MULTIPART_OVERHEAD_BYTES, { sizeCode: "PHOTO_FILE_TOO_LARGE", reject })
    form = await new Response(new Uint8Array(bytes), { headers: { "Content-Type": contentType } }).formData()
  } catch (error) {
    if (error instanceof WorksitePhotoDomainError) throw error
    throw new WorksitePhotoDomainError("INVALID_PAYLOAD", 400)
  }
  if (form.getAll("file").length !== 1 || form.getAll("payload").length !== 1 || [...form.keys()].some((key) => !["file", "payload"].includes(key))) {
    throw new WorksitePhotoDomainError("INVALID_PAYLOAD", 400)
  }
  const file = form.get("file"), payload = form.get("payload")
  if (!(file instanceof File) || typeof payload !== "string") throw new WorksitePhotoDomainError("INVALID_PAYLOAD", 400)
  if (new TextEncoder().encode(payload).byteLength > PAYLOAD_MAX_BYTES) throw new WorksitePhotoDomainError("PAYLOAD_TOO_LARGE", 413)
  if (file.size > maxBytes) throw new WorksitePhotoDomainError("PHOTO_FILE_TOO_LARGE", 413)
  let parsed: unknown
  try { parsed = JSON.parse(payload) } catch { throw new WorksitePhotoDomainError("INVALID_JSON", 400) }
  return { payload: parsed, file: { filename: file.name, declaredMimeType: file.type, bytes: new Uint8Array(await file.arrayBuffer()) } }
}

export function handleContextGet(request: Request, deps: PhotoApiDeps): Promise<Response> {
  return photoRoute(request, deps, async () => photoJson(await listUploadContext(await deps.auth(), deps)))
}

/** POST /api/worksite-photos/worksites/:worksiteId/trucks/:truckId — pré-autorisation AVANT lecture du corps (R3). */
export function handlePhotoUpload(request: Request, route: { worksiteId: string; truckId: string }, deps: PhotoApiDeps): Promise<Response> {
  return photoRoute(request, deps, async () => {
    let target
    try {
      target = await authorizeUploadTarget(await deps.auth(), route, deps)
    } catch (error) {
      // Refus avant lecture : le flux n'est pas consommé.
      if (request.body) await request.body.cancel().catch(() => undefined)
      throw error
    }
    const { payload, file } = await readPhotoMultipart(request, deps.env ?? process.env)
    const receipt = await uploadPhoto(target, file, payload, request.headers.get("idempotency-key"), deps)
    return photoJson({ photoId: receipt.photoId, status: receipt.status, drivePath: receipt.drivePath }, { status: 201, headers: { "Idempotency-Replayed": String(receipt.replayed) } })
  })
}

export function handlePhotosList(request: Request, deps: PhotoApiDeps): Promise<Response> {
  return photoRoute(request, deps, async () => {
    const url = new URL(request.url)
    return photoJson(await listPhotos(await deps.auth(), { worksiteId: url.searchParams.get("worksiteId"), cursor: url.searchParams.get("cursor"), limit: url.searchParams.get("limit") }, deps))
  })
}

/** Proxy privé du fichier : audit avant flux, en-têtes sans cache ni exécution. */
export function handlePhotoFile(request: Request, photoId: string, deps: PhotoApiDeps): Promise<Response> {
  return photoRoute(request, deps, async () => {
    const file = await openPhotoFile(await deps.auth(), photoId, deps)
    const headers: Record<string, string> = {
      ...PRIVATE_HEADERS,
      "Content-Type": file.mimeType,
      // RFC 5987 : `encodeURIComponent` laisse passer ' ( ) * qui ne sont pas des attr-char.
      "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(file.filename).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}`,
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox",
      "Referrer-Policy": "no-referrer",
    }
    if (file.contentLength != null) headers["Content-Length"] = String(file.contentLength)
    return new Response(file.stream, { status: 200, headers })
  })
}
