"use client"
// IA-1 / IA-2 : copilote Planificator. Entrée « Assistant IA » du menu (sous « Dashboard ») ou Ctrl+J / ⌘J : ouvre un
// panneau à droite. La conversation reste dans le navigateur (rien n'est conservé côté serveur) ; la page courante est
// envoyée comme contexte. IA-2 : les actions proposées s'affichent en cartes ; seul « Je confirme » les exécute.
import { Fragment, useCallback, useEffect, useRef, useState, type ReactNode } from "react"
import Link from "next/link"
import { usePathname } from "next/navigation"
import { Camera, Check, CheckCircle2, Loader2, Mic, MicOff, RefreshCw, Send, Sparkles, Sun, Trash2, Volume2, VolumeX, X, XCircle } from "lucide-react"
import { preparePhoto, useDictation, useSpeech, type PreparedPhoto } from "@/components/copilot/copilot-field"
import { COPILOT_OPEN_EVENT, publishCopilotBadge } from "@/components/copilot/copilot-events"

interface Proposal { token: string; kind: "TASK" | "ASSIGNMENT" | "QUOTE"; title: string; details: string[]; warning?: string }
type CardState = { status: "pending" } | { status: "busy" } | { status: "cancelled" } | { status: "done"; message: string; href?: string } | { status: "error"; message: string }
interface Turn { role: "user" | "assistant"; text: string; error?: boolean; proposals?: Proposal[]; photo?: string }
export const PHOTO_DEFAULT_QUESTION = "Que vois-tu sur cette photo ? Dis-moi ce qui est utile."
interface BriefingData {
  date: string
  today: { worksites: Array<{ name: string; teams: string[]; href: string }>; freeTeams: string[]; absent: string[] }
  alerts: Array<{ id: string; level: "urgent" | "attention" | "info"; title: string; detail: string; href: string }>
  badge: number
}

const LEVEL_STYLE = { urgent: "bg-rose-500", attention: "bg-amber-500", info: "bg-sky-500" } as const
const LEVEL_LABEL = { urgent: "Urgent", attention: "À surveiller", info: "Info" } as const
export const BRIEFING_PROMPT = "Fais-moi le briefing du jour et propose les actions utiles."

