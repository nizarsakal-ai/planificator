import { MileageDomainError } from "./mileage-domain"

/** Serialize a genuine scheme/host origin without collapsing custom schemes to `null`. */
function serializedOrigin(value: string): string | null {
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
export function assertMutationOrigin(request: Request, code = "INVALID_ORIGIN", env: NodeJS.ProcessEnv = process.env): void {
  const refuse = (): never => { throw new MileageDomainError(code, 403) }
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
