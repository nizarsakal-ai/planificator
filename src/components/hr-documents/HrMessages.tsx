"use client"
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react"
import { callJson, type FolderDoc, type SpaceMode } from "./space-client"

/**
 * Échanges privés entre le salarié concerné et les RH habilités : texte seul (rendu comme texte, jamais comme HTML),
 * aucun envoi d'e-mail ou externe. « Lu le » n'est affiché que si le serveur l'a constaté au chargement par l'autre partie.
 */
export type ThreadMessage = { id: string; authorSide: "HR" | "EMPLOYEE"; kind: "MESSAGE" | "REQUEST"; body: string; documentId: string | null
  requestStatus: "OPEN" | "DONE" | null; createdAt: string; readAt: string | null; mine: boolean }
const when = (value: string) => new Intl.DateTimeFormat("fr-FR", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(value))

export function MessageList({ mode, messages, attachable, onPreview, onAnswerRequest }: {
  mode: SpaceMode; messages: ThreadMessage[]; attachable: FolderDoc[]
  onPreview: (id: string, title: string, trigger: HTMLButtonElement) => void; onAnswerRequest?: (requestId: string) => void
}) {
  if (!messages.length) return <p className="py-4 text-sm text-slate-600">Aucun échange pour l’instant.</p>
  return <ol className="space-y-3">{messages.map(m => {
    const author = m.mine ? "Vous" : m.authorSide === "HR" ? "RH" : "Salarié"
    const attached = m.documentId ? attachable.find(d => d.id === m.documentId) : undefined
    return <li key={m.id} className={`rounded-lg border p-3 text-sm ${m.mine ? "border-blue-100 bg-blue-50/60" : "border-slate-200 bg-white"}`}>
      <p className="text-xs text-slate-500"><span className="font-medium text-slate-700">{author}</span> · {when(m.createdAt)}
        {m.kind === "REQUEST" && <span className="ml-2 rounded-full bg-amber-50 px-2 py-0.5 text-amber-900">{m.requestStatus === "DONE" ? "Pièce reçue" : "Pièce à compléter"}</span>}</p>
      <p className="mt-1 whitespace-pre-wrap break-words text-slate-800">{m.body}</p>
      {m.documentId && (attached
        ? <button type="button" aria-haspopup="dialog" className="mt-2 rounded-lg border border-blue-200 px-3 py-1.5 text-sm text-blue-900" onClick={e => onPreview(attached.id, attached.title, e.currentTarget)}>Visualiser la pièce jointe : {attached.title}</button>
        : <p className="mt-2 text-xs text-slate-500">Pièce jointe disponible dans le dossier.</p>)}
      {m.mine && <p className="mt-1 text-xs text-slate-500">{m.readAt ? `Lu le ${when(m.readAt)}` : "Envoyé, pas encore lu"}</p>}
      {mode === "employee" && m.kind === "REQUEST" && m.requestStatus === "OPEN" && onAnswerRequest &&
        <button type="button" className="mt-2 rounded-lg border border-blue-200 px-3 py-1.5 text-sm text-blue-900" onClick={() => onAnswerRequest(m.id)}>Transmettre la pièce demandée</button>}
    </li>
  })}</ol>
}

type Thread = { messages: ThreadMessage[]; nextCursor: string | null }

