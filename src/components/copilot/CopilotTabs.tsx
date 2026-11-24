"use client"
// Assistant IA, étape 2 : barre d'onglets et onglets Propositions (lot F) et Journal (deux sources). Les onglets reçus
// sont décidés par le serveur ; chaque onglet relit ses données par une route qui refait sa propre garde. Lecture seule :
// la décision sur une proposition reste sur la page /assistant (formulaire d'approbation existant).
import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react"
import Link from "next/link"
import { Loader2, RefreshCw } from "lucide-react"
import { analyseAction } from "@/lib/actions/assistant.actions"
import type { CopilotTab, JournalRow, PendingProposal } from "@/lib/copilot/copilot-tabs"

export const TAB_LABEL: Record<CopilotTab, string> = { discussion: "Discussion", propositions: "Propositions", journal: "Journal" }

/** Barre d'onglets accessible (flèches gauche/droite, Début, Fin). Rien si un seul onglet. */
export function CopilotTabBar({ tabs, active, onChange, pendingCount }: { tabs: CopilotTab[]; active: CopilotTab; onChange: (t: CopilotTab) => void; pendingCount?: number }) {
  const refs = useRef<Record<string, HTMLButtonElement | null>>({})
  if (tabs.length < 2) return null
  const move = (e: KeyboardEvent<HTMLButtonElement>) => {
    const i = tabs.indexOf(active)
    const next = e.key === "ArrowRight" ? tabs[(i + 1) % tabs.length] : e.key === "ArrowLeft" ? tabs[(i - 1 + tabs.length) % tabs.length]
      : e.key === "Home" ? tabs[0] : e.key === "End" ? tabs[tabs.length - 1] : null
    if (!next) return
    e.preventDefault()
    onChange(next)
    refs.current[next]?.focus()
  }
  return (
    <div role="tablist" aria-label="Sections de l'assistant" className="flex border-b border-slate-200 bg-slate-50 dark:border-slate-700 dark:bg-slate-800">
      {tabs.map((t) => (
        <button
          key={t}
          ref={(el) => { refs.current[t] = el }}
          type="button"
          role="tab"
          id={`copilote-onglet-${t}`}
          aria-selected={active === t}
          aria-controls={`copilote-panneau-${t}`}
          tabIndex={active === t ? 0 : -1}
          onClick={() => onChange(t)}
          onKeyDown={move}
          className={`flex-1 border-b-2 px-2 py-2.5 text-sm font-semibold outline-none focus-visible:ring-2 focus-visible:ring-sky-400 ${active === t ? "border-[#0f3460] bg-white text-[#0f3460] dark:bg-slate-900 dark:text-sky-300" : "border-transparent text-slate-500 hover:text-slate-700 dark:text-slate-400"}`}
        >
          {TAB_LABEL[t]}
          {t === "propositions" && pendingCount ? <span className="ml-1.5 rounded-full bg-indigo-100 px-1.5 text-[11px] text-[#0f3460]">{pendingCount}</span> : null}
        </button>
      ))}
    </div>
  )
}

