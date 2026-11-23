"use client"
// IA-1 : copilote Planificator. Bouton flottant (ou Ctrl+J / ⌘J) qui ouvre un panneau à droite. La conversation reste
// dans le navigateur (rien n'est conservé côté serveur) ; la page courante est envoyée comme contexte. Lecture seule.
import { Fragment, useCallback, useEffect, useRef, useState, type ReactNode } from "react"
import Link from "next/link"
import { usePathname } from "next/navigation"
import { Loader2, Send, Sparkles, Trash2, X } from "lucide-react"

interface Turn { role: "user" | "assistant"; text: string; error?: boolean }

const SUGGESTIONS = [
  "Qui travaille demain et sur quel chantier ?",
  "Quelles factures sont en retard de paiement ?",
  "Quelles équipes sont libres lundi prochain ?",
  "Résume les consultations à traiter.",
]

/** Rendu sûr : texte brut, **gras** et liens internes [libellé](/chemin) seulement (tout autre lien reste du texte). */
export function renderCopilotText(text: string, onNavigate?: () => void): ReactNode {
  const parts: ReactNode[] = []
  const re = /\[([^\]\n]{1,120})\]\((\/[\w\-/]{0,200})\)|\*\*([^*\n]{1,200})\*\*/g
  let last = 0
  let m: RegExpExecArray | null
  let key = 0
  while ((m = re.exec(text))) {
    if (m.index > last) parts.push(<Fragment key={key++}>{text.slice(last, m.index)}</Fragment>)
    if (m[1] && m[2] && !m[2].startsWith("//")) {
      parts.push(<Link key={key++} href={m[2]} onClick={onNavigate} className="font-medium text-[#0f3460] underline underline-offset-2 hover:text-blue-700 dark:text-sky-300">{m[1]}</Link>)
    } else if (m[3]) {
      parts.push(<strong key={key++}>{m[3]}</strong>)
    } else {
      parts.push(<Fragment key={key++}>{m[0]}</Fragment>)
    }
    last = m.index + m[0].length
  }
  if (last < text.length) parts.push(<Fragment key={key++}>{text.slice(last)}</Fragment>)
  return parts
}

