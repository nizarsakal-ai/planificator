"use client"

import { useCallback, useEffect, useId, useState, useSyncExternalStore } from "react"
import { Monitor, Moon, Sun } from "lucide-react"
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
 * Sélecteur « Apparence » (pied de la Sidebar et du menu mobile) : contrôle segmenté à curseur glissant, fait d'un
 * groupe de boutons radio natifs (flèches du clavier, un seul arrêt de tabulation), libellés Clair / Sombre / Système.
 * Affichage seulement.
 */
export function AppearanceSwitcher({ userId, touch = false }: { userId: string; touch?: boolean }) {
  const { preference, setPreference } = useAppearance(userId)
  const [animate, setAnimate] = useState(false)
  const baseId = useId()
  const labelId = `${baseId}-label`

  return (
    <div>
      <span id={labelId} className="sr-only">Apparence</span>
      <div role="radiogroup" aria-labelledby={labelId} className="relative grid grid-cols-3 rounded-[14px] bg-slate-900/[0.05] p-1">
        <span
          className={cn(
            "pointer-events-none absolute bottom-1 left-1 top-1 w-[calc((100%-0.5rem)/3)] rounded-[10px] bg-white shadow-[0_1px_3px_rgba(15,23,42,0.12)] dark:shadow-[0_1px_3px_rgba(0,0,0,0.5)]",
            // Glissement seulement après un choix de l'utilisateur : pas de déplacement visible au chargement.
            animate && "transition-transform duration-300 ease-out motion-reduce:transition-none",
          )}
          style={{ transform: `translateX(${APPEARANCE_PREFERENCES.indexOf(preference) * 100}%)` }}
          aria-hidden="true"
        />
        {APPEARANCE_PREFERENCES.map((option) => {
          const Icon = ICONS[option]
          const checked = preference === option
          return (
            <label
              key={option}
              className={cn(
                "relative inline-flex cursor-pointer items-center justify-center gap-1.5 rounded-[10px] text-[12px] transition-colors motion-reduce:transition-none",
                "has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-blue-500/60",
                touch ? "h-11" : "h-[30px]",
                checked ? "font-semibold text-slate-900" : "font-medium text-slate-600 hover:text-slate-900",
              )}
            >
              <input
                type="radio"
                name={`${baseId}-appearance`}
                value={option}
                checked={checked}
                onChange={() => { setAnimate(true); setPreference(option) }}
                aria-label={APPEARANCE_LABELS[option]}
                className="absolute inset-0 m-0 cursor-pointer appearance-none rounded-[10px] opacity-0"
              />
              <Icon className={cn("h-3.5 w-3.5", checked && "text-blue-600 dark:text-blue-300")} aria-hidden="true" />
              <span aria-hidden="true">{APPEARANCE_LABELS[option]}</span>
            </label>
          )
        })}
      </div>
    </div>
  )
}
