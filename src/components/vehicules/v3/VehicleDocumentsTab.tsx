"use client"

import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from "react"
import { isExplicitSubmit, preventImplicitEnter } from "../explicit-submit"
import { RefreshCw } from "lucide-react"
import { Button } from "@/components/ui/button"
import type { VehicleDocumentCategoryCode } from "@/lib/vehicules/v3/document-domain"
import { VehicleDocumentCategorySection } from "./VehicleDocumentCategorySection"
import {
  CATEGORY_FIELDS, VEHICLE_DOCUMENT_CATEGORY_LABELS, documentAlerts, documentUiError, groupDocumentsByCategory,
  type DocumentView, type DocumentVersionView, type DocumentsSnapshot,
} from "./vehicle-document-ui"
import { applyRecognition, createLatestOnly, recognitionChecks, resetUntouched, recognitionError, recognitionFieldLabel, recognitionSummary, type FilledFields, type RecognizableKey } from "./vehicle-document-recognition-ui"
import type { RecognitionProposal } from "@/lib/vehicules/v3/document-recognition-domain"
import { saveTicketDraft, ticketExpenseValues, withDocumentCorrections, type TicketValues } from "./expense-ticket-handoff"

const FIELD = "w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500"

type Dialog = { mode: "add"; category: VehicleDocumentCategoryCode } | { mode: "replace" | "edit"; document: DocumentView } | null

interface FormState { title: string; issuedOn: string; validFrom: string; validUntil: string; issuerName: string; referenceNumber: string; observations: string; mileage: string; maintenanceEntryId: string }
const EMPTY_FORM: FormState = { title: "", issuedOn: "", validFrom: "", validUntil: "", issuerName: "", referenceNumber: "", observations: "", mileage: "", maintenanceEntryId: "" }

type Recognition = { state: "idle" } | { state: "reading" } | { state: "done"; proposal: RecognitionProposal; filled: FilledFields } | { state: "error"; message: string }

