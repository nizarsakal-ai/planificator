/**
 * Mode pending-only du scan Gmail Booking (`createOrGetBookingScanResult`).
 * Activé uniquement si `BOOKING_SCAN_PENDING_ONLY` vaut exactement `"true"`.
 * Défaut OFF — conserve le comportement historique (auto-Accommodation possible).
 * Ne pas exposer cette valeur au client.
 */
export function isBookingScanPendingOnly(
  env: NodeJS.ProcessEnv = process.env
): boolean {
  return env.BOOKING_SCAN_PENDING_ONLY === "true"
}
