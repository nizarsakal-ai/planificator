"use client"

import { useCallback, useEffect, useId, useSyncExternalStore } from "react"
import { Monitor, Moon, Sun, SunMoon } from "lucide-react"
import { cn } from "@/lib/utils"
import {
  APPEARANCE_EVENT, APPEARANCE_LABELS, APPEARANCE_PREFERENCES, DEFAULT_APPEARANCE,
  appearanceStorageKey, parseAppearance, resolveTheme,
  type AppearancePreference,
} from "@/lib/appearance/appearance"

const DARK_QUERY = "(prefers-color-scheme: dark)"
const ICONS = { light: Sun, dark: Moon, system: Monitor } as const

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

/**
 * Sélecteur « Apparence » (pied de la Sidebar et du menu mobile) : groupe de boutons radio natifs (flèches du clavier,
 * un seul arrêt de tabulation), libellés accessibles Clair / Sombre / Système. Affichage seulement.
 */
export function AppearanceSwitcher({ userId, touch = false }: { userId: string; touch?: boolean }) {
  const { preference, setPreference } = useAppearance(userId)
  const baseId = useId()
  const labelId = `${baseId}-label`

  return (
    <div className="flex items-center gap-2.5 rounded-xl border border-slate-200/80 py-1 pl-3 pr-1">
      <SunMoon className="h-4 w-4 shrink-0 text-slate-400" aria-hidden="true" />
      <span id={labelId} className="flex-1 text-[13px] font-medium text-slate-600">Apparence</span>
      <div role="radiogroup" aria-labelledby={labelId} className="inline-flex gap-0.5 rounded-full bg-slate-100 p-0.5">
        {APPEARANCE_PREFERENCES.map((option) => {
          const Icon = ICONS[option]
          const checked = preference === option
          return (
            <label
              key={option}
              title={APPEARANCE_LABELS[option]}
              className={cn(
                "relative inline-flex cursor-pointer items-center justify-center rounded-full transition-colors motion-reduce:transition-none",
                "has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-blue-500/60",
                touch ? "h-11 w-11" : "h-7 w-7",
                checked
                  ? "bg-white text-blue-600 shadow-[0_1px_2px_rgba(16,24,40,0.10),0_0_0_1px_rgba(16,24,40,0.05)] dark:text-blue-300"
                  : "text-slate-500 hover:text-slate-700",
              )}
            >
              <input
                type="radio"
                name={`${baseId}-appearance`}
                value={option}
                checked={checked}
                onChange={() => setPreference(option)}
                aria-label={APPEARANCE_LABELS[option]}
                className="absolute inset-0 m-0 cursor-pointer appearance-none rounded-full opacity-0"
              />
              <Icon className="h-3.5 w-3.5" aria-hidden="true" />
            </label>
          )
        })}
      </div>
    </div>
  )
}
