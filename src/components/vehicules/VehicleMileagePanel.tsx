"use client"

import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from "react"
import { Gauge, RefreshCw } from "lucide-react"
import { preventImplicitEnter, isExplicitSubmit } from "./explicit-submit"
import { Button } from "@/components/ui/button"

export interface MileageHistoryEntry {
  id: string
  kind: "READING" | "DEPARTURE" | "ARRIVAL" | "CORRECTION"
  mileage: number
  revision: number
  occurredAt: string | null
  recordedAt: string
  createdByName: string | null
  rootEntryId: string | null
  supersedesEntryId: string | null
  correctionReason: string | null
}
interface MileageTrip {
  id: string
  startEntryId: string
  endEntryId: string | null
  distance: number | null
  teamName: string | null
  chauffeurName: string | null
  worksiteName: string | null
}
export interface MileageSnapshot {
  truckId: string
  currentMileage: number | null
  mileageRevision: number
  openTrip: MileageTrip | null
  trips: MileageTrip[]
  history: MileageHistoryEntry[]
}
type Action = "reading" | "start" | "end" | "correction"

/** Corrections restent auditées ; une seule valeur effective par observation. */
export function effectiveMileageEntries(history: MileageHistoryEntry[]) {
  const latestCorrections = new Map<string, MileageHistoryEntry>()
  for (const entry of history) {
    if (entry.kind !== "CORRECTION" || !entry.rootEntryId) continue
    const previous = latestCorrections.get(entry.rootEntryId)
    if (!previous || entry.revision > previous.revision) latestCorrections.set(entry.rootEntryId, entry)
  }
  return history.filter((entry) => entry.kind !== "CORRECTION").map((original) => ({
    original, effective: latestCorrections.get(original.id) ?? original,
  }))
}

export function mileageErrorMessage(code?: string): string {
  const messages: Record<string, string> = {
    FORBIDDEN: "Votre rôle ne permet pas cette opération.",
    UNAUTHENTICATED: "Votre session a expiré. Reconnectez-vous.",
    NO_COMPANY: "Sélectionnez une entreprise avant de consulter le kilométrage.",
    TRUCK_NOT_FOUND: "Ce véhicule n’est plus accessible dans votre entreprise.",
    TRUCK_ARCHIVED: "Ce véhicule est archivé. Restaurez-le avant toute saisie.",
    MILEAGE_REGRESSION: "Le compteur doit rester cohérent avec les relevés précédents et suivants.",
    MILEAGE_TRIP_INVALID: "Le compteur d’arrivée ne peut pas être inférieur au départ.",
    MILEAGE_REVISION_CONFLICT: "Un autre utilisateur a modifié le kilométrage. Actualisez puis vérifiez votre saisie.",
    MILEAGE_CORRECTION_CONFLICT: "Ce relevé a été corrigé entre-temps. Actualisez avant de recommencer.",
    TRIP_ALREADY_OPEN: "Un trajet est déjà en cours. Actualisez pour le consulter.",
    TRIP_ALREADY_CLOSED: "Ce trajet est déjà terminé. Actualisez pour le consulter.",
    MILEAGE_FUTURE_DATE: "La date du relevé ne peut pas être dans le futur.",
    MILEAGE_OUT_OF_ORDER: "Ce relevé précède le dernier relevé enregistré.",
    INVALID_PAYLOAD: "Vérifiez les champs : le kilométrage doit être un entier entre 0 et 9 999 999.",
    IDEMPOTENCY_CONFLICT: "Cette demande a déjà été utilisée avec une autre saisie. Actualisez avant de recommencer.",
  }
  return messages[code ?? ""] ?? "Impossible de terminer l’opération. Actualisez les données puis réessayez."
}

const KIND = { READING: "Relevé", DEPARTURE: "Départ", ARRIVAL: "Arrivée", CORRECTION: "Correction" }
const km = (value: number) => `${value.toLocaleString("fr-FR")} km`
const date = (value: string) => new Date(value).toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" })
const FIELD = "w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500"

