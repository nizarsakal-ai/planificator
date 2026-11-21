/**
 * PLAN-INTEGRATION-PLATFORM-001 — LOT-8B : client HTTP borné des connexions réelles (SECURITY-SPEC §17, §24, §25).
 *
 * - HTTPS seulement, vers l'hôte FIXE du service (jamais une URL reçue) ; aucune redirection suivie.
 * - Délai et taille de réponse bornés.
 * - Erreurs = codes stables du lot F : 401/403 → AUTH_FAILED, 429 → RATE_LIMITED, tout autre écart → SOURCE_UNAVAILABLE.
 *   Ni le corps de la réponse, ni les en-têtes, ni l'URL complète ne sont journalisés ou renvoyés.
 */
import { ConnectorSourceError } from "@/lib/connectors/connectors.core"

export type FetchLike = (input: string, init: { method: string; headers: Record<string, string>; redirect: "manual"; signal: AbortSignal }) => Promise<{ status: number; text(): Promise<string> }>

export const LIVE_TIMEOUT_MS = 15_000
export const LIVE_MAX_RESPONSE_BYTES = 2_000_000
const HOST = /^[a-z0-9.-]{3,253}$/

export interface LiveRequest { host: string; path: string; query?: Record<string, string | number | undefined>; headers: Record<string, string> }

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
  let res: { status: number; text(): Promise<string> }
  try {
    res = await fetchImpl(url, { method: "GET", headers: { accept: "application/json", ...req.headers }, redirect: "manual", signal: AbortSignal.timeout(LIVE_TIMEOUT_MS) })
  } catch {
    throw new ConnectorSourceError("SOURCE_UNAVAILABLE")
  }
  if (res.status === 401 || res.status === 403) throw new ConnectorSourceError("AUTH_FAILED")
  if (res.status === 429) throw new ConnectorSourceError("RATE_LIMITED")
  if (res.status < 200 || res.status > 299) throw new ConnectorSourceError("SOURCE_UNAVAILABLE")
  let body: string
  try { body = await res.text() } catch { throw new ConnectorSourceError("SOURCE_UNAVAILABLE") }
  if (Buffer.byteLength(body, "utf8") > LIVE_MAX_RESPONSE_BYTES) throw new ConnectorSourceError("SOURCE_UNAVAILABLE")
  let json: unknown
  try { json = JSON.parse(body) } catch { throw new ConnectorSourceError("SOURCE_UNAVAILABLE") }
  if (json === null || typeof json !== "object" || Array.isArray(json)) throw new ConnectorSourceError("SOURCE_UNAVAILABLE")
  return json as Record<string, unknown>
}

/** Adaptateur du `fetch` natif vers le contrat borné (seul point d'appel réseau des connexions réelles). */
export const nativeFetch: FetchLike = async (input, init) => {
  const r = await fetch(input, init)
  return { status: r.status, text: () => r.text() }
}
