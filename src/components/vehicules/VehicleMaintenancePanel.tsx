"use client"

import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from "react"
import { useRouter } from "next/navigation"
import { RefreshCw, Wrench } from "lucide-react"
import { preventImplicitEnter, isExplicitSubmit } from "./explicit-submit"
import { Button } from "@/components/ui/button"
import type { MaintenanceReadDto } from "@/lib/vehicules/maintenance-service"

export type MaintenanceSummary = MaintenanceReadDto["summary"]
const FIELD = "w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500"
const km = (value: number) => `${value.toLocaleString("fr-FR")} km`
const day = (value: string) => new Date(value).toLocaleDateString("fr-FR", { timeZone: "UTC" })

export function maintenanceSummaryLabel(summary?: MaintenanceSummary | null) {
  switch (summary?.status) {
    case "DUE": return "Vidange à faire"
    case "SOON": return "Vidange bientôt"
    case "OK": return "Vidange à jour"
    case "NO_HISTORY": return "Première vidange à renseigner"
    case "UNKNOWN_MILEAGE": return "Compteur à renseigner"
    case "INCONSISTENT_MILEAGE": return "Compteur à vérifier"
    default: return "Périodicité à définir"
  }
}
export function maintenanceUiError(code?: string) {
  const errors: Record<string, string> = {
    MAINTENANCE_CORRECTION_CONFLICT: "Cette intervention a déjà été modifiée. Actualisez avant de recommencer.",
    MAINTENANCE_ENTRY_NOT_FOUND: "Cette intervention n’est plus accessible.",
    MAINTENANCE_PLAN_CONFLICT: "La périodicité a changé entre-temps. Actualisez puis vérifiez votre saisie.",
    MAINTENANCE_FUTURE_DATE: "La date de l’intervention ne peut pas être dans le futur.",
    MAINTENANCE_ABOVE_CURRENT_MILEAGE: "Ce kilométrage dépasse le compteur actuel. Enregistrez d’abord un relevé dans Kilométrage et trajets.",
    MAINTENANCE_MILEAGE_ORDER: "Ce kilométrage est incohérent avec les interventions précédentes ou suivantes.",
    TRUCK_ARCHIVED: "Le véhicule est archivé. Restaurez-le avant toute saisie.",
    FORBIDDEN: "Votre rôle ne permet pas de modifier l’entretien.",
    UNAUTHENTICATED: "Votre session a expiré. Reconnectez-vous.",
    NO_COMPANY: "Sélectionnez une entreprise pour accéder à l’entretien.",
    TRUCK_NOT_FOUND: "Ce véhicule n’est plus accessible dans votre entreprise.",
    INVALID_PAYLOAD: "Vérifiez les champs : kilométrage entier, date valide et au moins une périodicité positive.",
    IDEMPOTENCY_CONFLICT: "Cette demande a déjà été utilisée pour une autre intervention. Actualisez avant de recommencer.",
  }
  return errors[code ?? ""] ?? "Impossible de terminer l’opération. Actualisez puis réessayez."
}

/** Une date métier sans heure est enregistrée à minuit UTC, sans décalage du navigateur. */
export function maintenanceDateIso(value: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null
  const parsed = new Date(`${value}T00:00:00.000Z`)
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value ? parsed.toISOString() : null
}

