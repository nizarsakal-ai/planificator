"use client"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import Link from "next/link"
import { DocumentFolders } from "./DocumentFolders"
import { categoryDefinition, categoryLabel, type CategoryFamily } from "@/lib/hr-documents/catalog"
import { fetchHrDocument } from "@/lib/hr-documents/download-client"
import { DocumentPreview, saveBlob, type PreviewTarget } from "./DocumentPreview"
import { HrMessages } from "./HrMessages"
import { EmployeeSubmission, ResumeSubmission } from "./EmployeeSubmission"
import { callJson, type Category, type FolderDoc, type SpaceMode } from "./space-client"
export type { Category, FolderDoc, SpaceMode }

/**
 * Espace privé RH ↔ salarié, intégré au dossier de l'employé (côté RH) ou à « Mes documents » (côté salarié).
 * Aucune confidentialité ne repose sur ce composant : chaque liste, message, aperçu et téléchargement est filtré
 * côté serveur (société, salarié, habilitation). Ici, on ne fait qu'afficher ce que le serveur renvoie.
 */

export const FAMILY_LABELS: Record<CategoryFamily, string> = {
  PAY: "Paie", CONTRACT: "Contrat", IDENTITY: "Identité", SOCIAL: "Social", HEALTH: "Santé", QUALIFICATION: "Qualifications", OTHER: "Autres documents",
}
const FAMILY_ORDER: CategoryFamily[] = ["PAY", "CONTRACT", "IDENTITY", "SOCIAL", "HEALTH", "QUALIFICATION", "OTHER"]
/** Libellés factuels : aucun ne signifie signature, acceptation ou remise légale. */
const STATUS: Record<SpaceMode, Record<string, string>> = {
  hr: { UPLOADING: "Dépôt à reprendre", READY: "À vérifier", REVIEWED: "Vérifié, à publier", PUBLISHED: "Envoyé au salarié", BLOCKED: "Remise suspendue",
    RECEIVING: "Dépôt du salarié en cours", RECEIVED: "Reçu du salarié, à vérifier" },
  employee: { PUBLISHED: "Reçu des RH", RECEIVING: "Envoi en cours", RECEIVED: "Transmis aux RH", READY: "En vérification RH", REVIEWED: "En vérification RH" },
}
export function statusLabel(mode: SpaceMode, status: string) { return STATUS[mode][status] ?? "Statut inconnu" }
const VIEWABLE = ["RECEIVED", "READY", "REVIEWED", "PUBLISHED"]
/**
 * Documents proposables en pièce jointe : ceux que le salarié peut lui-même voir (publiés, ou ses dépôts suivis),
 * jamais un dépôt bloqué ou en cours. Simple confort d'affichage : le serveur refuse de toute façon les autres.
 */
export const attachableDocs = (docs: FolderDoc[]) => docs.filter(d => d.status === "PUBLISHED" || (!!d.fromEmployee && ["RECEIVED", "READY", "REVIEWED"].includes(d.status)))
export const familyOf = (category: string): CategoryFamily => categoryDefinition(category)?.family ?? "OTHER"
const date = (value?: string | null) => value ? new Intl.DateTimeFormat("fr-FR", { day: "2-digit", month: "short", year: "numeric" }).format(new Date(value)) : null