export function CopilotPanel() {
  const pathname = usePathname()
  const [open, setOpen] = useState(false)
  const [turns, setTurns] = useState<Turn[]>([])
  const [draft, setDraft] = useState("")
  const [busy, setBusy] = useState(false)
  const listRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "j") { e.preventDefault(); setOpen(o => !o) }
      else if (e.key === "Escape") setOpen(false)
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [])

  useEffect(() => { if (open) inputRef.current?.focus() }, [open])
  useEffect(() => { listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: "smooth" }) }, [turns, busy])

  const send = useCallback(async (question: string) => {
    const text = question.trim()
    if (!text || busy) return
    const history = [...turns.filter(t => !t.error), { role: "user" as const, text }]
    setTurns(prev => [...prev, { role: "user", text }])
    setDraft("")
    setBusy(true)
    try {
      const res = await fetch("/api/assistant/copilote", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: history.map(({ role, text }) => ({ role, text })), page: pathname }),
      })
      const data = (await res.json().catch(() => ({}))) as { reply?: string; error?: string }
      setTurns(prev => [...prev, data.reply
        ? { role: "assistant", text: data.reply }
        : { role: "assistant", text: data.error ?? "L'assistant est indisponible pour le moment.", error: true }])
    } catch {
      setTurns(prev => [...prev, { role: "assistant", text: "Connexion impossible. Vérifiez le réseau et réessayez.", error: true }])
    } finally {
      setBusy(false)
    }
  }, [busy, turns, pathname])

  return (
    <>
      {!open && (
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-label="Ouvrir l'assistant IA"
          title="Assistant IA (Ctrl+J)"
          className="fixed bottom-5 right-5 z-40 flex items-center gap-2 rounded-full bg-[#0f3460] px-4 py-3 text-sm font-semibold text-white shadow-lg shadow-blue-900/30 transition hover:scale-[1.03] hover:bg-[#143e72] focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
        >
          <Sparkles className="h-4 w-4" aria-hidden />
          Assistant
        </button>
      )}

      {open && (
        <aside
          role="dialog"
          aria-label="Assistant IA"
          className="fixed inset-y-0 right-0 z-50 flex w-full flex-col border-l border-slate-200 bg-white shadow-2xl sm:w-[420px] dark:border-slate-700 dark:bg-slate-900"
        >
          <header className="flex items-center gap-2 bg-[#0f3460] px-4 py-3 text-white">
            <Sparkles className="h-5 w-5" aria-hidden />
            <div className="flex-1">
              <p className="text-sm font-semibold">Assistant IA</p>
              <p className="text-xs text-sky-100/80">Consultation seule · ne modifie rien</p>
            </div>
            {turns.length > 0 && (
              <button type="button" onClick={() => setTurns([])} disabled={busy} aria-label="Effacer la conversation" title="Effacer la conversation" className="rounded p-1.5 hover:bg-white/10 disabled:opacity-50">
                <Trash2 className="h-4 w-4" aria-hidden />
              </button>
            )}
            <button type="button" onClick={() => setOpen(false)} aria-label="Fermer l'assistant" title="Fermer (Échap)" className="rounded p-1.5 hover:bg-white/10">
              <X className="h-5 w-5" aria-hidden />
            </button>
          </header>

          <div ref={listRef} className="flex-1 space-y-3 overflow-y-auto px-4 py-4" aria-live="polite">
            {turns.length === 0 && (
              <div className="space-y-3">
                <p className="text-sm text-slate-600 dark:text-slate-300">
                  Posez une question sur votre planning, vos chantiers, vos factures, vos absences ou votre stock.
                </p>
                <div className="flex flex-col gap-2">
                  {SUGGESTIONS.map(s => (
                    <button key={s} type="button" onClick={() => send(s)} className="rounded-lg border border-slate-200 px-3 py-2 text-left text-sm text-slate-700 transition hover:border-[#0f3460] hover:bg-blue-50 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800">
                      {s}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {turns.map((t, i) => (
              <div key={i} className={t.role === "user" ? "flex justify-end" : "flex justify-start"}>
                <div className={[
                  "max-w-[88%] whitespace-pre-wrap break-words rounded-2xl px-3 py-2 text-sm leading-relaxed",
                  t.role === "user" ? "rounded-br-sm bg-[#0f3460] text-white"
                    : t.error ? "rounded-bl-sm bg-rose-50 text-rose-800 dark:bg-rose-950 dark:text-rose-200"
                    : "rounded-bl-sm bg-slate-100 text-slate-800 dark:bg-slate-800 dark:text-slate-100",
                ].join(" ")}>
                  {t.role === "assistant" && !t.error ? renderCopilotText(t.text, () => { if (window.innerWidth < 640) setOpen(false) }) : t.text}
                </div>
              </div>
            ))}
            {busy && (
              <div className="flex items-center gap-2 text-sm text-slate-500 dark:text-slate-400">
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> L&apos;assistant consulte vos données…
              </div>
            )}
          </div>

          <form
            onSubmit={e => { e.preventDefault(); void send(draft) }}
            className="flex items-end gap-2 border-t border-slate-200 p-3 dark:border-slate-700"
          >
            <textarea
              ref={inputRef}
              value={draft}
              onChange={e => setDraft(e.target.value.slice(0, 2000))}
              onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(draft) } }}
              rows={2}
              placeholder="Votre question…"
              aria-label="Votre question"
              className="min-h-[44px] flex-1 resize-none rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:border-[#0f3460] focus:outline-none focus:ring-1 focus:ring-[#0f3460] dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100"
            />
            <button type="submit" disabled={busy || !draft.trim()} aria-label="Envoyer" className="flex h-11 w-11 items-center justify-center rounded-lg bg-[#0f3460] text-white transition hover:bg-[#143e72] disabled:opacity-40">
              <Send className="h-4 w-4" aria-hidden />
            </button>
          </form>
        </aside>
      )}
    </>
  )
}