/** IA-3 : briefing du jour (calcul serveur, sans IA). Liens internes uniquement. */
export function BriefingView({ data, onAnalyze, onNavigate }: { data: BriefingData; onAnalyze: () => void; onNavigate?: () => void }) {
  const { worksites, freeTeams, absent } = data.today
  return (
    <section aria-label="Briefing du jour" className="space-y-3 rounded-xl border border-slate-200 bg-slate-50 p-3 text-sm dark:border-slate-700 dark:bg-slate-800/60">
      <p className="flex items-center gap-2 font-semibold text-[#0f3460] dark:text-sky-300"><Sun className="h-4 w-4" aria-hidden /> Briefing du jour</p>
      <div className="space-y-1 text-slate-700 dark:text-slate-200">
        <p>{worksites.length === 0 ? "Aucun chantier planifié aujourd'hui." : `${worksites.length} chantier${worksites.length > 1 ? "s" : ""} aujourd'hui :`}</p>
        {worksites.length > 0 && (
          <ul className="ml-4 list-disc">
            {worksites.slice(0, 6).map(w => <li key={w.href}><Link href={w.href} onClick={onNavigate} className="underline underline-offset-2">{w.name}</Link> · {w.teams.join(", ")}</li>)}
          </ul>
        )}
        {freeTeams.length > 0 && <p>Équipes libres : {freeTeams.join(", ")}</p>}
        {absent.length > 0 && <p>Absents : {absent.join(", ")}</p>}
      </div>
      {data.alerts.length === 0 ? (
        <p className="text-emerald-700 dark:text-emerald-300">Aucune alerte : tout est en ordre.</p>
      ) : (
        <ul className="space-y-2">
          {data.alerts.map(a => (
            <li key={a.id} className="flex gap-2">
              <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${LEVEL_STYLE[a.level]}`} title={LEVEL_LABEL[a.level]} aria-label={LEVEL_LABEL[a.level]} />
              <div>
                <Link href={a.href} onClick={onNavigate} className="font-medium text-slate-900 underline-offset-2 hover:underline dark:text-slate-100">{a.title}</Link>
                <p className="text-slate-600 dark:text-slate-300">{a.detail}</p>
              </div>
            </li>
          ))}
        </ul>
      )}
      <button type="button" onClick={onAnalyze} className="flex items-center gap-1.5 rounded-lg bg-[#0f3460] px-3 py-1.5 font-semibold text-white hover:bg-[#143e72]">
        <Sparkles className="h-4 w-4" aria-hidden /> Analyser et proposer des actions
      </button>
    </section>
  )
}

/** Carte d'action proposée : rien n'est fait avant « Je confirme ». */
export function ProposalCardView({ proposal, state, onConfirm, onCancel, onNavigate }: {
  proposal: Proposal; state: CardState; onConfirm: () => void; onCancel: () => void; onNavigate?: () => void
}) {
  return (
    <div className="mt-2 rounded-xl border border-[#0f3460]/20 bg-white p-3 text-sm shadow-sm dark:border-slate-600 dark:bg-slate-900">
      <p className="font-semibold text-[#0f3460] dark:text-sky-300">{proposal.title}</p>
      <ul className="mt-1.5 space-y-0.5 text-slate-700 dark:text-slate-200">
        {proposal.details.map((d, i) => <li key={i}>{d}</li>)}
      </ul>
      {proposal.warning && <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">{proposal.warning}</p>}
      <div className="mt-3">
        {state.status === "pending" && (
          <div className="flex gap-2">
            <button type="button" onClick={onConfirm} className="flex items-center gap-1.5 rounded-lg bg-[#0f3460] px-3 py-1.5 font-semibold text-white hover:bg-[#143e72]">
              <Check className="h-4 w-4" aria-hidden /> Je confirme
            </button>
            <button type="button" onClick={onCancel} className="rounded-lg border border-slate-300 px-3 py-1.5 text-slate-700 hover:bg-slate-50 dark:border-slate-600 dark:text-slate-200 dark:hover:bg-slate-800">
              Annuler
            </button>
          </div>
        )}
        {state.status === "busy" && <p className="flex items-center gap-2 text-slate-500"><Loader2 className="h-4 w-4 animate-spin" aria-hidden /> En cours…</p>}
        {state.status === "cancelled" && <p className="text-slate-500">Annulé : rien n&apos;a été fait.</p>}
        {state.status === "done" && (
          <p className="flex items-center gap-1.5 font-medium text-emerald-700 dark:text-emerald-300">
            <CheckCircle2 className="h-4 w-4" aria-hidden /> {state.message}
            {state.href && <Link href={state.href} onClick={onNavigate} className="ml-1 underline underline-offset-2">Voir</Link>}
          </p>
        )}
        {state.status === "error" && <p className="flex items-center gap-1.5 text-rose-700 dark:text-rose-300"><XCircle className="h-4 w-4 shrink-0" aria-hidden /> {state.message}</p>}
      </div>
    </div>
  )
}

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
  const [cards, setCards] = useState<Record<string, CardState>>({})
  const [briefing, setBriefing] = useState<BriefingData | null>(null)
  const [briefingState, setBriefingState] = useState<"idle" | "loading" | "error">("idle")

  // IA-3 : briefing chargé au montage (pastille du menu) puis à chaque ouverture du panneau ; sans IA, hors quota.
  const loadBriefing = useCallback(async () => {
    setBriefingState("loading")
    try {
      const res = await fetch("/api/assistant/copilote/briefing", { cache: "no-store" })
      if (!res.ok) throw new Error(String(res.status))
      const data = (await res.json()) as BriefingData
      setBriefing(data)
      publishCopilotBadge(data.badge)
      setBriefingState("idle")
    } catch {
      setBriefingState("error")
    }
  }, [])
  useEffect(() => { void loadBriefing() }, [loadBriefing])
  useEffect(() => { if (open) void loadBriefing() }, [open, loadBriefing])
  const listRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "j") { e.preventDefault(); setOpen(o => !o) }
      else if (e.key === "Escape") setOpen(false)
    }
    const onOpen = () => setOpen(true)
    window.addEventListener("keydown", onKey)
    window.addEventListener(COPILOT_OPEN_EVENT, onOpen)
    return () => { window.removeEventListener("keydown", onKey); window.removeEventListener(COPILOT_OPEN_EVENT, onOpen) }
  }, [])

  useEffect(() => { if (open) inputRef.current?.focus() }, [open])
  useEffect(() => { listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: "smooth" }) }, [turns, busy])

  // IA-4 : mode terrain — dictée, photo, lecture à voix haute.
  const [photo, setPhoto] = useState<PreparedPhoto | null>(null)
  const [photoError, setPhotoError] = useState<string | null>(null)
  const [photoBusy, setPhotoBusy] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)
  const dictation = useDictation(text => setDraft(d => `${d}${d && !d.endsWith(" ") ? " " : ""}${text}`.slice(0, 2000)))
  const speech = useSpeech()
  useEffect(() => { if (!open) { speech.cancel(); dictation.stop() } }, [open, speech, dictation])

  const pickPhoto = useCallback(async (file: File | undefined) => {
    if (!file) return
    setPhotoError(null)
    setPhotoBusy(true)
    try { setPhoto(await preparePhoto(file)) } catch (e) { setPhotoError(e instanceof Error ? e.message : "Photo impossible à préparer.") } finally { setPhotoBusy(false) }
  }, [])

  const send = useCallback(async (question: string) => {
    const text = question.trim() || (photo ? PHOTO_DEFAULT_QUESTION : "")
    if (!text || busy) return
    const sentPhoto = photo
    const history = [...turns.filter(t => !t.error), { role: "user" as const, text }]
    setTurns(prev => [...prev, { role: "user", text, photo: sentPhoto?.preview }])
    setDraft("")
    setPhoto(null)
    setBusy(true)
    try {
      const res = await fetch("/api/assistant/copilote", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: history.map(({ role, text }) => ({ role, text })), page: pathname,
          ...(sentPhoto ? { image: { mediaType: sentPhoto.mediaType, data: sentPhoto.data } } : {}),
        }),
      })
      const data = (await res.json().catch(() => ({}))) as { reply?: string; error?: string; proposals?: Proposal[] }
      if (data.reply) speech.speak(data.reply)
      setTurns(prev => [...prev, data.reply
        ? { role: "assistant", text: data.reply, proposals: Array.isArray(data.proposals) ? data.proposals.slice(0, 5) : undefined }
        : { role: "assistant", text: data.error ?? "L'assistant est indisponible pour le moment.", error: true }])
    } catch {
      setTurns(prev => [...prev, { role: "assistant", text: "Connexion impossible. Vérifiez le réseau et réessayez.", error: true }])
    } finally {
      setBusy(false)
    }
  }, [busy, turns, pathname, photo, speech])

  const setCard = (token: string, state: CardState) => setCards(prev => ({ ...prev, [token]: state }))
  const confirm = useCallback(async (token: string) => {
    setCard(token, { status: "busy" })
    try {
      const res = await fetch("/api/assistant/copilote/action", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token }) })
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; message?: string; href?: string; error?: string }
      setCard(token, data.ok && data.message ? { status: "done", message: data.message, href: data.href } : { status: "error", message: data.error ?? "L'action n'a pas pu être faite." })
    } catch {
      setCard(token, { status: "error", message: "Connexion impossible. Vérifiez le réseau et réessayez." })
    }
  }, [])

  return (
    <>
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
              <p className="text-xs text-sky-100/80">Rien n&apos;est fait sans votre confirmation</p>
            </div>
            {speech.supported && (
              <button type="button" onClick={speech.toggle} aria-pressed={speech.enabled} aria-label={speech.enabled ? "Couper la lecture à voix haute" : "Lire les réponses à voix haute"} title={speech.enabled ? "Lecture à voix haute activée" : "Lire les réponses à voix haute"} className="rounded p-1.5 hover:bg-white/10">
                {speech.enabled ? <Volume2 className="h-4 w-4" aria-hidden /> : <VolumeX className="h-4 w-4 opacity-70" aria-hidden />}
              </button>
            )}
            {turns.length > 0 && (
              <button type="button" onClick={() => { setTurns([]); setCards({}) }} disabled={busy} aria-label="Effacer la conversation" title="Effacer la conversation" className="rounded p-1.5 hover:bg-white/10 disabled:opacity-50">
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
                {briefing && <BriefingView data={briefing} onAnalyze={() => void send(BRIEFING_PROMPT)} onNavigate={() => { if (window.innerWidth < 640) setOpen(false) }} />}
                {!briefing && briefingState === "loading" && <p className="flex items-center gap-2 text-sm text-slate-500"><Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Préparation du briefing…</p>}
                {briefingState === "error" && (
                  <button type="button" onClick={() => void loadBriefing()} className="flex items-center gap-1.5 text-sm text-slate-500 underline underline-offset-2">
                    <RefreshCw className="h-3.5 w-3.5" aria-hidden /> Briefing indisponible, réessayer
                  </button>
                )}
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
                  {t.photo && <img src={t.photo} alt="Photo envoyée" className="mb-1.5 max-h-40 rounded-lg" />}
                  {t.role === "assistant" && !t.error ? renderCopilotText(t.text, () => { if (window.innerWidth < 640) setOpen(false) }) : t.text}
                  {t.proposals?.map(p => (
                    <ProposalCardView
                      key={p.token}
                      proposal={p}
                      state={cards[p.token] ?? { status: "pending" }}
                      onConfirm={() => void confirm(p.token)}
                      onCancel={() => setCard(p.token, { status: "cancelled" })}
                      onNavigate={() => { if (window.innerWidth < 640) setOpen(false) }}
                    />
                  ))}
                </div>
              </div>
            ))}
            {busy && (
              <div className="flex items-center gap-2 text-sm text-slate-500 dark:text-slate-400">
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> L&apos;assistant consulte vos données…
              </div>
            )}
          </div>

          {(photo || photoBusy || photoError || dictation.error || dictation.listening) && (
            <div className="space-y-1 border-t border-slate-200 px-3 pt-2 text-xs dark:border-slate-700">
              {photo && (
                <div className="flex items-center gap-2">
                  <img src={photo.preview} alt="Photo à envoyer" className="h-14 w-14 rounded-md object-cover" />
                  <span className="flex-1 text-slate-600 dark:text-slate-300">Photo jointe à votre prochain message.</span>
                  <button type="button" onClick={() => setPhoto(null)} aria-label="Retirer la photo" className="rounded p-1 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800"><X className="h-4 w-4" aria-hidden /></button>
                </div>
              )}
              {photoBusy && <p className="flex items-center gap-1.5 text-slate-500"><Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> Préparation de la photo…</p>}
              {photoError && <p className="text-rose-700 dark:text-rose-300">{photoError}</p>}
              {dictation.listening && <p className="flex items-center gap-1.5 font-medium text-rose-600"><span className="h-2 w-2 animate-pulse rounded-full bg-rose-600" aria-hidden /> Je vous écoute… parlez puis faites une pause.</p>}
              {dictation.error && <p className="text-rose-700 dark:text-rose-300">{dictation.error}</p>}
            </div>
          )}
          <form
            onSubmit={e => { e.preventDefault(); void send(draft) }}
            className="flex items-end gap-2 border-t border-slate-200 p-3 dark:border-slate-700"
          >
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              capture="environment"
              className="hidden"
              onChange={e => { void pickPhoto(e.target.files?.[0]); e.target.value = "" }}
            />
            <div className="flex flex-col gap-1">
              <button type="button" onClick={() => fileRef.current?.click()} disabled={busy || photoBusy} aria-label="Joindre une photo" title="Prendre ou joindre une photo" className="flex h-[21px] w-9 items-center justify-center rounded-md text-slate-500 hover:bg-slate-100 hover:text-[#0f3460] disabled:opacity-40 dark:hover:bg-slate-800">
                <Camera className="h-4 w-4" aria-hidden />
              </button>
              {dictation.supported && (
                <button
                  type="button"
                  onClick={dictation.listening ? dictation.stop : dictation.start}
                  disabled={busy}
                  aria-label={dictation.listening ? "Arrêter la dictée" : "Dicter"}
                  aria-pressed={dictation.listening}
                  title={dictation.listening ? "Arrêter la dictée" : "Dicter à la voix"}
                  className={`flex h-[21px] w-9 items-center justify-center rounded-md disabled:opacity-40 ${dictation.listening ? "bg-rose-600 text-white" : "text-slate-500 hover:bg-slate-100 hover:text-[#0f3460] dark:hover:bg-slate-800"}`}
                >
                  {dictation.listening ? <MicOff className="h-4 w-4" aria-hidden /> : <Mic className="h-4 w-4" aria-hidden />}
                </button>
              )}
            </div>
            <textarea
              ref={inputRef}
              value={draft}
              onChange={e => setDraft(e.target.value.slice(0, 2000))}
              onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(draft) } }}
              rows={2}
              placeholder={dictation.supported ? "Votre question… (ou dictez au micro)" : "Votre question…"}
              aria-label="Votre question"
              className="min-h-[44px] flex-1 resize-none rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:border-[#0f3460] focus:outline-none focus:ring-1 focus:ring-[#0f3460] dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100"
            />
            <button type="submit" disabled={busy || photoBusy || (!draft.trim() && !photo)} aria-label="Envoyer" className="flex h-11 w-11 items-center justify-center rounded-lg bg-[#0f3460] text-white transition hover:bg-[#143e72] disabled:opacity-40">
              <Send className="h-4 w-4" aria-hidden />
            </button>
          </form>
        </aside>
      )}
    </>
  )
}