export function HrMessages({ mode, employeeId, canWrite, canRequest, version, attachable, onPreview, onAnswerRequest }: {
  mode: SpaceMode; employeeId?: string; canWrite: boolean; canRequest: boolean; version: number; attachable: FolderDoc[]
  onPreview: (id: string, title: string, trigger: HTMLButtonElement) => void; onAnswerRequest?: (requestId: string) => void
}) {
  const [messages, setMessages] = useState<ThreadMessage[]>([]), [cursor, setCursor] = useState<string | null>(null)
  const [error, setError] = useState(""), [status, setStatus] = useState(""), [sending, setSending] = useState(false)
  const [body, setBody] = useState(""), [request, setRequest] = useState(false), [documentId, setDocumentId] = useState("")
  const key = useRef<string | null>(null), loadVersion = useRef(0)
  const query = mode === "hr" ? `?employeeId=${encodeURIComponent(employeeId ?? "")}` : ""
  const load = useCallback(async (next?: string) => {
    const v = ++loadVersion.current; setError("")
    try {
      const data = await callJson<Thread>(`/api/hr-documents/messages${query}${next ? `${query ? "&" : "?"}cursor=${encodeURIComponent(next)}` : ""}`)
      if (v !== loadVersion.current) return
      // Le serveur renvoie du plus récent au plus ancien ; affichage chronologique.
      const page = [...data.messages].reverse()
      setMessages(old => next ? [...page, ...old] : page); setCursor(data.nextCursor)
    } catch (e) { if (v === loadVersion.current) setError(e instanceof Error ? e.message : "Échanges indisponibles.") }
  }, [query])
  useEffect(() => { setMessages([]); setCursor(null); setBody(""); setRequest(false); setDocumentId(""); setStatus(""); key.current = null }, [query])
  useEffect(() => { void load(); return () => { loadVersion.current++ } }, [load, version])
  async function send(e: FormEvent) {
    e.preventDefault(); if (sending || !body.trim()) return
    setSending(true); setError(""); setStatus("")
    key.current ??= crypto.randomUUID()
    try {
      await callJson("/api/hr-documents/messages", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
        ...(mode === "hr" ? { employeeId } : {}), kind: request ? "REQUEST" : "MESSAGE", body: body.trim(), ...(documentId ? { documentId } : {}), key: key.current }) })
      key.current = null; setBody(""); setRequest(false); setDocumentId(""); setStatus(request ? "Demande de pièce envoyée." : "Message envoyé.")
      await load()
    } catch (err) { setError(err instanceof Error ? err.message : "Envoi impossible.") } finally { setSending(false) }
  }
  return <div className="rounded-xl border bg-white p-4">
    <h2 className="mb-1 font-semibold text-slate-900">Échanges privés</h2>
    <p className="mb-3 text-xs text-slate-500">{mode === "hr" ? "Visibles uniquement par ce salarié et les RH habilités." : "Visibles uniquement par vous et les RH habilités."} Aucun e-mail n’est envoyé.</p>
    {cursor && <button type="button" className="mb-3 rounded-lg border px-3 py-1.5 text-sm" onClick={() => void load(cursor)}>Charger les messages précédents</button>}
    {error && <p role="alert" className="mb-3 rounded-lg bg-red-50 p-3 text-sm text-red-800">{error}</p>}
    <MessageList mode={mode} messages={messages} attachable={attachable} onPreview={onPreview} onAnswerRequest={onAnswerRequest}/>
    {canWrite && <form className="mt-4 space-y-3 border-t pt-4" onSubmit={e => void send(e)}>
      <label className="block text-sm">Votre message<textarea required maxLength={2000} rows={3} value={body} onChange={e => { setBody(e.target.value); key.current = null }} className="mt-1 w-full rounded-lg border border-slate-300 bg-white p-2 text-sm"/></label>
      <div className="flex flex-wrap items-end gap-3">
        {attachable.length > 0 && <label className="min-w-48 text-sm">Joindre un document du dossier<select value={documentId} onChange={e => { setDocumentId(e.target.value); key.current = null }} className="mt-1 w-full rounded-lg border border-slate-300 bg-white p-2 text-sm"><option value="">Aucun</option>{attachable.map(d => <option key={d.id} value={d.id}>{d.title} · {d.period}</option>)}</select></label>}
        {canRequest && <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={request} onChange={e => { setRequest(e.target.checked); key.current = null }}/>Demander une pièce au salarié</label>}
        <button disabled={sending} className="rounded-lg bg-blue-800 px-4 py-2 text-sm text-white disabled:opacity-50">{request ? "Envoyer la demande" : "Envoyer"}</button>
      </div>
      <p aria-live="polite" className="text-xs text-green-800">{status}</p>
    </form>}
  </div>
}
