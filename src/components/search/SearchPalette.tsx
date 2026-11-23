"use client"
// Lot D : palette de recherche globale (Ctrl+K ou ⌘K, ou bouton « Rechercher »). Interroge /api/recherche après une
// courte pause de saisie ; flèches haut et bas pour choisir, Entrée pour ouvrir, Échap pour fermer. Affichage
// seulement : le serveur borne chaque résultat à l'entreprise, au rôle et aux modules actifs.
import { useCallback, useEffect, useRef, useState } from "react"
import { useRouter } from "next/navigation"
import { Search } from "lucide-react"
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog"
import { GROUP_LABEL } from "@/lib/search/search.core"

interface Hit { group: string; id: string; title: string; subtitle: string | null; href: string }
interface Group { group: string; hits: Hit[] }
const LABEL: Record<string, string> = GROUP_LABEL

export function SearchPalette() {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState("")
  const [groups, setGroups] = useState<Group[]>([])
  const [state, setState] = useState<"idle" | "loading" | "error" | "limited">("idle")
  const [active, setActive] = useState(0)
  const seq = useRef(0)
  /** Fermeture (Échap, clic extérieur, Ctrl+K, ouverture d'un résultat) : recherche en cours invalidée, saisie et résultats vidés. */
  const reset = useCallback(() => { seq.current++; setQ(""); setGroups([]); setActive(0); setState("idle") }, [])
  const flat = groups.flatMap((g) => g.hits)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") { e.preventDefault(); setOpen((o) => !o) }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [])
  // Toute fermeture, quelle qu'en soit la cause (Échap, clic extérieur, Ctrl+K, ouverture d'un résultat), invalide la recherche.
  useEffect(() => { if (!open) reset() }, [open, reset])

  // Revue D : TOUT changement de saisie (effacement compris) et toute fermeture invalide la recherche en cours AVANT tout
  // retour : numéro de séquence incrémenté, résultats vidés, requête annulée (AbortController) ; une réponse retardée
  // n'est appliquée que si elle correspond encore à la saisie courante, vérifiée après la réception ET après la lecture JSON.
  useEffect(() => {
    const id = ++seq.current
    setGroups([]); setActive(0)
    const term = q.trim()
    if (term.length < 2) { setState("idle"); return }
    setState("loading")
    const ctrl = new AbortController()
    const t = setTimeout(async () => {
      try {
        const res = await fetch(`/api/recherche?q=${encodeURIComponent(term)}`, { cache: "no-store", credentials: "same-origin", signal: ctrl.signal })
        if (id !== seq.current) return
        if (res.status === 429) { setGroups([]); setState("limited"); return }
        if (!res.ok) { setGroups([]); setState("error"); return }
        const body = (await res.json()) as { groups?: Group[] }
        if (id !== seq.current || ctrl.signal.aborted) return
        setGroups(Array.isArray(body.groups) ? body.groups : [])
        setActive(0)
        setState("idle")
      } catch {
        if (id === seq.current && !ctrl.signal.aborted) { setGroups([]); setState("error") }
      }
    }, 250)
    return () => { clearTimeout(t); ctrl.abort() }
  }, [q])

  const go = useCallback((hit: Hit | undefined) => {
    if (!hit || !hit.href.startsWith("/") || hit.href.startsWith("//")) return
    seq.current++
    setOpen(false)
    router.push(hit.href)
  }, [router])

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => Math.min(a + 1, Math.max(flat.length - 1, 0))) }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)) }
    else if (e.key === "Enter") { e.preventDefault(); go(flat[active]) }
  }

  let index = -1
  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className="flex items-center gap-2 rounded-md border border-[#ebe2d1] bg-white px-2 py-1.5 text-sm text-slate-500 hover:text-slate-700 md:px-3" aria-label="Rechercher (Ctrl+K)">
        <Search className="h-4 w-4" aria-hidden="true" /> <span className="hidden md:inline">Rechercher</span> <kbd className="hidden rounded border px-1 text-xs md:inline">Ctrl K</kbd>
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-xl p-0">
          <DialogTitle className="sr-only">Recherche globale</DialogTitle>
          <DialogDescription className="sr-only">Chantiers, clients, devis, factures, articles, matériel et réserves de votre entreprise, selon les modules actifs.</DialogDescription>
          <div className="flex items-center gap-2 border-b px-3">
            <Search className="h-4 w-4 text-slate-400" aria-hidden="true" />
            <input
              autoFocus value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={onKeyDown} maxLength={64}
              placeholder="Rechercher (2 caractères au moins)…" aria-label="Rechercher" role="combobox" aria-expanded={flat.length > 0}
              aria-controls="recherche-resultats" aria-activedescendant={flat[active] ? `recherche-${active}` : undefined}
              className="h-12 w-full bg-transparent text-sm outline-none"
            />
          </div>
          <div id="recherche-resultats" role="listbox" aria-label="Résultats" className="max-h-96 overflow-y-auto p-2">
            {state === "loading" && <p className="px-2 py-3 text-sm text-slate-400" aria-live="polite">Recherche…</p>}
            {state === "error" && <p className="px-2 py-3 text-sm text-red-700" role="alert">Recherche indisponible.</p>}
            {state === "limited" && <p className="px-2 py-3 text-sm text-amber-700" role="alert">Trop de recherches en peu de temps : réessayez dans un instant.</p>}
            {state === "idle" && q.trim().length >= 2 && flat.length === 0 && <p className="px-2 py-3 text-sm text-slate-400" aria-live="polite">Aucun résultat.</p>}
            {groups.map((g) => (
              <div key={g.group} role="group" aria-label={LABEL[g.group] ?? g.group} className="mb-2">
                <p className="px-2 py-1 text-xs font-semibold uppercase text-slate-500">{LABEL[g.group] ?? g.group}</p>
                {g.hits.map((h) => {
                  index++
                  const i = index
                  return (
                    <button key={`${h.group}-${h.id}`} id={`recherche-${i}`} type="button" role="option" aria-selected={i === active}
                      onMouseEnter={() => setActive(i)} onClick={() => go(h)}
                      className={`block w-full rounded-md px-2 py-1.5 text-left text-sm ${i === active ? "bg-slate-100" : ""}`}>
                      <span className="font-medium text-slate-900">{h.title}</span>
                      {h.subtitle && <span className="ml-2 text-xs text-slate-500">{h.subtitle}</span>}
                    </button>
                  )
                })}
              </div>
            ))}
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}