export function VehicleMaintenancePanel({ truckId, matricule, active, canManage, refreshToken = 0, initialSummary, initialMileage }: {
  truckId: string
  matricule: string
  active: boolean
  canManage: boolean
  refreshToken?: number
  initialSummary?: MaintenanceSummary | null
  initialMileage?: number | null
}) {
  const id = useId()
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [data, setData] = useState<MaintenanceReadDto | null>(null)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [editingPlan, setEditingPlan] = useState(false)
  const editingPlanRef = useRef(false)
  editingPlanRef.current = editingPlan
  const [error, setError] = useState("")
  const [notice, setNotice] = useState("")
  const [planExpectedRevision, setPlanExpectedRevision] = useState(0)
  const [intervalKm, setIntervalKm] = useState("")
  const [intervalMonths, setIntervalMonths] = useState("")
  const [editingEntryId, setEditingEntryId] = useState("")
  const [correctionReason, setCorrectionReason] = useState("")
  const [kind, setKind] = useState("OIL_CHANGE")
  const [occurredAt, setOccurredAt] = useState("")
  const [mileage, setMileage] = useState("")
  const [notes, setNotes] = useState("")
  const pending = useRef<{ fingerprint: string; key: string } | null>(null)
  const base = `/api/trucks/${encodeURIComponent(truckId)}/maintenance`
  const refresh = useCallback(async (signal?: AbortSignal) => {
    setLoading(true); setError("")
    try {
      const response = await fetch(base, { cache: "no-store", signal })
      const body = await response.json()
      if (!response.ok) throw new Error(maintenanceUiError(body.code))
      if (!signal?.aborted) {
        const snapshot = body as MaintenanceReadDto
        setData(snapshot)
        if (!editingPlanRef.current) {
          setPlanExpectedRevision(snapshot.plan?.revision ?? 0)
          setIntervalKm(snapshot.plan?.intervalKm?.toString() ?? "")
          setIntervalMonths(snapshot.plan?.intervalMonths?.toString() ?? "")
        }
      }
    } catch (err) {
      if (!signal?.aborted) setError(err instanceof Error ? err.message : "Impossible de charger l’entretien.")
    } finally { if (!signal?.aborted) setLoading(false) }
  }, [base])
  useEffect(() => {
    if (!open) return
    const controller = new AbortController()
    void refresh(controller.signal)
    return () => controller.abort()
  }, [open, refresh, refreshToken])

  useEffect(() => {
    if (editingEntryId) document.getElementById(`${id}-date`)?.focus()
  }, [editingEntryId, id])

  // Replié, la synthèse serveur reflète aussi les relevés saisis dans l’autre panneau.
  const summary = open && data ? data.summary : initialSummary ?? data?.summary
  const currentMileage = open && data ? data.currentMileage : initialMileage ?? data?.currentMileage
  const savePlan = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!isExplicitSubmit(event)) return
    if (!data || saving || loading || !active || !canManage) return
    if ((!intervalKm && !intervalMonths) || (intervalKm && (!/^\d+$/.test(intervalKm) || Number(intervalKm) < 1 || Number(intervalKm) > 9999999)) || (intervalMonths && (!/^\d+$/.test(intervalMonths) || Number(intervalMonths) < 1 || Number(intervalMonths) > 120))) {
      setError("Renseignez au moins une périodicité : 1 à 9 999 999 km ou 1 à 120 mois."); return
    }
    setSaving(true); setError(""); setNotice("")
    try {
      const response = await fetch(`${base}/plan`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ intervalKm: intervalKm ? Number(intervalKm) : null, intervalMonths: intervalMonths ? Number(intervalMonths) : null, expectedRevision: planExpectedRevision }) })
      const result = await response.json()
      if (!response.ok) { setError(maintenanceUiError(result.code)); return }
      setEditingPlan(false)
      editingPlanRef.current = false
      setNotice("Périodicité enregistrée.")
      await refresh(); router.refresh()
    } catch { setError("Connexion interrompue. Réessayez la même périodicité pour confirmer l’enregistrement.") }
    finally { setSaving(false) }
  }
  const saveEntry = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!isExplicitSubmit(event)) return
    if (!data || saving || loading || !active || !canManage) return
    const iso = maintenanceDateIso(occurredAt)
    if (!iso || !/^\d+$/.test(mileage) || Number(mileage) > 9999999) {
      setError("Renseignez une date valide et un kilométrage entier entre 0 et 9 999 999."); return
    }
    if (editingEntryId && !correctionReason.trim()) { setError("Indiquez le motif de modification."); return }
    const body = { ...(editingEntryId ? { reason: correctionReason.trim() } : {}), kind, occurredAt: iso, mileage: Number(mileage), notes: notes.trim() || null }
    const fingerprint = JSON.stringify([editingEntryId, body])
    if (pending.current?.fingerprint !== fingerprint) pending.current = { fingerprint, key: crypto.randomUUID() }
    setSaving(true); setError(""); setNotice("")
    try {
      const response = await fetch(editingEntryId ? `${base}/entries/${encodeURIComponent(editingEntryId)}/corrections` : base, { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": pending.current.key }, body: JSON.stringify(body) })
      const result = await response.json()
      if (!response.ok) { if (response.status < 500) pending.current = null; setError(maintenanceUiError(result.code)); return }
      pending.current = null
      setMileage(""); setOccurredAt(""); setNotes(""); setEditingEntryId(""); setCorrectionReason("")
      setNotice("Intervention enregistrée. Le compteur du véhicule reste inchangé.")
      await refresh(); router.refresh()
    } catch { setError("Connexion interrompue. Réessayez la même intervention pour confirmer son enregistrement sans doublon.") }
    finally { setSaving(false) }
  }

  const label = maintenanceSummaryLabel(summary)
  const dueColor = summary?.status === "DUE" ? "text-red-700" : summary?.status === "SOON" ? "text-amber-700" : "text-slate-500"
  return <section className="mt-3 border-t border-slate-100 pt-3" aria-label={`Entretien de ${matricule}`}>
    <button type="button" aria-expanded={open} aria-controls={`${id}-panel`} onClick={() => setOpen(!open)} className="flex w-full flex-wrap items-center gap-2 text-left text-sm font-medium text-[#0f3460]">
      <Wrench className="h-4 w-4" aria-hidden="true" /> Vidanges et entretien
      <span className={`ml-auto text-xs ${dueColor}`}>{label} · {open ? "Réduire" : "Consulter"}</span>
    </button>
    {open && <div id={`${id}-panel`} className="mt-3 space-y-4" aria-busy={loading || saving}>
      <div className="flex items-start justify-between gap-3 rounded-lg bg-slate-50 p-3">
        <div><p className={`text-sm font-semibold ${dueColor}`}>{label}</p>
          <p className="text-xs text-slate-500">{matricule} · Compteur : {currentMileage != null ? km(currentMileage) : "non renseigné"}</p>
          {summary?.lastOilChange && <p className="mt-1 text-xs text-slate-600">Dernière vidange : {day(summary.lastOilChange.occurredAt)} à {km(summary.lastOilChange.mileage)}</p>}
          {(summary?.nextMileage != null || summary?.nextDate) && <p className="mt-1 text-xs text-slate-600">Prochaine vidange : {[summary.nextMileage != null ? km(summary.nextMileage) : null, summary.nextDate ? day(summary.nextDate) : null].filter(Boolean).join(" ou ")} · au premier terme atteint</p>}
          {summary?.remainingKm != null && <p className="text-xs text-slate-500">{summary.remainingKm <= 0 ? `Échéance kilométrique atteinte${summary.remainingKm < 0 ? `, dépassée de ${km(-summary.remainingKm)}` : ""}` : `${km(summary.remainingKm)} avant échéance`}</p>}
        </div>
        <Button type="button" size="sm" variant="outline" disabled={loading || saving} onClick={() => void refresh()} aria-label={`Actualiser l’entretien de ${matricule}`}><RefreshCw className="h-4 w-4" aria-hidden="true" /></Button>
      </div>
      {loading && <p role="status" className="text-sm text-slate-500">Chargement de l’entretien…</p>}
      {error && <p role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</p>}
      {notice && <p role="status" className="text-sm text-emerald-700">{notice}</p>}
      {data && currentMileage == null && <p className="rounded-lg bg-amber-50 p-3 text-xs text-amber-800">Compteur inconnu : ajoutez un relevé dans Kilométrage et trajets pour calculer les échéances en kilomètres.</p>}
      {summary?.status === "INCONSISTENT_MILEAGE" && <p role="alert" className="rounded-lg bg-amber-50 p-3 text-xs text-amber-800">Le compteur actuel est inférieur à celui de la dernière vidange. Vérifiez le relevé ou sa correction avant de vous fier aux échéances.</p>}
      {!active && <p className="text-sm text-slate-500">Véhicule archivé : historique consultable, saisie désactivée.</p>}
      {data && active && canManage && <>
        <form onKeyDown={preventImplicitEnter} onSubmit={savePlan} className="space-y-3 rounded-lg border border-slate-100 p-3">
          <h4 className="text-sm font-semibold text-slate-700">Périodicité des vidanges</h4>
          <p className="text-xs text-slate-500">Indiquez au moins un intervalle, selon les préconisations du véhicule.</p>
          <div className="grid grid-cols-2 gap-3"><div><label htmlFor={`${id}-km`} className="mb-1 block text-xs font-medium text-slate-600">Tous les (km)</label><input id={`${id}-km`} className={FIELD} type="number" min={1} max={9999999} step={1} value={intervalKm} disabled={saving || loading || (!!data.plan && !editingPlan)} onChange={(e) => { setEditingPlan(true); setIntervalKm(e.target.value) }} placeholder="Ex. 15000" /></div>
          <div><label htmlFor={`${id}-months`} className="mb-1 block text-xs font-medium text-slate-600">Tous les (mois)</label><input id={`${id}-months`} className={FIELD} type="number" min={1} max={120} step={1} value={intervalMonths} disabled={saving || loading || (!!data.plan && !editingPlan)} onChange={(e) => { setEditingPlan(true); setIntervalMonths(e.target.value) }} placeholder="Ex. 12" /></div></div>
          {data.plan && !editingPlan ? <Button type="button" variant="outline" size="sm" disabled={saving || loading} onClick={() => { setPlanExpectedRevision(data.plan?.revision ?? 0); setEditingPlan(true) }}>Modifier la périodicité</Button> : <div className="flex gap-2"><Button type="submit" data-explicit-submit="true" variant="outline" size="sm" disabled={saving || loading}>Valider la périodicité</Button>{data.plan && <Button type="button" variant="outline" size="sm" disabled={saving || loading} onClick={() => { setEditingPlan(false); setIntervalKm(data.plan?.intervalKm?.toString() ?? ""); setIntervalMonths(data.plan?.intervalMonths?.toString() ?? ""); setError("") }}>Annuler</Button>}</div>}
        </form>
        <form onKeyDown={preventImplicitEnter} onSubmit={saveEntry} className="space-y-3 rounded-lg border border-slate-100 p-3">
          <h4 className="text-sm font-semibold text-slate-700">{editingEntryId ? "Modifier l’intervention" : "Ajouter une intervention"}</h4>
          <div><label htmlFor={`${id}-kind`} className="mb-1 block text-xs font-medium text-slate-600">Type d’intervention</label><select id={`${id}-kind`} className={FIELD} value={kind} disabled={saving || loading} onChange={(e) => setKind(e.target.value)}><option value="OIL_CHANGE">Vidange</option><option value="SERVICE">Autre entretien</option></select></div>
          <div className="grid grid-cols-2 gap-3"><div><label htmlFor={`${id}-date`} className="mb-1 block text-xs font-medium text-slate-600">Date d’intervention</label><input id={`${id}-date`} className={FIELD} type="date" required max={new Date().toISOString().slice(0, 10)} value={occurredAt} disabled={saving || loading} onChange={(e) => setOccurredAt(e.target.value)} /></div>
          <div><label htmlFor={`${id}-mileage`} className="mb-1 block text-xs font-medium text-slate-600">Compteur lors de l’intervention (km)</label><input id={`${id}-mileage`} className={FIELD} type="number" inputMode="numeric" required min={0} max={9999999} step={1} value={mileage} disabled={saving || loading} onChange={(e) => setMileage(e.target.value)} /></div></div>
          <div><label htmlFor={`${id}-notes`} className="mb-1 block text-xs font-medium text-slate-600">Notes (facultatif)</label><textarea id={`${id}-notes`} className={FIELD} rows={2} maxLength={2000} value={notes} disabled={saving || loading} onChange={(e) => setNotes(e.target.value)} /></div>
          {editingEntryId && <div><label htmlFor={`${id}-correction-reason`} className="mb-1 block text-xs font-medium text-slate-600">Motif de modification</label><input id={`${id}-correction-reason`} className={FIELD} required maxLength={2000} value={correctionReason} onChange={event => setCorrectionReason(event.target.value)} disabled={saving || loading} /></div>}
          <p className="text-xs text-slate-500">L’intervention ne modifie jamais le compteur actuel. Seule une vidange relance ses échéances.</p>
          <Button type="submit" data-explicit-submit="true" size="sm" className="bg-[#0f3460] hover:bg-[#0a2540]" disabled={saving || loading}>{saving ? "Enregistrement…" : editingEntryId ? "Valider les modifications" : "Valider l’intervention"}</Button>
          {editingEntryId && <Button type="button" size="sm" variant="outline" disabled={saving || loading} onClick={() => { setEditingEntryId(""); setCorrectionReason(""); setMileage(""); setOccurredAt(""); setNotes(""); setError("") }}>Annuler</Button>}
        </form>
      </>}
      {data && <div><h4 className="mb-2 text-sm font-semibold text-slate-700">Historique des interventions</h4>
        {data.history.length === 0 ? <p className="text-sm text-slate-500">Aucune intervention enregistrée.</p> : <ol className="max-h-64 divide-y divide-slate-100 overflow-y-auto rounded-lg border border-slate-100">{data.history.map((entry) => <li key={entry.id} className="p-3 text-xs text-slate-500"><div className="flex justify-between gap-2"><span className="font-medium text-slate-700">{entry.kind === "OIL_CHANGE" ? "Vidange" : "Autre entretien"} · {day(entry.occurredAt)}</span><strong className="text-slate-900">{km(entry.mileage)}</strong></div><p>{entry.createdByName}</p>{entry.notes && <p className="mt-1 whitespace-pre-wrap text-slate-600">{entry.notes}</p>}{entry.correctionReason && <p className="mt-1 text-slate-600">Modification : {entry.correctionReason}</p>}{entry.isEffective === false ? <p className="mt-1 text-slate-500">Version remplacée conservée dans l’historique</p> : active && canManage && <Button type="button" size="sm" variant="outline" disabled={saving || loading} onClick={() => { setEditingEntryId(entry.id); setKind(entry.kind); setOccurredAt(entry.occurredAt.slice(0, 10)); setMileage(String(entry.mileage)); setNotes(entry.notes ?? ""); setCorrectionReason(""); setError("") }}>Modifier</Button>}</li>)}</ol>}
      </div>}
    </div>}
  </section>
}
