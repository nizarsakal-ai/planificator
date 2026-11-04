"use client"

import { useEffect, useReducer, useRef, useState } from "react"
import { ChevronLeft, ChevronRight, Route } from "lucide-react"
import { Button } from "@/components/ui/button"
import type { PlannedMileageReport, UnresolvedReason } from "@/lib/vehicules/planned-mileage-service"

const km = (value: number) => `${value.toLocaleString("fr-FR")} km`
const day = (value: string) => new Date(`${value}T12:00:00Z`).toLocaleDateString("fr-FR", { day: "2-digit", month: "2-digit", timeZone: "UTC" })
const UNRESOLVED: Record<UnresolvedReason, string> = {
  ADDRESS_MISSING: "adresse du chantier manquante",
  ADDRESS_NOT_FOUND: "adresse introuvable, à préciser sur le chantier",
  GEOCODING_UNAVAILABLE: "recherche d’adresse indisponible, réessayez plus tard",
}

export function plannedMileageErrorMessage(code?: string): string {
  const messages: Record<string, string> = {
    FORBIDDEN: "Votre rôle ne permet pas de consulter ce kilométrage.",
    UNAUTHENTICATED: "Votre session a expiré. Reconnectez-vous.",
    TRUCK_NOT_FOUND: "Ce véhicule n’est plus accessible dans votre entreprise.",
    INVALID_MONTH: "Mois invalide.",
  }
  return messages[code ?? ""] ?? "Impossible de calculer le kilométrage prévu. Réessayez dans un instant."
}

export function shiftMonth(month: string, delta: number): string {
  const [year, m] = month.split("-").map(Number)
  const d = new Date(Date.UTC(year, m - 1 + delta, 1))
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`
}

export function monthLabel(month: string): string {
  return new Date(`${month}-15T12:00:00Z`).toLocaleDateString("fr-FR", { month: "long", year: "numeric", timeZone: "UTC" })
}

export interface PlannedMileageState { request: number; loading: boolean; report: PlannedMileageReport | null; error: string }
export type PlannedMileageAction =
  | { type: "start"; request: number }
  | { type: "success"; request: number; report: PlannedMileageReport }
  | { type: "failure"; request: number; error: string }

export const initialPlannedMileageState: PlannedMileageState = { request: 0, loading: false, report: null, error: "" }

/** Chaque chargement (autre mois, autre camion) efface l'ancien rapport ; une réponse périmée est ignorée. */
export function plannedMileageReducer(state: PlannedMileageState, action: PlannedMileageAction): PlannedMileageState {
  if (action.type === "start") return { request: action.request, loading: true, report: null, error: "" }
  if (action.request !== state.request) return state
  if (action.type === "success") return { ...state, loading: false, report: action.report, error: "" }
  return { ...state, loading: false, report: null, error: action.error }
}

/** Présentation seule : le rapport vient du serveur, rien n'est écrit dans le journal du compteur. */
export function PlannedMileageReportView({ report }: { report: PlannedMileageReport }) {
  const estimated = report.lines.some((line) => line.source === "ESTIMATE")
  if (!report.lines.length && !report.unresolved.length)
    return <p className="text-xs text-slate-500">Aucun chantier planifié pour l’équipe de ce véhicule ce mois-ci.</p>
  return <div className="space-y-2">
    {report.lines.length > 0 && <ul className="divide-y divide-slate-100 rounded-lg border border-slate-100">
      {report.lines.map((line) => <li key={line.worksiteId} className="p-2.5 text-xs">
        <div className="flex items-baseline justify-between gap-2">
          <span className="font-medium text-slate-800">{line.worksiteName}</span>
          <strong className="whitespace-nowrap text-slate-900">{km(line.totalKm)}</strong>
        </div>
        <p className="text-slate-500">
          {line.days} jour{line.days > 1 ? "s" : ""} · {day(line.firstDay)}{line.lastDay !== line.firstDay ? ` → ${day(line.lastDay)}` : ""}
          {" · "}aller-retour {km(line.roundTripKm)} + marge {km(line.marginKm)}{line.source === "ESTIMATE" ? " · estimation approximative" : ""}
        </p>
      </li>)}
    </ul>}
    {report.unresolved.map((item) => <p key={item.worksiteId} className="rounded-lg bg-amber-50 p-2 text-xs text-amber-800">
      {item.worksiteName} ({item.days} jour{item.days > 1 ? "s" : ""}) non compté : {UNRESOLVED[item.reason]}.
    </p>)}
    <div className="flex items-baseline justify-between rounded-lg bg-slate-50 p-2.5 text-sm">
      <span className="text-slate-600">Total prévu sur la période</span>
      <strong className="text-slate-900">{km(report.totalKm)}</strong>
    </div>
    <p className="text-[11px] text-slate-500">
      Départ : {report.depot}. Distance routière IGN (profil voiture){estimated ? " ou, à défaut, vol d’oiseau × 1,3" : ""}, plus {km(report.marginKm)} par chantier. Estimation : le compteur et le journal ne sont pas modifiés.
    </p>
  </div>
}

export function VehiclePlannedMileage({ truckId, matricule }: { truckId: string; matricule: string }) {
  const [month, setMonth] = useState<string | null>(null)
  const [{ loading, report, error }, dispatch] = useReducer(plannedMileageReducer, initialPlannedMileageState)
  const sequence = useRef(0)
  // Le mois choisi appartient au camion affiché : un autre camion repart du mois en cours.
  const [shownTruck, setShownTruck] = useState(truckId)
  if (shownTruck !== truckId) { setShownTruck(truckId); setMonth(null) }

  useEffect(() => {
    const controller = new AbortController()
    const current = ++sequence.current
    dispatch({ type: "start", request: current })
    const query = month ? `?month=${encodeURIComponent(month)}` : ""
    fetch(`/api/trucks/${encodeURIComponent(truckId)}/planned-mileage${query}`, { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        const body = await response.json()
        if (!response.ok) throw new Error(plannedMileageErrorMessage(body.code))
        dispatch({ type: "success", request: current, report: body })
      })
      .catch((err) => {
        if (!controller.signal.aborted) dispatch({ type: "failure", request: current, error: err instanceof Error ? err.message : plannedMileageErrorMessage() })
      })
    return () => controller.abort()
  }, [truckId, month])

  const shown = report?.month ?? month
  return <div className="space-y-2" aria-label={`Kilométrage prévu de ${matricule}`} aria-busy={loading}>
    <div className="flex items-center gap-2">
      <Route className="h-4 w-4 text-[#0f3460]" aria-hidden="true" />
      <h4 className="text-sm font-semibold text-slate-700">Trajets prévus{shown ? ` · ${monthLabel(shown)}` : ""}</h4>
      {shown && <div className="ml-auto flex gap-1">
        <Button type="button" size="sm" variant="outline" disabled={loading} aria-label="Mois précédent" onClick={() => setMonth(shiftMonth(shown, -1))}><ChevronLeft className="h-4 w-4" aria-hidden="true" /></Button>
        <Button type="button" size="sm" variant="outline" disabled={loading} aria-label="Mois suivant" onClick={() => setMonth(shiftMonth(shown, 1))}><ChevronRight className="h-4 w-4" aria-hidden="true" /></Button>
      </div>}
    </div>
    {loading && <p role="status" className="text-xs text-slate-500">Calcul des distances…</p>}
    {error && <p role="alert" className="rounded-lg bg-red-50 p-2 text-xs text-red-700">{error}</p>}
    {report && !loading && <PlannedMileageReportView report={report} />}
  </div>
}