/** Vue dossier, sans état réseau : dossiers par famille, recherche, grille ou liste. Rendu testable hors navigateur. */
export function HrFolderView({ mode, docs, complete, family, query, view, canAccept, busy, onFamily, onQuery, onView, onPreview, onDownload, onAccept, onResume }: {
  mode: SpaceMode; docs: FolderDoc[]; complete: boolean; family: CategoryFamily | null; query: string; view: "grid" | "list"; canAccept: boolean; busy: boolean
  onFamily: (f: CategoryFamily | null) => void; onQuery: (q: string) => void; onView: (v: "grid" | "list") => void
  onPreview: (doc: FolderDoc, trigger: HTMLButtonElement) => void; onDownload: (doc: FolderDoc) => void; onAccept: (doc: FolderDoc) => void
  onResume?: (doc: FolderDoc) => void
}) {
  const counts = new Map<CategoryFamily, number>()
  for (const d of docs) counts.set(familyOf(d.category), (counts.get(familyOf(d.category)) ?? 0) + 1)
  const scope = complete ? "" : " chargés"
  const needle = query.trim().toLocaleLowerCase("fr")
  const shown = docs.filter(d => (!family || familyOf(d.category) === family) &&
    (!needle || `${d.title} ${categoryLabel(d.category)} ${d.period}`.toLocaleLowerCase("fr").includes(needle)))
  const folder = (f: CategoryFamily | null, label: string, count: number) =>
    <button key={f ?? "all"} type="button" aria-pressed={family === f} onClick={() => onFamily(f)}
      className={`flex min-w-36 items-center gap-2 rounded-lg border px-3 py-2 text-left text-sm ${family === f ? "border-blue-300 bg-blue-50 font-semibold text-blue-900" : "border-slate-200 bg-white text-slate-700 hover:bg-slate-50"}`}>
      <svg aria-hidden="true" viewBox="0 0 24 24" className="h-5 w-5 shrink-0 fill-current text-blue-700"><path d="M3 6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>
      <span className="min-w-0 flex-1 truncate">{label}</span><span className="text-xs text-slate-500">{count}{scope}</span>
    </button>
  const renderDoc = (doc: FolderDoc, month?: string) => {
      const viewable = VIEWABLE.includes(doc.status)
      return <li key={doc.id} className={view === "grid" ? "px-3 py-3" : "rounded-xl border border-slate-200 bg-white p-4"}>
        <div className="flex flex-wrap items-start justify-between gap-2"><div className="min-w-0">
          <h3 className="break-words font-semibold text-slate-900">{month ?? doc.title}</h3>
          {month && <p className="break-words text-xs text-slate-600">{doc.title}</p>}
          <p className="text-sm text-slate-600">{categoryLabel(doc.category)} · {doc.period}{date(doc.createdAt) ? ` · déposé le ${date(doc.createdAt)}` : ""}</p>
          {doc.fromEmployee && mode === "hr" && <p className="text-xs font-medium text-blue-950">Transmis par le salarié</p>}
          {mode === "hr" && doc.status === "PUBLISHED" && <p className="text-xs text-slate-600">{doc.openedAt ? `Ouvert par le salarié le ${date(doc.openedAt)}` : "Pas encore ouvert par le salarié"}</p>}
        </div><span className="h-fit rounded-full bg-blue-50 px-3 py-1 text-xs text-blue-900">{statusLabel(mode, doc.status)}</span></div>
        {viewable && <div className="mt-3 flex flex-wrap gap-2">
          <button type="button" aria-haspopup="dialog" className="rounded-lg border border-blue-200 px-3 py-2 text-sm text-blue-900" onClick={e => onPreview(doc, e.currentTarget)}>Visualiser</button>
          <button type="button" className="rounded-lg border border-blue-200 px-3 py-2 text-sm text-blue-900" onClick={() => onDownload(doc)}>Télécharger</button>
          {mode === "hr" && canAccept && doc.status === "RECEIVED" && <button type="button" disabled={busy} className="rounded-lg border px-3 py-2 text-sm disabled:opacity-50" onClick={() => onAccept(doc)}>Passer en vérification</button>}
        </div>}
        {mode === "employee" && onResume && doc.fromEmployee && doc.status === "RECEIVING" && <div className="mt-3">
          <p className="text-xs text-slate-600">L’envoi de ce fichier n’a pas abouti. Vous pouvez le reprendre en sélectionnant le même fichier.</p>
          <button type="button" className="mt-2 rounded-lg border border-blue-200 px-3 py-2 text-sm text-blue-900" onClick={() => onResume(doc)}>Reprendre l’envoi</button>
        </div>}
      </li>
  }
  return <div className="space-y-4">
    <div className="flex flex-wrap gap-2" role="group" aria-label="Dossiers">
      {folder(null, "Tous les documents", docs.length)}
      {FAMILY_ORDER.filter(f => counts.has(f)).map(f => folder(f, FAMILY_LABELS[f], counts.get(f)!))}
    </div>
    {!complete && <p className="text-xs text-slate-500">Compteurs limités aux documents chargés. Utilisez « Charger la suite » pour parcourir les autres.</p>}
    <div className="flex flex-wrap items-end gap-3">
      <label className="min-w-48 flex-1 text-sm">Rechercher dans le dossier<input type="search" value={query} onChange={e => onQuery(e.target.value)} placeholder="Titre, catégorie ou période" className="w-full rounded-lg border border-slate-300 bg-white p-2 text-sm"/></label>
      <div className="flex gap-1" role="group" aria-label="Présentation">
        {(["grid", "list"] as const).map(v => <button key={v} type="button" aria-pressed={view === v} onClick={() => onView(v)}
          className={`rounded-lg border px-3 py-2 text-sm ${view === v ? "border-blue-300 bg-blue-50 text-blue-900" : "border-slate-200 text-slate-600"}`}>{v === "grid" ? "Grille" : "Liste"}</button>)}
      </div>
    </div>
    {!shown.length && <p className="py-6 text-sm text-slate-600">{docs.length ? "Aucun document ne correspond à cette sélection." : "Aucun document dans ce dossier."}</p>}
    {view === "grid" ? <DocumentFolders documents={shown} renderDocument={renderDoc}/> : <ul className="space-y-3">{shown.map(doc => renderDoc(doc))}</ul>}
  </div>
}

