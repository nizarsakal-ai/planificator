/**
 * Contrôle d'origine des requêtes mutantes — helper partagé (déplacé depuis `src/lib/vehicules/request-origin.ts`,
 * comportement inchangé ; Véhicules conserve son chemin d'import via ré-export avec `MileageDomainError`).
 *
 * Règle : l'en-tête `Origin` réel est obligatoire ; il doit être égal à l'origine servie (alors `Sec-Fetch-Site`,
 * s'il est présent, doit valoir `same-origin`), ou figurer dans `PLANIFICATOR_TRUSTED_ORIGINS` (coque Capacitor).
 * Les en-têtes de transfert (`X-Forwarded-*`) ne confèrent aucune autorité.
 */
import { HttpGuardError, rejectWithHttpGuardError, type RejectFn } from "./guard-error"

/** Serialize a genuine scheme/host origin without collapsing custom schemes to `null`. */
export function serializedOrigin(value: string): string | null {
  if (!value || /[\s,\\]/.test(value)) return null
  try {
    const url = new URL(value)
    if (!url.host || url.username || url.password || url.search || url.hash || !["", "/"].includes(url.pathname)) return null
    const result = `${url.protocol}//${url.host}`
    // Origin headers contain no path (even a trailing slash), unlike an ordinary URL.
    return value === result ? result : null
  } catch { return null }
}

/** Shared mutation admission: actual Origin required; forwarding hints never grant authority. */
export function assertMutationOrigin(
  request: Request,
  code = "INVALID_ORIGIN",
  env: NodeJS.ProcessEnv = process.env,
  reject: RejectFn = rejectWithHttpGuardError,
): void {
  // Fail-closed : si un `reject` fourni ne lève pas, on lève quand même (jamais d'admission silencieuse).
  const refuse = (): never => { reject(code, 403); throw new HttpGuardError(code, 403) }
  const publicUrl = new URL(request.url), host = request.headers.get("host")
  let servedOrigin: string
  if (host !== null) {
    if (!host || /[\s,\\/?#@]/.test(host)) return refuse()
    try {
      const served = new URL(`${publicUrl.protocol}//${host}`)
      if (!served.host || served.username || served.password) return refuse()
      servedOrigin = `${served.protocol}//${served.host}`
    } catch { return refuse() }
  } else {
    const serialized = serializedOrigin(publicUrl.origin)
    if (!serialized) return refuse()
    servedOrigin = serialized
  }
  const origin = request.headers.get("origin")
  if (!origin || !serializedOrigin(origin)) return refuse()
  if (origin === servedOrigin) {
    const site = request.headers.get("sec-fetch-site")
    if (site && site !== "same-origin") return refuse()
    return
  }
  const trusted = (env.PLANIFICATOR_TRUSTED_ORIGINS ?? "").split(",").map(value => serializedOrigin(value.trim())).filter((value): value is string => value !== null)
  if (!trusted.includes(origin)) return refuse()
}
