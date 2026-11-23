/** Jour civil à Paris, au format AAAA-MM-JJ (référence des dates du copilote). */
export function parisToday(now = new Date()): string {
  return new Intl.DateTimeFormat("fr-CA", { timeZone: "Europe/Paris", year: "numeric", month: "2-digit", day: "2-digit" }).format(now)
}