type ListResponse = { documents: FolderDoc[]; nextCursor: string | null }

/** Conteneur : chargement paginé (25 par page, comme la route existante), aperçu, téléchargement volontaire, échanges. */
export function HrPrivateSpace({ mode, employeeId, categories, canAccept = false, canWrite = false, images = false, manageHref }: {
  mode: SpaceMode; employeeId?: string; categories: Category[]; canAccept?: boolean; canWrite?: boolean; images?: boolean; manageHref?: string
}) {
  const [docs, setDocs] = useState<FolderDoc[]>([]), [cursor, setCursor] = useState<string | null>(null)
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false)
  const [error, setError] = useState(""), [notice, setNotice] = useState("")
  const [family, setFamily] = useState<CategoryFamily | null>(null), [query, setQuery] = useState(""), [view, setView] = useState<"grid" | "list">("grid")
  const [preview, setPreview] = useState<PreviewTarget | null>(null), trigger = useRef<HTMLButtonElement | null>(null)
  const [requestId, setRequestId] = useState<string | undefined>(), [threadVersion, setThreadVersion] = useState(0)
  const [resuming, setResuming] = useState<FolderDoc | null>(null)
  const loadVersion = useRef(0)
  const base = mode === "hr" ? `/api/hr-documents?manage=true&employeeId=${encodeURIComponent(employeeId ?? "")}` : "/api/hr-documents?manage=false"
  const load = useCallback(async (next?: string) => {
    const version = ++loadVersion.current
    setLoading(true); setError("")
    try {
      const data = await callJson<ListResponse>(`${base}${next ? `&cursor=${encodeURIComponent(next)}` : ""}`)
      if (version !== loadVersion.current) return
      setDocs(old => next ? [...old, ...data.documents] : data.documents); setCursor(data.nextCursor)
    } catch (e) { if (version === loadVersion.current) setError(e instanceof Error ? e.message : "Service indisponible.") }
    finally { if (version === loadVersion.current) setLoading(false) }
  }, [base])
  // Changement de dossier : rien de l'ancien dossier ne reste affiché sous le nouveau (en plus de la clé posée par la fiche).
  useEffect(() => { setDocs([]); setCursor(null); setPreview(null); setRequestId(undefined); setResuming(null); setNotice(""); setError("") }, [base])
  useEffect(() => { void load(); return () => { loadVersion.current++ } }, [load])
  const refresh = () => { void load(); setThreadVersion(v => v + 1) }
  const download = (doc: FolderDoc) => { setError(""); void fetchHrDocument(doc.id).then(d => saveBlob(d.blob, d.name)).catch(e => setError(e instanceof Error ? e.message : "Téléchargement indisponible.")) }
  const accept = async (doc: FolderDoc) => {
    setBusy(true); setError(""); setNotice("")
    try {
      await callJson(`/api/hr-documents/${encodeURIComponent(doc.id)}/accept`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ expectedVersion: doc.version, key: crypto.randomUUID() }) })
      setNotice("Pièce passée en vérification. La revue et la publication restent séparées."); refresh()
    } catch (e) { setError(e instanceof Error ? e.message : "Opération indisponible.") } finally { setBusy(false) }
  }
  const attachable = useMemo(() => attachableDocs(docs), [docs])
  return <section className="space-y-4" aria-label={mode === "hr" ? "Dossier RH de l’employé" : "Mon espace RH"}>
    <p className="rounded-lg border border-blue-100 bg-blue-50 p-3 text-sm text-blue-950">{mode === "hr"
      ? "Espace privé entre ce salarié et les RH habilités. Le suivi indique des faits (envoyé, reçu, ouvert) : ce n’est ni une signature, ni une acceptation."
      : "Espace privé entre vous et les RH. Vous voyez les documents qui vous sont adressés et les pièces que vous avez transmises."}</p>
    {error && <p role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-800">{error} <button type="button" className="underline" onClick={() => void load()}>Actualiser</button></p>}
    {notice && <p role="status" className="rounded-lg bg-green-50 p-3 text-sm text-green-900">{notice}</p>}
    <div className="rounded-xl border bg-white p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2"><h2 className="font-semibold text-slate-900">Documents</h2>
        {mode === "hr" && manageHref && <Link href={manageHref} className="text-sm text-blue-900 underline">Gérer dans Documents RH</Link>}</div>
      {loading && !docs.length ? <p role="status" className="text-sm text-slate-600">Chargement…</p>
        : <HrFolderView mode={mode} docs={docs} complete={!cursor} family={family} query={query} view={view} canAccept={canAccept} busy={busy}
          onFamily={setFamily} onQuery={setQuery} onView={setView} onDownload={download} onAccept={d => void accept(d)} onResume={mode === "employee" ? setResuming : undefined}
          onPreview={(d, el) => { trigger.current = el; setError(""); setPreview(old => old?.id === d.id ? old : { id: d.id, title: d.title }) }}/>}
      {cursor && <button type="button" className="mt-4 rounded-lg border px-4 py-2 text-sm" disabled={loading} onClick={() => void load(cursor)}>Charger la suite</button>}
    </div>
    {mode === "employee" && resuming && <ResumeSubmission doc={resuming} onCancel={() => setResuming(null)}
      onResumed={() => { setResuming(null); setNotice("Envoi repris : pièce transmise aux RH."); refresh() }}/>}
    {mode === "employee" && <EmployeeSubmission categories={categories} images={images} requestId={requestId} onCancelRequest={() => setRequestId(undefined)}
      onSubmitted={() => { setRequestId(undefined); setNotice("Pièce transmise aux RH. Elle sera vérifiée avant toute utilisation."); refresh() }}/>}
    <HrMessages mode={mode} employeeId={employeeId} canWrite={mode === "employee" || canWrite} canRequest={mode === "hr" && canWrite} version={threadVersion}
      attachable={attachable} onPreview={(id, title, el) => { trigger.current = el; setPreview(old => old?.id === id ? old : { id, title }) }}
      onAnswerRequest={mode === "employee" ? setRequestId : undefined}/>
    <DocumentPreview target={preview} onClose={() => setPreview(null)} returnFocus={trigger}/>
  </section>
}
