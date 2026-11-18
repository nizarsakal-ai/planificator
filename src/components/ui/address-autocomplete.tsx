"use client"

/**
 * Champ d'adresse avec autocomplétion IGN (Géoplateforme), partagé par les modules Clients et Chantiers.
 *
 * - Contrôlé (`value` + `onChange`) ou non contrôlé (`defaultValue` + `name`, lu par FormData).
 * - Recherche à partir de 3 caractères, 300 ms après la dernière frappe ; réponses obsolètes ignorées.
 * - Sélection au clic, au toucher et au clavier (↑ ↓ Entrée Échap) ; le champ reste librement modifiable.
 * - En cas de panne ou de liste vide, rien ne bloque : la saisie manuelle et l'enregistrement restent possibles.
 */
import * as React from "react"
import { cn } from "@/lib/utils"
import { Input } from "@/components/ui/input"
import {
  ADDRESS_DEBOUNCE_MS,
  fetchAddressSuggestions,
  shouldSearchAddress,
  type AddressCompletionStatus,
  type AddressSuggestion,
} from "@/lib/address/ign-address-completion"

type NativeInputProps = Omit<React.ComponentProps<"input">, "value" | "defaultValue" | "onChange" | "onSelect" | "type" | "autoComplete" | "role">

export interface AddressAutocompleteProps extends NativeInputProps {
  value?: string
  defaultValue?: string
  onValueChange?: (value: string) => void
  /** Appelé après le choix d'une suggestion (le champ contient déjà `suggestion.label`). */
  onSuggestionSelect?: (suggestion: AddressSuggestion) => void
  /** Injection pour les tests. */
  searchFn?: typeof fetchAddressSuggestions
  debounceMs?: number
}

const FALLBACK_MESSAGES: Partial<Record<AddressCompletionStatus, string>> = {
  empty: "Aucune adresse trouvée : vous pouvez saisir l’adresse librement.",
  error: "Suggestions indisponibles : saisissez l’adresse manuellement.",
  timeout: "Suggestions trop lentes : saisissez l’adresse manuellement.",
  rate_limited: "Trop de recherches : continuez la saisie ou réessayez dans un instant.",
}

