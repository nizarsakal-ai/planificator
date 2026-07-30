/**
 * Kill-switch du cron Gmail Booking (`/api/cron/gmail-scan`).
 * Activé uniquement si `BOOKING_GMAIL_SCAN_ENABLED` vaut exactement `"true"`.
 * Défaut OFF (fail-closed) — nécessite un set explicite en environnement cible.
 */
export function isBookingGmailScanEnabled(): boolean {
  return process.env.BOOKING_GMAIL_SCAN_ENABLED === "true"
}
