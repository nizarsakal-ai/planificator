/**
 * PLAN-ACQ-V2 Lot G — Port géocodage (Nominatim).
 * Hors transaction métier. Échec non bloquant. Timeout AbortSignal.
 */

export type GeocodeResult = {
  latitude: number
  longitude: number
} | null

export interface GeocodePort {
  geocodeAddress(address: string): Promise<GeocodeResult>
}

const DEFAULT_TIMEOUT_MS = 5_000
const LOG_PREFIX = "[acquisition-geocode]"

export class NominatimGeocodeAdapter implements GeocodePort {
  constructor(
    private readonly fetchFn: typeof fetch = fetch,
    private readonly userAgent = "Planificator/1.0",
    private readonly timeoutMs = DEFAULT_TIMEOUT_MS
  ) {}

  async geocodeAddress(address: string): Promise<GeocodeResult> {
    const q = address.trim()
    if (!q) return null
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const geoRes = await this.fetchFn(
        `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=json&limit=1`,
        {
          headers: { "User-Agent": this.userAgent },
          signal: controller.signal,
        }
      )
      if (geoRes.status === 429) {
        console.log(`${LOG_PREFIX} QUOTA`, { status: 429 })
        return null
      }
      if (!geoRes.ok) {
        console.log(`${LOG_PREFIX} HTTP_ERROR`, { status: geoRes.status })
        return null
      }
      const geoData = (await geoRes.json()) as Array<{ lat?: string; lon?: string }>
      if (!Array.isArray(geoData) || geoData.length === 0) return null
      const lat = Number.parseFloat(geoData[0]?.lat ?? "")
      const lon = Number.parseFloat(geoData[0]?.lon ?? "")
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null
      return { latitude: lat, longitude: lon }
    } catch (err) {
      const name = err instanceof Error ? err.name : "Error"
      console.log(`${LOG_PREFIX} SKIPPED`, {
        reason: name === "AbortError" ? "timeout" : "network",
      })
      return null
    } finally {
      clearTimeout(timer)
    }
  }
}

export const defaultGeocodePort: GeocodePort = new NominatimGeocodeAdapter()