export const AddressAutocomplete = React.forwardRef<HTMLInputElement, AddressAutocompleteProps>(function AddressAutocomplete(
  { value, defaultValue, onValueChange, onSuggestionSelect, searchFn = fetchAddressSuggestions, debounceMs = ADDRESS_DEBOUNCE_MS, id, className, disabled, onBlur, onKeyDown, ...rest },
  forwardedRef,
) {
  const reactId = React.useId()
  const inputId = id ?? `address-${reactId}`
  const listId = `${inputId}-suggestions`
  const statusId = `${inputId}-status`
  const controlled = value !== undefined
  const [innerValue, setInnerValue] = React.useState(defaultValue ?? "")
  const current = controlled ? value : innerValue
  const [suggestions, setSuggestions] = React.useState<AddressSuggestion[]>([])
  const [open, setOpen] = React.useState(false)
  const [active, setActive] = React.useState(-1)
  const [status, setStatus] = React.useState<AddressCompletionStatus | null>(null)
  const [loading, setLoading] = React.useState(false)
  const requestSeq = React.useRef(0)
  const abortRef = React.useRef<AbortController | null>(null)
  const timerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null)

  const cancelPending = React.useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = null
    abortRef.current?.abort()
    abortRef.current = null
    requestSeq.current++
  }, [])

  React.useEffect(() => cancelPending, [cancelPending])

  const close = React.useCallback(() => {
    setOpen(false)
    setActive(-1)
  }, [])

  const scheduleSearch = React.useCallback((text: string) => {
    cancelPending()
    if (!shouldSearchAddress(text)) {
      setSuggestions([])
      setStatus(null)
      setLoading(false)
      close()
      return
    }
    timerRef.current = setTimeout(async () => {
      const seq = ++requestSeq.current
      const controller = new AbortController()
      abortRef.current = controller
      setLoading(true)
      const result = await searchFn(text, { signal: controller.signal })
      // Réponse obsolète : une frappe plus récente (ou une sélection) a eu lieu entre-temps.
      if (seq !== requestSeq.current || result.status === "aborted") return
      setLoading(false)
      setStatus(result.status)
      setSuggestions(result.suggestions)
      setActive(-1)
      setOpen(true)
    }, debounceMs)
  }, [cancelPending, close, debounceMs, searchFn])

  const setText = (text: string) => {
    if (!controlled) setInnerValue(text)
    onValueChange?.(text)
  }

  const handleChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const text = event.target.value
    setText(text)
    scheduleSearch(text)
  }

  const choose = (suggestion: AddressSuggestion) => {
    cancelPending()
    setLoading(false)
    setText(suggestion.label)
    onSuggestionSelect?.(suggestion)
    setSuggestions([])
    setStatus(null)
    close()
  }

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    onKeyDown?.(event)
    if (event.defaultPrevented) return
    const hasList = open && suggestions.length > 0
    if (event.key === "ArrowDown") {
      if (!hasList) return
      event.preventDefault()
      setActive((i) => (i + 1) % suggestions.length)
    } else if (event.key === "ArrowUp") {
      if (!hasList) return
      event.preventDefault()
      setActive((i) => (i <= 0 ? suggestions.length - 1 : i - 1))
    } else if (event.key === "Enter") {
      // Entrée choisit la suggestion surlignée ; sans surlignage, le formulaire se soumet normalement.
      if (hasList && active >= 0) {
        event.preventDefault()
        choose(suggestions[active])
      }
    } else if (event.key === "Escape") {
      if (open) {
        event.preventDefault()
        close()
      }
    }
  }

  const message = open && status ? FALLBACK_MESSAGES[status] : undefined
  const expanded = open && suggestions.length > 0

  return (
    <div className="relative">
      <Input
        {...rest}
        ref={forwardedRef}
        id={inputId}
        type="text"
        role="combobox"
        autoComplete="off"
        aria-autocomplete="list"
        aria-expanded={expanded}
        aria-controls={listId}
        aria-describedby={message ? statusId : rest["aria-describedby"]}
        aria-activedescendant={expanded && active >= 0 ? `${listId}-${active}` : undefined}
        aria-busy={loading || undefined}
        value={current}
        disabled={disabled}
        className={className}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        onBlur={(event) => {
          onBlur?.(event)
          close()
        }}
      />
      <ul
        id={listId}
        role="listbox"
        aria-label="Adresses suggérées"
        hidden={!expanded}
        className={cn(
          "absolute left-0 right-0 z-50 mt-1 max-h-72 overflow-auto rounded-xl border border-slate-200 bg-white py-1 text-sm shadow-lg",
          !expanded && "hidden",
        )}
      >
        {suggestions.map((s, i) => (
          <li
            key={s.id}
            id={`${listId}-${i}`}
            role="option"
            aria-selected={i === active}
            // mousedown/pointerdown : garde le focus dans le champ jusqu'au choix (souris et toucher).
            onMouseDown={(e) => e.preventDefault()}
            onPointerDown={(e) => e.preventDefault()}
            onClick={() => choose(s)}
            onMouseEnter={() => setActive(i)}
            className={cn("cursor-pointer px-3 py-2.5 leading-snug", i === active ? "bg-blue-50 text-blue-900" : "text-slate-800")}
          >
            <span className="block font-medium">{[s.housenumber, s.street].filter(Boolean).join(" ") || s.label}</span>
            {(s.postcode || s.city) && <span className="block text-xs text-slate-500">{[s.postcode, s.city].filter(Boolean).join(" ")}</span>}
          </li>
        ))}
      </ul>
      <p id={statusId} role="status" aria-live="polite" className={cn("mt-1 text-xs text-slate-500", !message && "sr-only")}>
        {message ?? (expanded ? `${suggestions.length} adresse${suggestions.length > 1 ? "s" : ""} suggérée${suggestions.length > 1 ? "s" : ""}` : "")}
      </p>
    </div>
  )
})
