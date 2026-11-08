/**
 * Téléchargement d'un document RH côté navigateur, sans dépendance serveur (pas de node:crypto, pas de zod) :
 * importable par un composant client. N'accepte qu'une réponse 200 non redirigée dont le type est l'un des types
 * déjà servis par la route (KIND_MIME) ; tout le reste devient un message lisible, et aucun fichier n'est fabriqué.
 */
export const HR_DOWNLOAD_MIME = ["application/pdf", "image/jpeg", "image/png", "image/heic"] as const

const EXTENSION: Record<(typeof HR_DOWNLOAD_MIME)[number], string> = {
  "application/pdf": "pdf", "image/jpeg": "jpg", "image/png": "png", "image/heic": "heic",
}

export const HR_DOWNLOAD_MESSAGES = {
  session: "Votre session a expiré. Reconnectez-vous puis relancez le téléchargement.",
  network: "Téléchargement impossible : la connexion au serveur a échoué. Réessayez.",
  unexpected: "Le serveur n’a pas renvoyé de document. Aucun fichier n’a été enregistré.",
  unavailable: "Téléchargement indisponible.",
} as const

export type HrDownload = { blob: Blob; name: string; mime: (typeof HR_DOWNLOAD_MIME)[number] }
type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

function mimeOf(response: Response): string {
  return (response.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase()
}

export async function fetchHrDocument(id: string, fetchImpl: FetchLike = (input, init) => fetch(input, init)): Promise<HrDownload> {
  let response: Response
  try {
    response = await fetchImpl(`/api/hr-documents/${encodeURIComponent(id)}/download`, { cache: "no-store", credentials: "same-origin" })
  } catch {
    throw new Error(HR_DOWNLOAD_MESSAGES.network)
  }
  // Une redirection (session expirée vers la connexion, par exemple) n'est jamais un document.
  if (response.redirected || response.type === "opaqueredirect") throw new Error(HR_DOWNLOAD_MESSAGES.session)
  const mime = mimeOf(response)
  if (!response.ok) {
    if (mime === "application/json") {
      const data = (await response.json().catch(() => ({}))) as { error?: unknown }
      throw new Error(typeof data.error === "string" && data.error ? data.error : HR_DOWNLOAD_MESSAGES.unavailable)
    }
    throw new Error(response.status === 401 || response.status === 403 || mime === "text/html" ? HR_DOWNLOAD_MESSAGES.session : HR_DOWNLOAD_MESSAGES.unavailable)
  }
  if (!(HR_DOWNLOAD_MIME as readonly string[]).includes(mime)) {
    throw new Error(mime === "text/html" ? HR_DOWNLOAD_MESSAGES.session : HR_DOWNLOAD_MESSAGES.unexpected)
  }
  const allowed = mime as (typeof HR_DOWNLOAD_MIME)[number]
  const name = /filename="([^"]+)"/.exec(response.headers.get("content-disposition") ?? "")?.[1] ?? `document.${EXTENSION[allowed]}`
  let blob: Blob
  try { blob = await response.blob() } catch { throw new Error(HR_DOWNLOAD_MESSAGES.network) }
  return { blob, name, mime: allowed }
}
