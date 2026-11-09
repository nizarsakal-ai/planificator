"use client"
import { useRef, useState } from "react"
import { callJson, type Category, type FolderDoc } from "./space-client"

/**
 * Transmission d'une pièce par le salarié à ses RH : aucun choix de salarié (le serveur impose celui de la session),
 * la pièce reste « reçue, à vérifier » et n'est jamais validée ni publiée automatiquement.
 */
export function EmployeeSubmission({ categories, images, requestId, onSubmitted, onCancelRequest }: {
  categories: Category[]; images: boolean; requestId?: string; onSubmitted: () => void; onCancelRequest: () => void
}) {
  const [sending, setSending] = useState(false), [error, setError] = useState(""), [formKey, setFormKey] = useState(0)
  const key = useRef<string | null>(null)
  const accept = images ? "application/pdf,.pdf,image/jpeg,.jpg,.jpeg,image/png,.png,image/heic,.heic" : "application/pdf,.pdf"
  return <form key={formKey} className="grid gap-3 rounded-xl border bg-white p-4 sm:grid-cols-2" onSubmit={async e => {
    e.preventDefault(); if (sending) return
    const form = new FormData(e.currentTarget)
    key.current ??= crypto.randomUUID(); form.set("key", key.current)
    if (requestId) form.set("requestId", requestId)
    setSending(true); setError("")
    try {
      await callJson("/api/hr-documents/submissions", { method: "POST", body: form })
      key.current = null; setFormKey(k => k + 1); onSubmitted()
    } catch (err) { setError(err instanceof Error ? err.message : "Transmission impossible.") } finally { setSending(false) }
  }} onChange={() => { key.current = null }}>
    <h2 className="font-semibold text-slate-900 sm:col-span-2">Transmettre une pièce aux RH</h2>
    {requestId && <p className="flex flex-wrap items-center gap-2 rounded-lg bg-amber-50 p-2 text-sm text-amber-900 sm:col-span-2">En réponse à une demande de pièce des RH.
      <button type="button" className="underline" onClick={onCancelRequest}>Ne pas lier à la demande</button></p>}
    <label className="text-sm">Type de pièce<select required name="category" defaultValue={categories.some(c => c.code === "OTHER") ? "OTHER" : ""} className="mt-1 w-full rounded-lg border border-slate-300 bg-white p-2 text-sm">
      <option value="">Choisir</option>{categories.map(c => <option key={c.code} value={c.code}>{c.label}</option>)}</select></label>
    <label className="text-sm">Période concernée<input required type="month" name="period" className="mt-1 w-full rounded-lg border border-slate-300 bg-white p-2 text-sm"/></label>
    <label className="text-sm sm:col-span-2">Intitulé<input required maxLength={120} name="title" className="mt-1 w-full rounded-lg border border-slate-300 bg-white p-2 text-sm"/></label>
    <label className="text-sm sm:col-span-2">Fichier ({images ? "PDF, JPG, PNG ou HEIC" : "PDF"}, 10 Mo au maximum)<input required type="file" name="file" accept={accept} disabled={sending} className="mt-1 block max-w-full text-sm"/></label>
    {error && <p role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-800 sm:col-span-2">{error}</p>}
    <p className="text-xs text-slate-500 sm:col-span-2">La pièce sera vérifiée par les RH avant toute utilisation. Elle n’est visible que par vous et les RH habilités.</p>
    <button disabled={sending} className="w-fit rounded-lg bg-blue-800 px-4 py-2 text-sm text-white disabled:opacity-50">{sending ? "Transmission…" : "Transmettre aux RH"}</button>
  </form>
}

/**
 * Reprise d'un envoi resté « en cours » (échec réseau ou Drive, onglet fermé) : le salarié resélectionne le même fichier.
 * Le serveur vérifie qu'il s'agit bien de son dépôt et du même contenu ; sinon la reprise est refusée.
 */
export function ResumeSubmission({ doc, onResumed, onCancel }: { doc: FolderDoc; onResumed: () => void; onCancel: () => void }) {
  const [sending, setSending] = useState(false), [error, setError] = useState("")
  return <form aria-label="Reprendre l’envoi" className="grid gap-3 rounded-xl border border-amber-200 bg-white p-4" onSubmit={async e => {
    e.preventDefault(); if (sending) return
    const form = new FormData(e.currentTarget); form.set("expectedVersion", String(doc.version))
    setSending(true); setError("")
    try { await callJson(`/api/hr-documents/submissions/${encodeURIComponent(doc.id)}/resume`, { method: "POST", body: form }); onResumed() }
    catch (err) { setError(err instanceof Error ? err.message : "Reprise impossible.") } finally { setSending(false) }
  }}>
    <h2 className="font-semibold text-slate-900">Reprendre l’envoi : {doc.title}</h2>
    <p className="text-sm text-slate-600">Sélectionnez le même fichier que lors du premier envoi. Un autre fichier sera refusé.</p>
    <label className="text-sm">Fichier<input required type="file" name="file" disabled={sending} className="mt-1 block max-w-full text-sm"/></label>
    {error && <p role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-800">{error}</p>}
    <div className="flex flex-wrap gap-2">
      <button disabled={sending} className="rounded-lg bg-blue-800 px-4 py-2 text-sm text-white disabled:opacity-50">{sending ? "Reprise…" : "Reprendre l’envoi"}</button>
      <button type="button" disabled={sending} className="rounded-lg border px-4 py-2 text-sm" onClick={onCancel}>Annuler</button>
    </div>
  </form>
}
