// IA-1 : ouverture du panneau du copilote depuis n'importe quel composant (menu, raccourci), sans état partagé.
export const COPILOT_OPEN_EVENT = "planificator:copilote-ouvrir"

export function openCopilot(): void {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(COPILOT_OPEN_EVENT))
}
