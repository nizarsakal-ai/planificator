/**
 * Photos d'engins — erreurs typées du fournisseur Google Drive (SPEC-WORKSITE-PHOTOS-001 §6.4, §7.5).
 * Codes stables, jamais d'URL signée, de jeton ni de corps de réponse brut dans les messages.
 */
export type DriveErrorCode =
  | "DRIVE_NOT_CONNECTED"   // aucune connexion active pour l'entreprise, ou refresh refusé (invalid_grant)
  | "DRIVE_UNAUTHORIZED"    // jeton d'accès refusé par Drive (401) ; un refresh est tenté une fois
  | "DRIVE_FORBIDDEN"       // 403 autre que le quota (droits du scope drive.file, fichier non créé par l'app)
  | "DRIVE_QUOTA_EXCEEDED"  // 403 storageQuotaExceeded
  | "DRIVE_NOT_FOUND"       // 404
  | "DRIVE_ID_EXISTS"       // 409 « a file already exists with the provided ID » (création idempotente, D15), raison reconnue SEULEMENT
  | "DRIVE_CONFLICT"        // 409 d'une autre raison ou sans corps : jamais pris pour une création acquise (L2-R5)
  | "DRIVE_OAUTH_MISCONFIGURED"  // point de jeton : invalid_client / unauthorized_client (configuration), non réessayable
  | "DRIVE_OAUTH_PROTOCOL_ERROR" // point de jeton : invalid_request, autre 4xx, réponse illisible, non réessayable
  | "DRIVE_RATE_LIMITED"    // 429 / 403 rateLimitExceeded
  | "DRIVE_UNAVAILABLE"     // 5xx, réseau, réponse illisible
  | "DRIVE_INVALID_RESPONSE" // réponse 2xx sans les champs attendus

export class DriveProviderError extends Error {
  constructor(
    readonly code: DriveErrorCode,
    readonly status: number,
    readonly retryable: boolean,
    readonly httpStatus: number | null = null,
    readonly reason: string | null = null,
  ) {
    super(code)
    this.name = "DriveProviderError"
  }
}

interface GoogleErrorBody {
  error?: { code?: number; message?: string; errors?: Array<{ reason?: string; message?: string }>; status?: string }
}

/** Lit la raison Google sans jamais conserver le message complet (qui peut contenir des identifiants). */
export async function readGoogleErrorReason(response: Response): Promise<string | null> {
  try {
    const body = (await response.json()) as GoogleErrorBody
    const reason = body.error?.errors?.[0]?.reason ?? body.error?.status ?? null
    const message = body.error?.message ?? ""
    if (/already exists with the provided ID/i.test(message)) return "fileIdAlreadyExists"
    return reason
  } catch {
    return null
  }
}

/** Correspondance statut HTTP Drive → code de domaine (statut HTTP renvoyé par nos routes). */
export function mapDriveHttpError(httpStatus: number, reason: string | null): DriveProviderError {
  if (httpStatus === 401) return new DriveProviderError("DRIVE_UNAUTHORIZED", 503, true, httpStatus, reason)
  if (httpStatus === 403) {
    if (reason === "storageQuotaExceeded") return new DriveProviderError("DRIVE_QUOTA_EXCEEDED", 503, false, httpStatus, reason)
    if (reason === "rateLimitExceeded" || reason === "userRateLimitExceeded") return new DriveProviderError("DRIVE_RATE_LIMITED", 503, true, httpStatus, reason)
    return new DriveProviderError("DRIVE_FORBIDDEN", 502, false, httpStatus, reason)
  }
  if (httpStatus === 404) return new DriveProviderError("DRIVE_NOT_FOUND", 404, false, httpStatus, reason)
  // Seule la collision d'identifiant reconnue vaut « déjà créé » ; tout autre 409 est un échec explicite (L2-R5).
  if (httpStatus === 409) return reason === "fileIdAlreadyExists"
    ? new DriveProviderError("DRIVE_ID_EXISTS", 409, false, httpStatus, reason)
    : new DriveProviderError("DRIVE_CONFLICT", 409, false, httpStatus, reason)
  if (httpStatus === 429) return new DriveProviderError("DRIVE_RATE_LIMITED", 503, true, httpStatus, reason)
  return new DriveProviderError("DRIVE_UNAVAILABLE", 502, httpStatus >= 500, httpStatus, reason)
}