export function VehicleMileagePanel({ truckId, matricule, active, canManage, initialMileage, onMileageChanged }: {
  truckId: string
  matricule: string
  active: boolean
  canManage: boolean
  initialMileage?: number | null
  onMileageChanged?: () => void
}) {
  const id = useId()
  const [open, setOpen] = useState(false)
  const [data, setData] = useState<MileageSnapshot | null>(null)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState("")
  const [notice, setNotice] = useState("")
  const [action, setAction] = useState<Action>("reading")
  const [value, setValue] = useState("")
  const [targetId, setTargetId] = useState("")
  const [targetEffectiveId, setTargetEffectiveId] = useState("")
  const [reason, setReason] = useState("")
  // Une réponse réseau perdue conserve la même clé et le même corps au prochain essai.
  const pending = useRef<{ fingerprint: string; key: string } | null>(null)
  const base = `/api/trucks/${encodeURIComponent(truckId)}/mileage`

  const refresh = useCallback(async (signal?: AbortSignal) => {
    setLoading(true)
    setError("")
    try {
      const response = await fetch(base, { cache: "no-store", signal })
      const body = await response.json()
      if (!response.ok) throw new Error(mileageErrorMessage(body.code))
      if (!signal?.aborted) setData(body)
    } catch (err) {
      if (!signal?.aborted) setError(err instanceof Error ? err.message : "Impossible de charger le kilométrage.")
    } finally {
      if (!signal?.aborted) setLoading(false)
    }
  }, [base])

  useEffect(() => {
    if (!open) return
    const controller = new AbortController()
    void refresh(controller.signal)
    return () => controller.abort()
  }, [open, refresh])

  useEffect(() => {
    if (action === "correction" && targetId) document.getElementById(`${id}-reason`)?.focus()
  }, [action, targetId, id])

  const entries = data ? effectiveMileageEntries(data.history) : []
  const target = entries.find((entry) => entry.original.id === targetId)
  const availableAction: Action = !canManage ? (data?.openTrip ? "end" : "start")
    : action === "end" && !data?.openTrip ? "start"
    : action === "start" && data?.openTrip ? "end" : action
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!isExplicitSubmit(event)) return
    if (!data || saving || loading || !active) return
    const mileage = Number(value)
    if (!/^\d+$/.test(value) || !Number.isSafeInteger(mileage) || mileage > 9_999_999) {
      setError(mileageErrorMessage("INVALID_PAYLOAD")); return
    }
    let path = "/readings"
    const body: Record<string, unknown> = { mileage, expectedRevision: data.mileageRevision }
    if (availableAction === "start") path = "/trips"
    if (availableAction === "end") {
      if (!data.openTrip) return
      path = `/trips/${encodeURIComponent(data.openTrip.id)}/end`
    }
    if (availableAction === "correction") {
      if (!canManage || !target || !reason.trim()) {
        setError("Choisissez un relevé et indiquez le motif de correction."); return
      }
      path = `/entries/${encodeURIComponent(target.original.id)}/corrections`
      body.expectedEffectiveEntryId = targetEffectiveId
      body.reason = reason.trim()
    }
    if (availableAction === "reading" && !canManage) return
    const fingerprint = JSON.stringify([path, body])
    if (pending.current?.fingerprint !== fingerprint) pending.current = { fingerprint, key: crypto.randomUUID() }
    setSaving(true); setError(""); setNotice("")
    try {
      const response = await fetch(base + path, {
        method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": pending.current.key },
        body: JSON.stringify(body),
      })
      const result = await response.json()
      if (!response.ok) {
        // Une erreur serveur peut cacher une écriture validée : conserver la clé.
        if (response.status < 500) pending.current = null
        setError(mileageErrorMessage(result.code)); return
      }
      pending.current = null
      setValue(""); setReason(""); setTargetId("")
      setNotice("Kilométrage enregistré.")
      await refresh()
      onMileageChanged?.()
    } catch {
      setError("Connexion interrompue. Réessayez la même saisie pour confirmer son enregistrement sans doublon.")
    } finally { setSaving(false) }
  }

  return <section className="mt-4 border-t border-slate-100 pt-3" aria-label={`Kilométrage de ${matricule}`}>
    <button type="button" aria-expanded={open} aria-controls={`${id}-panel`} onClick={() => setOpen(!open)} className="flex w-full items-center gap-2 text-left text-sm font-medium text-[#0f3460]">
      <Gauge className="h-4 w-4" aria-hidden="true" /> Kilométrage et trajets
      <span className="ml-auto text-xs text-slate-500">{(data ? data.currentMileage : initialMileage) != null ? `${km((data ? data.currentMileage : initialMileage)!)} · ` : ""}{open ? "Réduire" : "Consulter"}</span>
    </button>
    {open && <div id={`${id}-panel`} className="mt-3 space-y-4" aria-busy={saving || loading}>
      <div className="flex items-start justify-between gap-3 rounded-lg bg-slate-50 p-3">
        <div><p className="text-xs text-slate-500">Compteur actuel · {matricule}</p><p className="text-xl font-semibold text-slate-900">{(data ? data.currentMileage : initialMileage) != null ? km((data ? data.currentMileage : initialMileage)!) : "Non renseigné"}</p>
          {data?.openTrip && <p className="mt-1 text-xs text-blue-700">Trajet en cours{data.openTrip.chauffeurName ? ` · ${data.openTrip.chauffeurName}` : ""}</p>}
        </div>
        <Button type="button" size="sm" variant="outline" disabled={loading || saving} onClick={() => void refresh()} aria-label={`Actualiser le kilométrage de ${matricule}`}><RefreshCw className="h-4 w-4" aria-hidden="true" /></Button>
      </div>
      {loading && <p role="status" className="text-sm text-slate-500">Chargement du journal…</p>}
      {error && <p role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</p>}
      {notice && <p role="status" className="text-sm text-emerald-700">{notice}</p>}
      {!active && <p className="text-sm text-slate-500">Véhicule archivé : journal consultable, saisie désactivée.</p>}
      {data && active && <form onKeyDown={preventImplicitEnter} onSubmit={submit} className="space-y-3">
        <div><label htmlFor={`${id}-action`} className="mb-1 block text-xs font-medium text-slate-600">Opération</label>
          <select id={`${id}-action`} className={FIELD} value={canManage ? availableAction : data.openTrip ? "end" : "start"} disabled={saving || loading} onChange={(e) => { setAction(e.target.value as Action); setValue(""); setError("") }}>
            {canManage && <option value="reading">Ajouter un relevé compteur</option>}
            {!data.openTrip && <option value="start">Démarrer un trajet</option>}
            {data.openTrip && <option value="end">Terminer le trajet en cours</option>}
            {canManage && entries.length > 0 && <option value="correction">Corriger un relevé (avec motif)</option>}
          </select>
        </div>
        {availableAction === "correction" && canManage && <>
          <div><label htmlFor={`${id}-target`} className="mb-1 block text-xs font-medium text-slate-600">Relevé à corriger</label>
            <select id={`${id}-target`} className={FIELD} required value={targetId} disabled={saving || loading} onChange={(e) => { setTargetId(e.target.value); const selected = entries.find((entry) => entry.original.id === e.target.value); setTargetEffectiveId(selected?.effective.id ?? ""); setValue(String(selected?.effective.mileage ?? "")) }}>
              <option value="">Choisir un relevé</option>{entries.slice().reverse().map(({ original, effective }) => <option key={original.id} value={original.id}>{KIND[original.kind]} · {date(original.occurredAt ?? original.recordedAt)} · {km(effective.mileage)}</option>)}
            </select>
          </div>
          <div><label htmlFor={`${id}-reason`} className="mb-1 block text-xs font-medium text-slate-600">Motif de correction</label><input id={`${id}-reason`} className={FIELD} required value={reason} disabled={saving || loading} onChange={(e) => setReason(e.target.value)} maxLength={2000} /></div>
          <p className="text-xs text-slate-500">La valeur d’origine et chaque correction restent dans le journal.</p>
        </>}
        <div><label htmlFor={`${id}-value`} className="mb-1 block text-xs font-medium text-slate-600">Compteur kilométrique (km)</label><input id={`${id}-value`} className={FIELD} type="number" inputMode="numeric" required min={0} max={9999999} step={1} value={value} disabled={saving || loading} onChange={(e) => setValue(e.target.value)} placeholder={data.currentMileage != null ? String(data.currentMileage) : "Ex. 125000"} /></div>
        <Button type="submit" data-explicit-submit="true" size="sm" disabled={saving || loading} className="bg-[#0f3460] hover:bg-[#0a2540]">{saving ? "Enregistrement…" : availableAction === "correction" ? "Valider la modification" : "Valider"}</Button>
        {availableAction === "correction" && <Button type="button" variant="outline" size="sm" disabled={saving || loading} onClick={() => { setAction("reading"); setTargetId(""); setValue(""); setReason(""); setError("") }}>Annuler</Button>}
      </form>}
      {data && <div className="space-y-3">
        <h4 className="text-sm font-semibold text-slate-700">Journal kilométrique</h4>
        {canManage && active && entries.length > 0 && <div className="space-y-2"><p className="text-xs text-slate-500">Modifier un relevé ajoute une correction avec motif ; la valeur d’origine reste conservée.</p>{entries.slice().reverse().map(({ original, effective }) => <div key={original.id} className="flex items-center justify-between gap-2 rounded-lg border border-slate-100 p-2 text-xs"><span>{KIND[original.kind]} · {date(original.occurredAt ?? original.recordedAt)} · {km(effective.mileage)}</span><Button type="button" size="sm" variant="outline" disabled={saving || loading} aria-label={`Modifier le relevé du ${date(original.occurredAt ?? original.recordedAt)}`} onClick={() => { setAction("correction"); setTargetId(original.id); setTargetEffectiveId(effective.id); setValue(String(effective.mileage)); setReason(""); setError("") }}>Modifier</Button></div>)}</div>}
        {data.history.length === 0 ? <p className="text-sm text-slate-500">Aucun relevé. Commencez par saisir le compteur actuel.</p> : <div className="max-h-64 overflow-y-auto rounded-lg border border-slate-100"><ol className="divide-y divide-slate-100">{data.history.slice().reverse().map((entry) => <li key={entry.id} className="p-3 text-xs text-slate-500"><div className="flex justify-between gap-2"><span className="font-medium text-slate-700">{KIND[entry.kind]}</span><strong className="text-slate-900">{km(entry.mileage)}</strong></div><p>{date(entry.occurredAt ?? entry.recordedAt)}{entry.createdByName ? ` · ${entry.createdByName}` : ""}</p>{entry.correctionReason && <p className="mt-1 text-slate-600">Motif : {entry.correctionReason}</p>}</li>)}</ol></div>}
        {data.trips.length > 0 && <><h4 className="text-sm font-semibold text-slate-700">Trajets</h4><ul className="max-h-48 space-y-2 overflow-y-auto">{data.trips.slice().reverse().map((trip) => <li key={trip.id} className="rounded-lg bg-slate-50 p-3 text-xs text-slate-500"><p className="font-medium text-slate-700">{trip.endEntryId === null ? "En cours" : "Terminé"}{trip.distance != null ? ` · ${km(trip.distance)}` : ""}</p><p>{[trip.teamName, trip.chauffeurName, trip.worksiteName].filter(Boolean).join(" · ") || "Sans affectation au départ"}</p></li>)}</ul></>}
      </div>}
    </div>}
  </section>
}
