"use client"

import { useCallback, useEffect, useState, useSyncExternalStore } from "react"
import { Moon, Sun } from "lucide-react"
import { cn } from "@/lib/utils"
import {
  APPEARANCE_EVENT, DEFAULT_APPEARANCE,
  appearanceStorageKey, parseAppearance, resolveTheme,
  type AppearancePreference,
} from "@/lib/appearance/appearance"

const DARK_QUERY = "(prefers-color-scheme: dark)"

function readPreference(key: string | null): AppearancePreference {
  if (!key) return DEFAULT_APPEARANCE
  try { return parseAppearance(window.localStorage.getItem(key)) } catch { return DEFAULT_APPEARANCE }
}

function applyTheme(preference: AppearancePreference) {
  document.documentElement.setAttribute("data-appearance", resolveTheme(preference, window.matchMedia(DARK_QUERY).matches))
}

/**
 * Préférence d'apparence de l'utilisateur sur cet appareil. Plusieurs instances (Sidebar, menu mobile) restent
 * synchronisées par l'événement `APPEARANCE_EVENT` (même onglet) et `storage` (autres onglets). En « Système », le
 * thème suit les changements du réglage de l'appareil.
 */
export function useAppearance(userId: string) {
  const key = appearanceStorageKey(userId)
  const subscribe = useCallback((onChange: () => void) => {
    const onStorage = (event: StorageEvent) => { if (event.key === key) onChange() }
    window.addEventListener(APPEARANCE_EVENT, onChange)
    window.addEventListener("storage", onStorage)
    return () => { window.removeEventListener(APPEARANCE_EVENT, onChange); window.removeEventListener("storage", onStorage) }
  }, [key])
  const preference = useSyncExternalStore(subscribe, () => readPreference(key), () => DEFAULT_APPEARANCE)

  useEffect(() => {
    applyTheme(preference)
    if (preference !== "system") return
    const media = window.matchMedia(DARK_QUERY)
    const onSystemChange = () => applyTheme("system")
    media.addEventListener("change", onSystemChange)
    return () => media.removeEventListener("change", onSystemChange)
  }, [preference])

  const setPreference = useCallback((next: AppearancePreference) => {
    if (!key) return
    try { window.localStorage.setItem(key, next) } catch { /* stockage indisponible : le choix vaut pour cette page */ }
    applyTheme(next)
    window.dispatchEvent(new Event(APPEARANCE_EVENT))
  }, [key])

  return { preference, setPreference }
}

/** Réglage sombre de l'appareil, suivi en direct (rendu serveur : clair). */
function useSystemDark() {
  const subscribe = useCallback((onChange: () => void) => {
    const media = window.matchMedia(DARK_QUERY)
    media.addEventListener("change", onChange)
    return () => media.removeEventListener("change", onChange)
  }, [])
  return useSyncExternalStore(subscribe, () => window.matchMedia(DARK_QUERY).matches, () => false)
}

/**
 * Bouton bascule « Mode sombre » (pied de la Sidebar et du menu mobile) : `role="switch"` natif (Entrée / Espace),
 * état annoncé par `aria-checked`. Tant que l'utilisateur n'a rien choisi, il reflète le réglage de l'appareil
 * (préférence « Système ») ; le basculer enregistre un choix explicite clair ou sombre. Affichage seulement.
 */
export function AppearanceSwitcher({ userId, touch = false }: { userId: string; touch?: boolean }) {
  const { preference, setPreference } = useAppearance(userId)
  const dark = resolveTheme(preference, useSystemDark()) === "dark"
  // Glissement seulement après un clic : pas de déplacement visible au chargement.
  const [animate, setAnimate] = useState(false)
  const Icon = dark ? Moon : Sun

  return (
    <button
      type="button"
      role="switch"
      aria-checked={dark}
      onClick={() => { setAnimate(true); setPreference(dark ? "light" : "dark") }}
      className={cn(
        "group flex w-full items-center gap-2.5 rounded-xl px-1.5 text-[13.5px] font-medium tracking-[-0.005em] text-slate-600 outline-none",
        "transition-colors duration-200 motion-reduce:transition-none hover:bg-[#0f3460]/[0.06] hover:text-[#0f3460]",
        "focus-visible:ring-2 focus-visible:ring-blue-500/60 dark:hover:bg-white/5 dark:hover:text-slate-900",
        touch ? "h-11" : "h-9",
      )}
    >
      <span className="inline-flex h-7 w-7 shrink-0 items-center justify-center" aria-hidden="true">
        <Icon className="h-4 w-4 text-slate-400 transition-colors group-hover:text-slate-600 motion-reduce:transition-none" />
      </span>
      <span className="flex-1 text-left">Mode sombre</span>
      <span
        className={cn(
          "relative inline-flex h-6 w-11 shrink-0 rounded-full transition-colors duration-200 motion-reduce:transition-none",
          dark ? "bg-[#0f3460] dark:bg-blue-500" : "bg-[#0f3460]/15",
        )}
        aria-hidden="true"
      >
        <span
          className={cn(
            "absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-[#fff] shadow-[0_1px_2px_rgba(15,52,96,0.25),0_4px_8px_-2px_rgba(15,52,96,0.35)]",
            dark && "translate-x-5",
            animate && "transition-transform duration-200 ease-out motion-reduce:transition-none",
          )}
        />
      </span>
    </button>
  )
}