/** Onglet Documents de la fiche camion : lecture à la demande, commandes idempotentes, aucune URL de fichier persistée côté client. */
export function VehicleDocumentsTab({ truckId, canManage, recognitionEnabled = false, expenseHandoff = null }: { truckId: string; canManage: boolean; recognitionEnabled?: boolean; expenseHandoff?: { companyId: string } | null }) {
  const id = useId()
  const [data, setData] = useState<DocumentsSnapshot | null>(null)
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [notice, setNotice] = useState("")
  const [dialog, setDialog] = useState<Dialog>(null)
  const [form, setForm] = useState<FormState>(EMPTY_FORM)
  const [file, setFile] = useState<File | null>(null)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [versions, setVersions] = useState<Record<string, DocumentVersionView[] | undefined>>({})
  const [settings, setSettings] = useState<{ thresholdsDays: number[]; revision: number } | null>(null)
  const [maintenance,setMaintenance]=useState<{id:string;kind:string;occurredAt:string;mileage:number}[]>([]),[maintenanceError,setMaintenanceError]=useState(""),[maintenanceLoading,setMaintenanceLoading]=useState(false)
  const [thresholdsInput, setThresholdsInput] = useState("")
  // Ticket enregistré et lu : valeurs structurées prêtes pour une dépense (jamais créée sans l'opérateur).
  const [ticketReady, setTicketReady] = useState<{ documentId: string; versionId: string; ticket: TicketValues } | null>(null)
  const pending = useRef<{ fingerprint: string; key: string } | null>(null)
  // Lecture automatique : chaque lecture porte un numéro ; une réponse dont le numéro n'est plus le courant (fichier
  // changé, formulaire fermé ou rouvert) est ignorée. Les champs modifiés à la main ne sont jamais réécrits.
  const [recognition, setRecognition] = useState<Recognition>({ state: "idle" })
  const latest = useRef(createLatestOnly()).current
  const touched = useRef<Set<string>>(new Set())
  const formRef = useRef(form)
  const initialForm = useRef<FormState>(EMPTY_FORM)
  formRef.current = form
  const base = `/api/trucks/${encodeURIComponent(truckId)}/documents`

  const refresh = useCallback(async (signal?: AbortSignal) => {
    setLoading(true); setError("")
    try {
      const response = await fetch(base, { cache: "no-store", signal })
      const body = await response.json()
      if (!response.ok) throw new Error(documentUiError(body.code))
      if (!signal?.aborted) { setData(body as DocumentsSnapshot); setVersions({}) }
    } catch (err) { if (!signal?.aborted) setError(err instanceof Error ? err.message : documentUiError()) }
    finally { if (!signal?.aborted) setLoading(false) }
  }, [base])

  useEffect(() => { const controller = new AbortController(); void refresh(controller.signal); return () => controller.abort() }, [refresh])

  useEffect(() => {
    if (!canManage) return
    const controller = new AbortController()
    fetch("/api/vehicle-documents/reminder-settings", { cache: "no-store", signal: controller.signal })
      .then(async (response) => { const body = await response.json(); if (response.ok && !controller.signal.aborted) { setSettings(body); setThresholdsInput(body.thresholdsDays.join(", ")) } })
      .catch(() => undefined)
    return () => controller.abort()
  }, [canManage])

  const needsMaintenance=dialog?.mode==="add"?dialog.category==="REPAIR_MAINTENANCE":(dialog?.mode==="replace"||dialog?.mode==="edit")&&dialog.document.category==="REPAIR_MAINTENANCE"
  useEffect(()=>{if(!needsMaintenance)return;const controller=new AbortController();setMaintenanceError("");setMaintenanceLoading(true);setMaintenance([]);void fetch(`/api/trucks/${encodeURIComponent(truckId)}/maintenance`,{cache:"no-store",signal:controller.signal}).then(async response=>{if(!response.ok)throw new Error();const body=await response.json();if(!controller.signal.aborted)setMaintenance(body.history)}).catch(()=>{if(!controller.signal.aborted)setMaintenanceError("Les interventions de ce véhicule sont indisponibles. Un lien déjà enregistré sera conservé.")}).finally(()=>{if(!controller.signal.aborted)setMaintenanceLoading(false)});return()=>controller.abort()},[truckId,needsMaintenance])

  const cancelRecognition = useCallback(() => latest.cancel(), [latest])
  useEffect(() => { touched.current = new Set(); setRecognition({ state: "idle" }); return cancelRecognition }, [dialog, cancelRecognition])

  const dialogCategory = dialog?.mode === "add" ? dialog.category : dialog ? dialog.document.category : null
  const recognize = async (selected: File | null) => {
    cancelRecognition()
    setRecognition({ state: "idle" })
    setForm((current) => resetUntouched(current, touched.current, initialForm.current))
    if (!recognitionEnabled || !selected || !dialogCategory || selected.size > 4 * 1024 * 1024) return
    const { token, signal } = latest.start(), category = dialogCategory
    setRecognition({ state: "reading" })
    try {
      const body = new FormData()
      body.set("payload", JSON.stringify({ category })); body.set("file", selected, selected.name)
      const response = await fetch(`${base}/recognize`, { method: "POST", body, signal })
      const result = await response.json().catch(() => ({}))
      if (!latest.isCurrent(token)) return
      if (!response.ok) { setRecognition({ state: "error", message: recognitionError(result.code) }); return }
      const proposal = result as RecognitionProposal
      // Mise à jour fonctionnelle : une frappe arrivée pendant la lecture est conservée ; les marques « lu » sont
      // calculées sur le dernier rendu, à titre indicatif.
      setForm((current) => applyRecognition(current, touched.current, proposal, category).form)
      setRecognition({ state: "done", proposal, filled: applyRecognition(formRef.current, touched.current, proposal, category).filled })
    } catch { if (latest.isCurrent(token)) setRecognition({ state: "error", message: recognitionError() }) }
  }
  /** Saisie de l'opérateur : le champ ne sera plus jamais rempli par la lecture et perd sa marque « lu ». */
  const edit = (key: RecognizableKey, value: string) => {
    touched.current.add(key)
    setForm((current) => ({ ...current, [key]: value }))
    setRecognition((current) => { if (current.state !== "done" || !current.filled[key]) return current; const filled = { ...current.filled }; delete filled[key]; return { ...current, filled } })
  }
  const filledFields: FilledFields = recognition.state === "done" ? recognition.filled : {}
  const mark = (key: RecognizableKey) => { const label = recognitionFieldLabel(filledFields[key]); return label ? <span className={filledFields[key] === "READ" ? "ml-1 font-normal text-emerald-700" : "ml-1 font-normal text-amber-700"}>· {label}</span> : null }
  const markedField = (key: RecognizableKey) => filledFields[key] === "TO_CHECK" ? FIELD.replace("border-slate-200", "border-amber-400") : FIELD

  const command = async (path: string, init: RequestInit, success: string) => {
    setBusy(true); setError(""); setNotice("")
    try {
      const response = await fetch(path, init)
      const body = await response.json().catch(() => ({}))
      if (!response.ok) { if (response.status < 500) pending.current = null; setError(documentUiError(body.code)); return null }
      pending.current = null
      setNotice(success)
      await refresh()
      return body as Record<string, unknown>
    } catch { setError("Connexion interrompue. Réessayez la même action : elle ne sera pas enregistrée deux fois."); return null }
    finally { setBusy(false) }
  }

  const openAdd = (category: VehicleDocumentCategoryCode) => { setTicketReady(null); const initial = { ...EMPTY_FORM, title: VEHICLE_DOCUMENT_CATEGORY_LABELS[category] }; initialForm.current = initial; setDialog({ mode: "add", category }); setForm(initial); setFile(null); setError("") }
  const openReplace = (document: DocumentView, mode: "replace" | "edit" = "replace") => {
    setTicketReady(null)
    const v = document.currentVersion
    setDialog({ mode, document })
    const initial = { title: document.title, issuedOn: v?.issuedOn ?? "", validFrom: v?.validFrom ?? "", validUntil: v?.validUntil ?? "", issuerName: v?.issuerName ?? "", referenceNumber: v?.referenceNumber ?? "", observations: v?.observations ?? "", mileage: v?.mileage?.toString() ?? "", maintenanceEntryId: v?.maintenanceEntryId ?? "" }
    initialForm.current = initial
    setForm(initial)
    setFile(null); setError("")
  }

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    if (!isExplicitSubmit(event)) return
    if (!dialog || busy) return
    if (!file && dialog.mode !== "edit") { setError("Choisissez un fichier PDF, JPEG ou PNG."); return }
    if(file && file.size>4*1024*1024){setError("Le fichier dépasse la limite de 4 Mio. Choisissez une version plus légère.");return}
    if (form.mileage && (!/^\d+$/.test(form.mileage) || Number(form.mileage) > 9999999)) { setError("Le kilométrage doit être un entier entre 0 et 9 999 999."); return }
    const category = dialog.mode === "add" ? dialog.category : dialog.document.category
    const metadata = {
      issuedOn: form.issuedOn || null, validFrom: form.validFrom || null, validUntil: form.validUntil || null,
      issuerName: form.issuerName.trim() || null, referenceNumber: form.referenceNumber.trim() || null, observations: form.observations.trim() || null,
      mileage: form.mileage ? Number(form.mileage) : null, maintenanceEntryId: category === "REPAIR_MAINTENANCE" && form.maintenanceEntryId.trim() ? form.maintenanceEntryId.trim() : null,
    }
    const payload = dialog.mode === "add"
      ? { category, title: form.title.trim(), ...metadata }
      : { expectedRevision: dialog.document.revision, title: form.title.trim() || undefined, ...metadata }
    const fingerprint = JSON.stringify([dialog.mode, dialog.mode !== "add" ? dialog.document.id : category, payload, file?.name, file?.size, file?.lastModified])
    if (pending.current?.fingerprint !== fingerprint) pending.current = { fingerprint, key: crypto.randomUUID() }
    let path: string, init: RequestInit
    if (dialog.mode === "edit" && !file) {
      path = `${base}/${encodeURIComponent(dialog.document.id)}`
      init = { method: "PATCH", headers: { "Content-Type": "application/json", "Idempotency-Key": pending.current.key }, body: JSON.stringify(payload) }
    } else {
      const body = new FormData()
      body.set("payload", JSON.stringify(payload)); body.set("file", file!, file!.name)
      path = dialog.mode === "add" ? base : `${base}/${encodeURIComponent(dialog.document.id)}/versions`
      init = { method: "POST", headers: { "Idempotency-Key": pending.current.key }, body }
    }
    // Lecture du fichier enregistré (même fichier : toute nouvelle sélection relance la lecture), ticket de dépense seulement.
    const reading = category === "EXPENSE_RECEIPT" && file && recognition.state === "done" && recognition.proposal.category === "EXPENSE_RECEIPT" ? recognition.proposal.expense ?? null : null
    const saved = await command(path, init, dialog.mode === "add" ? "Pièce enregistrée. Elle reste « à vérifier » tant qu'elle n'est pas validée." : "Modifications enregistrées dans une nouvelle version à vérifier. L'ancienne reste dans l'historique.")
    if (!saved) return
    const documentId = typeof saved.documentId === "string" ? saved.documentId : null, versionId = typeof saved.versionId === "string" ? saved.versionId : null
    setTicketReady(reading && expenseHandoff && documentId && versionId ? { documentId, versionId, ticket: withDocumentCorrections(ticketExpenseValues(reading), metadata, touched.current) } : null)
    setDialog(null)
  }
  /** Ouvre le formulaire de dépense prérempli : brouillon éphémère (session, 10 min, lecture unique), identifiant opaque. */
  const openTicketExpense = () => {
    if (!ticketReady || !expenseHandoff) return
    try {
      const draftId = saveTicketDraft(window.sessionStorage, { id: crypto.randomUUID(), companyId: expenseHandoff.companyId, truckId, documentId: ticketReady.documentId, versionId: ticketReady.versionId, ...ticketReady.ticket }, Date.now())
      window.location.assign(`/vehicules/${encodeURIComponent(truckId)}/couts?ticket=${draftId}`)
    } catch { setError("Préremplissage indisponible dans ce navigateur : saisissez la dépense dans Carburant et coûts.") }
  }

  const verify = (document: DocumentView) => document.currentVersion && command(`${base}/${encodeURIComponent(document.id)}/verify`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ expectedRevision: document.revision, versionId: document.currentVersion.id }) }, "Version validée.")
  const archive = (document: DocumentView) => {
    const reason = window.prompt(`Archiver « ${document.title} » ? Le dossier et ses versions restent consultables.\nMotif :`)
    if (!reason?.trim()) return
    void command(`${base}/${encodeURIComponent(document.id)}/archive`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ expectedRevision: document.revision, reason: reason.trim() }) }, "Dossier archivé.")
  }
  const toggleVersions = async (document: DocumentView) => {
    if (expandedId === document.id) { setExpandedId(null); return }
    setExpandedId(document.id)
    if (versions[document.id]) return
    try {
      const response = await fetch(`${base}/${encodeURIComponent(document.id)}`, { cache: "no-store" })
      const body = await response.json()
      if (!response.ok) throw new Error(documentUiError(body.code))
      setVersions((current) => ({ ...current, [document.id]: body.versions as DocumentVersionView[] }))
    } catch (err) { setError(err instanceof Error ? err.message : documentUiError()) }
  }
  const saveThresholds = async (event: FormEvent<HTMLFormElement>) => {
    if (!isExplicitSubmit(event)) return
    if (!settings) return
    const values = thresholdsInput.split(/[,\s;]+/).filter(Boolean).map(Number)
    if (!values.length || values.some((value) => !Number.isInteger(value) || value < 0 || value > 3650)) { setError("Indiquez un à six seuils entiers en jours (0 à 3650), par exemple 30, 7."); return }
    setBusy(true); setError(""); setNotice("")
    try {
      const response = await fetch("/api/vehicle-documents/reminder-settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ thresholdsDays: values, expectedRevision: settings.revision }) })
      const body = await response.json()
      if (!response.ok) { setError(documentUiError(body.code)); return }
      setSettings(body); setThresholdsInput(body.thresholdsDays.join(", ")); setNotice("Seuils de rappel enregistrés.")
      await refresh()
    } catch { setError("Connexion interrompue. Réessayez.") }
    finally { setBusy(false) }
  }

  const alerts = data ? documentAlerts(data.documents) : null
  const category = dialog?.mode === "add" ? dialog.category : dialog ? dialog.document.category : null
  const fields = category ? CATEGORY_FIELDS[category] : null

  return <div className="space-y-4" aria-busy={loading || busy}>
    <div className="flex flex-wrap items-start justify-between gap-3 rounded-lg bg-slate-50 p-3">
      <div>
        <p className="text-sm font-semibold text-slate-800">Documents du véhicule</p>
        <p className="text-xs text-slate-500">Pièces privées, versions conservées, statut documentaire distinct de l'état du camion.</p>
        {alerts && <p className="mt-1 text-xs text-slate-600">{alerts.expired} expiré{alerts.expired > 1 ? "s" : ""} · {alerts.expiring} bientôt échu{alerts.expiring > 1 ? "s" : ""} · {alerts.toVerify} à vérifier{data ? ` · échéances calculées au ${data.today.split("-").reverse().join("/")} (${data.timezone})` : ""}</p>}
      </div>
      <Button type="button" size="sm" variant="outline" disabled={loading || busy} onClick={() => void refresh()} aria-label="Actualiser les documents"><RefreshCw className="h-4 w-4" aria-hidden="true" /></Button>
    </div>
    {loading && <p role="status" className="text-sm text-slate-500">Chargement des documents…</p>}
    {error && !dialog && <p role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</p>}
    {notice && <p role="status" className="text-sm text-emerald-700">{notice}</p>}
    {ticketReady && <div className="flex flex-wrap items-center gap-2 rounded-lg bg-slate-50 p-3 text-sm">
      <span>Ticket lu : la dépense peut être préremplie avec ce justificatif lié. Vous vérifierez avant de la valider.</span>
      <Button type="button" size="sm" disabled={busy} onClick={openTicketExpense}>Créer la dépense depuis ce ticket</Button>
    </div>}
    {data && !data.truckActive && <p className="text-sm text-slate-500">Véhicule archivé : documents consultables, ajout et remplacement désactivés.</p>}
    {data && groupDocumentsByCategory(data).map((group) => <VehicleDocumentCategorySection key={group.code} truckId={truckId} category={group} active={group.active} archived={group.archived}
      canManage={canManage} truckActive={data.truckActive} busy={busy} expandedId={expandedId} versions={versions}
      onToggleVersions={(document) => void toggleVersions(document)} onVerify={(document) => void verify(document)} onReplace={(document)=>openReplace(document)} onEdit={(document)=>openReplace(document,"edit")} onArchive={archive} onAdd={openAdd} />)}
    {canManage && settings && <form onKeyDown={preventImplicitEnter} onSubmit={saveThresholds} className="rounded-xl border border-slate-200 bg-white p-4">
      <h3 className="text-sm font-semibold text-slate-800">Rappels internes</h3>
      <p className="mt-1 text-xs text-slate-500">Une notification est envoyée aux administrateurs à chaque seuil avant l'échéance, puis à l'expiration. Un rappel déjà envoyé n'est jamais répété pour la même version.</p>
      <div className="mt-2 flex flex-wrap items-end gap-2">
        <div className="flex-1"><label htmlFor={`${id}-thresholds`} className="mb-1 block text-xs font-medium text-slate-600">Seuils en jours avant échéance</label><input id={`${id}-thresholds`} className={FIELD} value={thresholdsInput} disabled={busy} onChange={(e) => setThresholdsInput(e.target.value)} placeholder="30, 7" /></div>
        <Button type="submit" data-explicit-submit="true" size="sm" variant="outline" disabled={busy}>Valider les seuils</Button>
      </div>
    </form>}

    {dialog && fields && <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/50"  />
      <form onKeyDown={preventImplicitEnter} onSubmit={submit} role="dialog" aria-modal="true" aria-label={dialog.mode === "add" ? "Ajouter une pièce" : dialog.mode === "edit" ? "Modifier les informations" : "Remplacer la pièce"} className="relative z-10 mx-4 max-h-[90vh] overflow-y-auto w-full max-w-lg space-y-3 rounded-2xl bg-white p-6 shadow-xl">
        <div>
          <h2 className="text-lg font-semibold text-slate-900">{dialog.mode === "add" ? `Ajouter — ${VEHICLE_DOCUMENT_CATEGORY_LABELS[category!]}` : `${dialog.mode === "edit" ? "Modifier" : "Remplacer"} — ${dialog.document.title}`}</h2>
          <p className="text-sm text-slate-500">{dialog.mode === "add" ? "La pièce sera enregistrée « à vérifier » jusqu'à sa validation." : "Les informations sont préremplies. Le fichier actuel est conservé si vous n’en choisissez pas un autre. Aucune modification n’est enregistrée avant validation."}</p>
        </div>
        {error && <p role="alert" className="rounded bg-red-50 p-2 text-sm text-red-700">{error}</p>}
        <div><label htmlFor={`${id}-title`} className="mb-1 block text-xs font-medium text-slate-600">Intitulé</label><input id={`${id}-title`} className={FIELD} required maxLength={200} value={form.title} disabled={busy} onChange={(e) => setForm({ ...form, title: e.target.value })} /></div>
        <div><label htmlFor={`${id}-file`} className="mb-1 block text-xs font-medium text-slate-600">Fichier {dialog.mode === "edit" ? "facultatif — fichier actuel conservé" : "(PDF, JPEG ou PNG, 4 Mio maximum)"}</label><input id={`${id}-file`} className={FIELD} type="file" required={dialog.mode !== "edit"} accept="application/pdf,image/jpeg,image/png" disabled={busy} onChange={(e) => { const selected = e.target.files?.[0] ?? null; setFile(selected); void recognize(selected) }} />
          {recognition.state === "reading" && <p role="status" className="mt-1 text-xs text-slate-500">Lecture du document en cours… Vous pouvez saisir les champs en attendant : vos saisies seront conservées.</p>}
          {recognition.state === "error" && <p role="status" className="mt-1 text-xs text-amber-700">{recognition.message}</p>}
          {recognition.state === "done" && (() => { const summary = recognitionSummary(recognition.proposal, Object.keys(recognition.filled).length); return <div role="status" className="mt-1 space-y-0.5 text-xs">
            <p className={summary.tone === "info" ? "rounded bg-blue-50 p-2 text-blue-800" : "rounded bg-amber-50 p-2 text-amber-800"}>{summary.text}</p>
            {recognitionChecks(recognition.proposal).map((check) => <p key={check.text} className={check.tone === "ok" ? "text-emerald-700" : "text-amber-700"}>{check.text}</p>)}
          </div> })()}
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div><label htmlFor={`${id}-issued`} className="mb-1 block text-xs font-medium text-slate-600">{fields.issuedOn}{mark("issuedOn")}</label><input id={`${id}-issued`} className={markedField("issuedOn")} type="date" value={form.issuedOn} disabled={busy} onChange={(e) => edit("issuedOn", e.target.value)} /></div>
          {fields.validFrom && <div><label htmlFor={`${id}-from`} className="mb-1 block text-xs font-medium text-slate-600">{fields.validFrom}{mark("validFrom")}</label><input id={`${id}-from`} className={markedField("validFrom")} type="date" value={form.validFrom} disabled={busy} onChange={(e) => edit("validFrom", e.target.value)} /></div>}
          {fields.validUntil && <div><label htmlFor={`${id}-until`} className="mb-1 block text-xs font-medium text-slate-600">{fields.validUntil}{mark("validUntil")}</label><input id={`${id}-until`} className={markedField("validUntil")} type="date" value={form.validUntil} disabled={busy} onChange={(e) => edit("validUntil", e.target.value)} /></div>}
          {fields.issuerName && <div><label htmlFor={`${id}-issuer`} className="mb-1 block text-xs font-medium text-slate-600">{fields.issuerName}{mark("issuerName")}</label><input id={`${id}-issuer`} className={markedField("issuerName")} maxLength={200} value={form.issuerName} disabled={busy} onChange={(e) => edit("issuerName", e.target.value)} /></div>}
          {fields.referenceNumber && <div><label htmlFor={`${id}-ref`} className="mb-1 block text-xs font-medium text-slate-600">{fields.referenceNumber}{mark("referenceNumber")}</label><input id={`${id}-ref`} className={markedField("referenceNumber")} maxLength={100} value={form.referenceNumber} disabled={busy} onChange={(e) => edit("referenceNumber", e.target.value)} /></div>}
          {fields.mileage && <div><label htmlFor={`${id}-km`} className="mb-1 block text-xs font-medium text-slate-600">Kilométrage indiqué (facultatif){mark("mileage")}</label><input id={`${id}-km`} className={markedField("mileage")} type="number" inputMode="numeric" min={0} max={9999999} step={1} value={form.mileage} disabled={busy} onChange={(e) => edit("mileage", e.target.value)} /></div>}
          {fields.maintenance && <div><label htmlFor={`${id}-maint`} className="mb-1 block text-xs font-medium text-slate-600">Intervention liée (facultatif)</label><select id={`${id}-maint`} className={FIELD} value={form.maintenanceEntryId} disabled={busy} onChange={(e)=>setForm({...form,maintenanceEntryId:e.target.value})}><option value="">Aucune intervention</option>{form.maintenanceEntryId&&!maintenance.some(entry=>entry.id===form.maintenanceEntryId)&&<option value={form.maintenanceEntryId}>Intervention déjà liée — historique conservé</option>}{maintenance.map(entry=><option key={entry.id} value={entry.id}>{entry.kind==="OIL_CHANGE"?"Vidange":"Entretien"} — {new Date(entry.occurredAt).toLocaleDateString("fr-FR",{timeZone:data?.timezone||"Europe/Paris"})} — {entry.mileage.toLocaleString("fr-FR")} km</option>)}</select>{maintenanceError&&<p role="status" className="text-xs text-amber-700">{maintenanceError}</p>}{maintenanceLoading&&<p role="status" className="text-xs text-slate-500">Chargement des interventions...</p>}{!maintenanceLoading&&!maintenanceError&&!maintenance.length&&<p className="text-xs text-slate-500">Aucune intervention disponible pour ce véhicule.</p>}</div>}
        </div>
        <div><label htmlFor={`${id}-obs`} className="mb-1 block text-xs font-medium text-slate-600">Observations (facultatif){mark("observations")}</label><textarea id={`${id}-obs`} className={markedField("observations")} rows={2} maxLength={2000} value={form.observations} disabled={busy} onChange={(e) => edit("observations", e.target.value)} /></div>
        {fields.mileage && <p className="text-xs text-slate-500">Le kilométrage indiqué sur la pièce est conservé à titre d'information : le compteur du véhicule n'est jamais modifié.</p>}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => setDialog(null)}>Annuler</Button>
          <Button type="submit" data-explicit-submit="true" size="sm" className="bg-[#0f3460] hover:bg-[#0a2540]" disabled={busy}>{busy ? "Enregistrement…" : dialog.mode === "add" ? "Valider l’ajout" : "Valider les modifications"}</Button>
        </div>
      </form>
    </div>}
  </div>
}