const fmt = (iso: string) => new Date(iso).toLocaleString("fr-FR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })

function useJson<T>(url: string) {
  const [data, setData] = useState<T | null>(null)
  const [state, setState] = useState<"loading" | "ok" | "error">("loading")
  const load = useCallback(async () => {
    setState("loading")
    try {
      const res = await fetch(url, { cache: "no-store" })
      if (!res.ok) throw new Error(String(res.status))
      setData((await res.json()) as T)
      setState("ok")
    } catch {
      setState("error")
    }
  }, [url])
  useEffect(() => { void load() }, [load])
  return { data, state, reload: load }
}

/** Onglet Propositions : propositions en attente du lot F ; « Décider » ouvre la page complète /assistant. */
export function ProposalsTab({ onNavigate, onCount }: { onNavigate?: () => void; onCount?: (n: number) => void }) {
  const { data, state, reload } = useJson<{ proposals: PendingProposal[] }>("/api/assistant/propositions")
  const [analysing, setAnalysing] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  useEffect(() => { if (data) onCount?.(data.proposals.length) }, [data, onCount])
  const analyse = async () => {
    setAnalysing(true)
    setMessage(null)
    try {
      const r = await analyseAction()
      setMessage(r.message)
      await reload()
    } catch {
      setMessage("Analyse impossible pour le moment.")
    } finally {
      setAnalysing(false)
    }
  }
  return (
    <div role="tabpanel" id="copilote-panneau-propositions" aria-labelledby="copilote-onglet-propositions" className="flex-1 space-y-3 overflow-y-auto px-4 py-4 text-sm">
      <div className="flex items-center gap-2">
        <button type="button" onClick={() => void analyse()} disabled={analysing} className="rounded-lg border border-slate-300 px-3 py-1.5 font-semibold text-[#0f3460] hover:bg-blue-50 disabled:opacity-50 dark:border-slate-600 dark:text-sky-300">
          {analysing ? "Analyse…" : "Analyser maintenant"}
        </button>
        <Link href="/assistant" onClick={onNavigate} className="ml-auto text-xs text-slate-500 underline underline-offset-2">Page complète</Link>
      </div>
      {message && <p className="text-xs text-slate-600 dark:text-slate-300">{message}</p>}
      {state === "loading" && <p className="flex items-center gap-2 text-slate-500"><Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Chargement…</p>}
      {state === "error" && <button type="button" onClick={() => void reload()} className="flex items-center gap-1.5 text-slate-500 underline"><RefreshCw className="h-3.5 w-3.5" aria-hidden /> Propositions indisponibles, réessayer</button>}
      {state === "ok" && data && data.proposals.length === 0 && <p className="text-slate-500">Aucune proposition en attente.</p>}
      {state === "ok" && data?.proposals.map((p) => (
        <div key={p.id} className="rounded-xl border border-slate-200 p-3 dark:border-slate-700">
          <p className="font-medium text-slate-900 dark:text-slate-100">{p.title}</p>
          <p className="mt-0.5 text-xs text-slate-500">{p.rule} · {fmt(p.createdAt)}</p>
          <Link href={p.href} onClick={onNavigate} className="mt-2 inline-block rounded-lg bg-[#0f3460] px-3 py-1.5 text-xs font-semibold text-white hover:bg-[#143e72]">Décider</Link>
        </div>
      ))}
      <p className="text-xs text-slate-500">Règles locales : rien n&apos;est fait sans votre approbation sur la page complète.</p>
    </div>
  )
}

const SOURCE_STYLE: Record<JournalRow["source"], { label: string; className: string }> = {
  regles: { label: "Règles locales", className: "bg-cyan-50 text-cyan-800 dark:bg-cyan-950 dark:text-cyan-200" },
  "assistant-ia": { label: "Assistant IA", className: "bg-indigo-50 text-indigo-800 dark:bg-indigo-950 dark:text-indigo-200" },
}

/** Onglet Journal : lecture seule, source indiquée sur chaque ligne. */
export function JournalTab() {
  const { data, state, reload } = useJson<{ rows: JournalRow[] }>("/api/assistant/journal")
  return (
    <div role="tabpanel" id="copilote-panneau-journal" aria-labelledby="copilote-onglet-journal" className="flex-1 overflow-y-auto px-4 py-4 text-sm">
      {state === "loading" && <p className="flex items-center gap-2 text-slate-500"><Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Chargement…</p>}
      {state === "error" && <button type="button" onClick={() => void reload()} className="flex items-center gap-1.5 text-slate-500 underline"><RefreshCw className="h-3.5 w-3.5" aria-hidden /> Journal indisponible, réessayer</button>}
      {state === "ok" && data && data.rows.length === 0 && <p className="text-slate-500">Journal vide.</p>}
      {state === "ok" && data && data.rows.length > 0 && (
        <ul className="divide-y divide-slate-100 dark:divide-slate-800">
          {data.rows.map((r) => (
            <li key={r.id} className="flex gap-2 py-2">
              <span className="w-20 shrink-0 tabular-nums text-xs text-slate-500">{fmt(r.date)}</span>
              <span className={`h-fit shrink-0 rounded px-1.5 text-[11px] font-semibold ${SOURCE_STYLE[r.source].className}`}>{SOURCE_STYLE[r.source].label}</span>
              <span className="text-slate-700 dark:text-slate-200">{r.event} · {r.detail}</span>
            </li>
          ))}
        </ul>
      )}
      <p className="mt-3 text-xs text-slate-500">Assistant IA : seuls le type d&apos;action et la date sont conservés, jamais les questions ni les réponses.</p>
    </div>
  )
}
