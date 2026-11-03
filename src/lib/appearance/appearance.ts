/**
 * Apparence (thème clair / sombre / système) — préférence d'affichage PAR UTILISATEUR, mémorisée sur l'appareil
 * (localStorage, clé suffixée par l'identifiant). Aucune donnée serveur, aucune migration : sans préférence enregistrée
 * ou en cas de valeur inconnue, l'application suit le réglage de l'appareil.
 * Le thème résolu est posé sur <html data-appearance="light|dark"> ; seules les surfaces marquées
 * `data-appearance-scope` (barre latérale, menu mobile) changent pour l'instant (voir globals.css).
 */

export type AppearancePreference = "light" | "dark" | "system"
export type ResolvedTheme = "light" | "dark"

export const APPEARANCE_PREFERENCES: readonly AppearancePreference[] = ["light", "dark", "system"]
export const DEFAULT_APPEARANCE: AppearancePreference = "system"
export const APPEARANCE_LABELS: Record<AppearancePreference, string> = { light: "Clair", dark: "Sombre", system: "Système" }
/** Événement émis dans l'onglet courant quand la préférence change (synchronise Sidebar et menu mobile). */
export const APPEARANCE_EVENT = "planificator:appearance"

const STORAGE_PREFIX = "planificator:appearance:"

/** Clé de stockage propre à un utilisateur ; `null` sans identifiant (rien n'est lu ni écrit). */
export function appearanceStorageKey(userId: string | null | undefined): string | null {
  return userId ? `${STORAGE_PREFIX}${userId}` : null
}

/** Valeur stockée → préférence connue, sinon la valeur par défaut. */
export function parseAppearance(value: unknown): AppearancePreference {
  return APPEARANCE_PREFERENCES.includes(value as AppearancePreference) ? (value as AppearancePreference) : DEFAULT_APPEARANCE
}

export function resolveTheme(preference: AppearancePreference, prefersDark: boolean): ResolvedTheme {
  if (preference === "system") return prefersDark ? "dark" : "light"
  return preference
}

/**
 * Script exécuté dans <head> avant le premier rendu : pose `data-appearance` selon la préférence enregistrée, pour
 * éviter un flash de thème. L'identifiant est sérialisé en JSON avec `<` échappé (pas d'injection de balise possible).
 * Toute erreur (stockage bloqué, navigation privée) laisse le thème clair par défaut.
 */
export function appearanceBootScript(userId: string | null | undefined): string {
  const key = JSON.stringify(appearanceStorageKey(userId)).replace(/</g, "\\u003c")
  return `(function(){try{var k=${key},p=k?localStorage.getItem(k):null;if(p!=="light"&&p!=="dark"&&p!=="system")p=${JSON.stringify(DEFAULT_APPEARANCE)};var d=p==="dark"||(p==="system"&&window.matchMedia("(prefers-color-scheme: dark)").matches);document.documentElement.setAttribute("data-appearance",d?"dark":"light")}catch(e){}})()`
}
