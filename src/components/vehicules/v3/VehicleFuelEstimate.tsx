"use client"
import { useEffect, useMemo, useRef, useState } from "react"
import { FUEL_LABELS, FUEL_TYPES, decimalFr, estimateFuel, parseConsumption, type FuelEstimate, type FuelType } from "@/lib/vehicules/v3/fuel-estimate-domain"
import { createLatestOnly } from "./vehicle-document-recognition-ui"
import { fuelEstimateError, kmLabel, priceWarnings, proposedExpenseValues, routeReason, stationsLabel, type ExpenseFieldValues } from "./vehicle-fuel-estimate-ui"

const field = "block border rounded p-2 w-full text-black bg-white"
const button = "border rounded px-3 py-2 disabled:opacity-50"
const storageKey = (truckId: string) => `planificator:fuel-consumption:${truckId}`

/**
 * Encadré « Estimation du trajet » : au choix d'un trajet, kilomètres, stations du trajet et prix publics ; avec la
 * consommation saisie, litres et montant estimés. Les valeurs sont proposées au formulaire (`onPropose`) : automatiquement
 * sans écraser une saisie, ou toutes sur « Reprendre l'estimation ». Une réponse arrivée après un changement est ignorée.
 */
export function VehicleFuelEstimate({ truckId, today, trips, onPropose }: { truckId: string; today: string; trips: { id: string; label: string }[]; onPropose: (values: ExpenseFieldValues, explicit: boolean) => void }) {
  const [tripId, setTripId] = useState(""), [fuel, setFuel] = useState<FuelType>("GAZOLE"), [consumptionInput, setConsumptionInput] = useState("")
  const [estimate, setEstimate] = useState<FuelEstimate | null>(null), [stationId, setStationId] = useState(""), [loading, setLoading] = useState(false), [error, setError] = useState("")
  const latest = useRef(createLatestOnly()).current
  const propose = useRef(onPropose)
  propose.current = onPropose

  // Consommation retenue pour ce véhicule dans ce navigateur seulement (commodité, jamais une donnée partagée).
  useEffect(() => { try { setConsumptionInput(window.localStorage.getItem(storageKey(truckId)) ?? "") } catch { /* stockage indisponible */ } }, [truckId])
  const consumption = parseConsumption(consumptionInput)
  useEffect(() => { if (consumption === null) return; try { window.localStorage.setItem(storageKey(truckId), consumptionInput.trim()) } catch { /* stockage indisponible */ } }, [truckId, consumption, consumptionInput])

  useEffect(() => {
    setEstimate(null); setStationId(""); setError("")
    if (!tripId) { latest.cancel(); setLoading(false); return }
    const { token, signal } = latest.start()
    setLoading(true)
    void fetch(`/api/trucks/${encodeURIComponent(truckId)}/fuel-estimate?${new URLSearchParams({ tripId, fuel })}`, { cache: "no-store", signal })
      .then(async (response) => {
        const body = await response.json().catch(() => ({}))
        if (!latest.isCurrent(token)) return
        if (!response.ok) { setError(fuelEstimateError(body.code)); return }
        const result = body as FuelEstimate
        setEstimate(result); setStationId(result.stations[0]?.id ?? "")
      })
      .catch(() => { if (latest.isCurrent(token)) setError(fuelEstimateError()) })
      .finally(() => { if (latest.isCurrent(token)) setLoading(false) })
    return () => latest.cancel()
  }, [truckId, tripId, fuel, latest])

  const station = estimate?.stations.find((s) => s.id === stationId) ?? null
  const proposed = useMemo(() => estimate ? proposedExpenseValues(estimate, station, consumption) : null, [estimate, station, consumption])
  useEffect(() => { if (proposed) propose.current(proposed, false) }, [proposed])
  const computed = estimate ? estimateFuel({ km: estimate.km, consumptionLPer100Km: consumption, pricePerLitre: station?.price ?? null }) : null

  return <div className="md:col-span-2 border rounded p-3 space-y-3 bg-slate-50" aria-busy={loading}>
    <h3 className="font-semibold">Estimation du trajet</h3>
    <p className="text-sm">Choisissez un trajet : la dépense est préremplie avec les kilomètres, la station et le prix du jour. C'est une estimation : elle reste « À valider » et le montant du ticket prime.</p>
    <div className="grid md:grid-cols-3 gap-3">
      <label>Trajet<select className={field} value={tripId} onChange={(e) => setTripId(e.target.value)}><option value="">Aucun trajet</option>{trips.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}</select></label>
      <label>Carburant<select className={field} value={fuel} onChange={(e) => setFuel(e.target.value as FuelType)}>{FUEL_TYPES.map((f) => <option key={f} value={f}>{FUEL_LABELS[f]}</option>)}</select></label>
      <label>Consommation (L/100 km)<input className={field} inputMode="decimal" value={consumptionInput} onChange={(e) => setConsumptionInput(e.target.value)} placeholder="Ex. 9,5" aria-invalid={!!consumptionInput.trim() && consumption === null} /></label>
    </div>
    {consumptionInput.trim() && consumption === null && <p role="status" className="text-sm text-amber-800">Consommation attendue entre 1 et 80 L/100 km.</p>}
    {loading && <p role="status" className="text-sm">Recherche des stations sur le trajet…</p>}
    {error && <p role="status" className="text-sm text-amber-800">{error}</p>}
    {estimate && <div className="space-y-2 text-sm">
      <p>{kmLabel(estimate)}</p>
      {routeReason(estimate.route.status) && <p className="text-amber-800">{routeReason(estimate.route.status)}</p>}
      <p>{stationsLabel(estimate.stationsStatus, estimate.stations.length)}</p>
      {estimate.stations.length > 0 && <fieldset className="space-y-1"><legend className="sr-only">Station retenue</legend>{estimate.stations.map((s) =>
        <label key={s.id} className="flex items-start gap-2"><input type="radio" name="fuel-station" value={s.id} checked={s.id === stationId} onChange={() => setStationId(s.id)} />
          <span><strong>{decimalFr(s.price, 3)} €/L</strong> · {s.label}, {s.city} · {s.offRouteKm === 0 ? "sur le trajet" : `à ${decimalFr(s.offRouteKm, 1)} km du trajet`} · prix du {s.updatedAt.slice(8, 10)}/{s.updatedAt.slice(5, 7)}{s.open24h ? " · automate 24/24" : ""}</span></label>)}</fieldset>}
      {station && priceWarnings(estimate, station, today).map((w) => <p key={w} className="text-amber-800">{w}</p>)}
      {computed ? <p className="font-medium">Estimation : {decimalFr(computed.litres, 3).replace(/0+$/, "").replace(/,$/, "")} L × {decimalFr(station!.price, 3)} €/L = {decimalFr(computed.amount, 2)} €</p>
        : <p>{consumption === null ? "Indiquez la consommation pour estimer les litres et le montant." : estimate.km === null ? "Distance inconnue : litres et montant non estimés." : "Choisissez une station pour estimer le montant."}</p>}
      {proposed && <button type="button" className={button} onClick={() => onPropose(proposed, true)}>Reprendre l'estimation</button>}
    </div>}
  </div>
}
