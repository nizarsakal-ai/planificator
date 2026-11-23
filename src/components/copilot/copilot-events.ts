// IA-1 : ouverture du panneau du copilote depuis n'importe quel composant (menu, raccourci), sans état partagé.
export const COPILOT_OPEN_EVENT = "planificator:copilote-ouvrir"

export function openCopilot(): void {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(COPILOT_OPEN_EVENT))
}

// IA-3 : pastille du menu (nombre d'alertes urgentes ou à surveiller). Dernière valeur gardée pour les composants
// montés après la publication (menu mobile).
export const COPILOT_BADGE_EVENT = "planificator:copilote-alertes"
let lastBadge = 0
export function publishCopilotBadge(count: number): void {
  lastBadge = Number.isInteger(count) && count > 0 ? Math.min(count, 99) : 0
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(COPILOT_BADGE_EVENT, { detail: lastBadge }))
}
export function currentCopilotBadge(): number {
  return lastBadge
}
