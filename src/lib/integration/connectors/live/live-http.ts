/**
 * PLAN-INTEGRATION-PLATFORM-001 — LOT-8B : client HTTP borné des connexions réelles (SECURITY-SPEC §17, §24, §25).
 *
 * - HTTPS seulement, vers l'hôte FIXE du service (jamais une URL reçue) ; aucune redirection suivie.
 * - Délai et taille de réponse bornés.
 * - Erreurs = codes stables du lot F : 401/403 → AUTH_FAILED, 429 → RATE_LIMITED, tout autre écart → SOURCE_UNAVAILABLE.
 *   Ni le corps de la réponse, ni les en-têtes, ni l'URL complète ne sont journalisés ou renvoyés.
 * - Correctif du 22/11/2026 : la borne de taille est appliquée PENDANT la lecture (taille annoncée refusée d'emblée, flux
 *   coupé dès le dépassement), et non plus après avoir tout chargé en mémoire. Les en-têtes de réponse peuvent être lus
 *   par la source (seau de débit Shopify), jamais journalisés.
 */
import { ConnectorSourceError } from "@/lib/connectors/connectors.core"

export interface LiveResponse {
  status: number
  /** Corps lu dans la limite de `maxBytes` octets ; au-delà, la lecture est coupée et une erreur levée. */
  text(maxBytes: number): Promise<string>
  /** En-tête de réponse (facultatif pour les doubles de test). */
  header?(name: string): string | null
}
export type FetchLike = (input: string, init: { method: string; headers: Record<string, string>; redirect: "manual"; signal: AbortSignal }) => Promise<LiveResponse>

export const LIVE_TIMEOUT_MS = 15_000
export const LIVE_MAX_RESPONSE_BYTES = 2_000_000
const HOST = /^[a-z0-9.-]{3,253}$/

export interface LiveRequest {
  host: string; path: string; query?: Record<string, string | number | undefined>; headers: Record<string, string>
  /** Lecture d'en-têtes de réponse non secrets (ex. seau de débit), appelée sur une réponse 2xx. */
  onHeaders?: (header: (name: string) => string | null) => void
}

export function buildLiveUrl(req: LiveRequest): string {
  if (!HOST.test(req.host) || !req.path.startsWith("/") || req.path.includes("//") || req.path.includes("..")) throw new ConnectorSourceError("SOURCE_UNAVAILABLE")
  const u = new URL(`https://${req.host}${req.path}`)
  for (const [k, v] of Object.entries(req.query ?? {})) if (v !== undefined) u.searchParams.set(k, String(v))
  if (u.protocol !== "https:" || u.hostname !== req.host) throw new ConnectorSourceError("SOURCE_UNAVAILABLE")
  return u.toString()
}

/** GET JSON borné ; la réponse est un objet JSON ou une erreur à code stable. */
export async function liveGetJson(fetchImpl: FetchLike, req: LiveRequest): Promise<Record<string, unknown>> {
  const url = buildLiveUrl(req)
  let res: LiveResponse
  try {
    res = await fetchImpl(url, { method: "GET", headers: { accept: "application/json", ...req.headers }, redirect: "manual", signal: AbortSignal.timeout(LIVE_TIMEOUT_MS) })
  } catch {
    throw new ConnectorSourceError("SOURCE_UNAVAILABLE")
  }
  if (res.status === 401 || res.status === 403) throw new ConnectorSourceError("AUTH_FAILED")
  if (res.status === 429) throw new ConnectorSourceError("RATE_LIMITED")
  // LOT-8C : 410 (jeton de synchronisation Google périmé) ⇒ curseur à reprendre de zéro, jamais une panne.
  if (res.status === 410) throw new ConnectorSourceError("WATERMARK_INVALID")
  if (res.status < 200 || res.status > 299) throw new ConnectorSourceError("SOURCE_UNAVAILABLE")
  req.onHeaders?.((name) => res.header?.(name) ?? null)
  let body: string
  try { body = await res.text(LIVE_MAX_RESPONSE_BYTES) } catch { throw new ConnectorSourceError("SOURCE_UNAVAILABLE") }
  if (Buffer.byteLength(body, "utf8") > LIVE_MAX_RESPONSE_BYTES) throw new ConnectorSourceError("SOURCE_UNAVAILABLE")
  let json: unknown
  try { json = JSON.parse(body) } catch { throw new ConnectorSourceError("SOURCE_UNAVAILABLE") }
  if (json === null || typeof json !== "object" || Array.isArray(json)) throw new ConnectorSourceError("SOURCE_UNAVAILABLE")
  return json as Record<string, unknown>
}

/** Adaptateur du `fetch` natif vers le contrat borné (seul point d'appel réseau des connexions réelles). */
export const nativeFetch: FetchLike = async (input, init) => {
  const r = await fetch(input, { ...init, cache: "no-store", credentials: "omit" })
  return { status: r.status, header: (name) => r.headers.get(name), text: (maxBytes) => readBounded(r, maxBytes) }
}

/** Lit un corps de réponse au fil de l'eau en coupant dès que `maxBytes` est dépassé (jamais tout en mémoire d'abord). */
export async function readBounded(r: Response, maxBytes: number): Promise<string> {
  const declared = Number(r.headers.get("content-length") ?? "")
  if (Number.isFinite(declared) && declared > maxBytes) {
    await r.body?.cancel().catch(() => undefined)
    throw new ConnectorSourceError("SOURCE_UNAVAILABLE")
  }
  if (!r.body) return ""
  const reader = r.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined)
      throw new ConnectorSourceError("SOURCE_UNAVAILABLE")
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString("utf8")
}
