"use client"
import { useEffect, useMemo, useRef, useState } from "react"
import { FUEL_LABELS, FUEL_TYPES, choicePrice, decimalFr, estimateFuel, parseConsumption, type FuelEstimate, type FuelType, type PlannedStay } from "@/lib/vehicules/v3/fuel-estimate-domain"
import { createLatestOnly } from "./vehicle-document-recognition-ui"
import {
  defaultPriceKey, fuelEstimateError, kmLabel, priceChoice, priceWarnings, proposedExpenseValues, routeReason, stationsLabel, stayDetails, stayLabel, totalKm,
  type ExpenseFieldValues,
} from "./vehicle-fuel-estimate-ui"

const field = "block border rounded p-2 w-full text-black bg-white"
const button = "border rounded px-3 py-2 disabled:opacity-50"
const storageKey = (truckId: string) => `planificator:fuel-consumption:${truckId}`
const litresFr = (litres: number) => decimalFr(litres, 3).replace(/0+$/, "").replace(/,$/, "")

/**
 * Encadré « Estimation du trajet ». Source : un séjour planifié sur un chantier (départ le premier jour, retour le dernier,
 * équipe, chef et chauffeur tirés du planning) ou un trajet relevé au compteur. Kilomètres, stations du trajet, prix
 * publics (médiane par défaut) ; avec la consommation saisie, litres et montant estimés. Les valeurs sont proposées au
 * formulaire (`onPropose`) : automatiquement sans écraser une saisie, ou toutes sur « Reprendre l'estimation ».
 * Une réponse arrivée après un changement est ignorée.
 */
export function VehicleFuelEstimate({ truckId, today, trips, onPropose }: { truckId: string; today: string; trips: { id: string; label: string }[]; onPropose: (values: ExpenseFieldValues, explicit: boolean) => void }) {
  const [source, setSource] = useState(""), [fuel, setFuel] = useState<FuelType>("GAZOLE"), [consumptionInput, setConsumptionInput] = useState(""), [extraInput, setExtraInput] = useState("")
  const [stays, setStays] = useState<PlannedStay[] | null>(null), [staysError, setStaysError] = useState("")
  const [estimate, setEstimate] = useState<FuelEstimate | null>(null), [priceKey, setPriceKey] = useState(""), [loading, setLoading] = useState(false), [error, setError] = useState("")
  const latest = useRef(createLatestOnly()).current
  const propose = useRef(onPropose)
  propose.current = onPropose

  // Consommation retenue pour ce véhicule dans ce navigateur seulement (commodité, jamais une donnée partagée).
  useEffect(() => { try { setConsumptionInput(window.localStorage.getItem(storageKey(truckId)) ?? "") } catch { /* stockage indisponible */ } }, [truckId])
  const consumption = parseConsumption(consumptionInput)
  useEffect(() => { if (consumption === null) return; try { window.localStorage.setItem(storageKey(truckId), consumptionInput.trim()) } catch { /* stockage indisponible */ } }, [truckId, consumption, consumptionInput])
  const extraKm = /^\d{1,5}$/.test(extraInput.trim()) ? Number(extraInput.trim()) : 0

  useEffect(() => {
    const controller = new AbortController()
    void fetch(`/api/trucks/${encodeURIComponent(truckId)}/fuel-estimate/stays`, { cache: "no-store", signal: controller.signal })
      .then(async (response) => { const body = await response.json().catch(() => ({})); if (controller.signal.aborted) return; if (!response.ok) throw new Error(); setStays(body.stays) })
      .catch(() => { if (!controller.signal.aborted) setStaysError("Chantiers planifiés indisponibles : les trajets relevés au compteur restent utilisables.") })
    return () => controller.abort()
  }, [truckId])

  useEffect(() => {
    setEstimate(null); setPriceKey(""); setError("")
    if (!source) { latest.cancel(); setLoading(false); return }
    const [kind, id] = [source.slice(0, 5), source.slice(5)]
    const { token, signal } = latest.start()
    setLoading(true)
    void fetch(`/api/trucks/${encodeURIComponent(truckId)}/fuel-estimate?${new URLSearchParams({ [kind === "stay:" ? "stayId" : "tripId"]: id, fuel })}`, { cache: "no-store", signal })
      .then(async (response) => {
        const body = await response.json().catch(() => ({}))
        if (!latest.isCurrent(token)) return
        if (!response.ok) { setError(fuelEstimateError(body.code)); return }
        const result = body as FuelEstimate
        setEstimate(result); setPriceKey(defaultPriceKey(result))
      })
      .catch(() => { if (latest.isCurrent(token)) setError(fuelEstimateError()) })
      .finally(() => { if (latest.isCurrent(token)) setLoading(false) })
    return () => latest.cancel()
  }, [truckId, source, fuel, latest])

  // Mémorisé : un nouvel objet à chaque rendu relancerait le préremplissage en boucle.
  const choice = useMemo(() => estimate ? priceChoice(estimate, priceKey, today) : null, [estimate, priceKey, today])
  const proposed = useMemo(() => estimate ? proposedExpenseValues(estimate, choice, consumption, extraKm) : null, [estimate, choice, consumption, extraKm])
  useEffect(() => { if (proposed) propose.current(proposed, false) }, [proposed])
  const km = estimate ? totalKm(estimate, extraKm) : null
  const computed = estimate ? estimateFuel({ km, consumptionLPer100Km: consumption, pricePerLitre: choice ? choicePrice(choice) : null }) : null
  const station = choice?.kind === "STATION" ? choice.station : null

  return <div className="md:col-span-2 border rounded p-3 space-y-3 bg-slate-50" aria-busy={loading}>
    <h3 className="font-semibold">Estimation du trajet</h3>
    <p className="text-sm">Choisissez un chantier planifié ou un trajet relevé : la dépense est préremplie avec les kilomètres, le prix du carburant sur le trajet et la date de départ. C'est une estimation : elle reste « À valider » et le montant du ticket prime.</p>
    <div className="grid md:grid-cols-2 gap-3">
      <label className="md:col-span-2">Chantier ou trajet<select className={field} value={source} onChange={(e) => setSource(e.target.value)}>
        <option value="">Aucun</option>
        {!!stays?.length && <optgroup label="Chantiers planifiés (départ → retour)">{stays.map((s) => <option key={s.id} value={`stay:${s.id}`}>{stayLabel(s)}</option>)}</optgroup>}
        {trips.length > 0 && <optgroup label="Trajets relevés au compteur">{trips.map((t) => <option key={t.id} value={`trip:${t.id}`}>{t.label}</option>)}</optgroup>}
      </select></label>
      <label>Carburant<select className={field} value={fuel} onChange={(e) => setFuel(e.target.value as FuelType)}>{FUEL_TYPES.map((f) => <option key={f} value={f}>{FUEL_LABELS[f]}</option>)}</select></label>
      <label>Consommation (L/100 km)<input className={field} inputMode="decimal" value={consumptionInput} onChange={(e) => setConsumptionInput(e.target.value)} placeholder="Ex. 9,5" aria-invalid={!!consumptionInput.trim() && consumption === null} /></label>
      <label>Déplacements sur place (km, facultatif)<input className={field} inputMode="numeric" value={extraInput} onChange={(e) => setExtraInput(e.target.value)} placeholder="0" aria-invalid={!!extraInput.trim() && !/^\d{1,5}$/.test(extraInput.trim())} /></label>
    </div>
    {staysError && <p role="status" className="text-sm text-amber-800">{staysError}</p>}
    {stays && !stays.length && <p className="text-sm">Aucun chantier planifié pour l'équipe de ce véhicule sur les 60 derniers et 60 prochains jours.</p>}
    {consumptionInput.trim() && consumption === null && <p role="status" className="text-sm text-amber-800">Consommation attendue entre 1 et 80 L/100 km.</p>}
    {loading && <p role="status" className="text-sm">Calcul de l'itinéraire et recherche des stations sur le trajet…</p>}
    {error && <p role="status" className="text-sm text-amber-800">{error}</p>}
    {estimate && <div className="space-y-2 text-sm">
      {estimate.stay && stayDetails(estimate.stay).map((line) => <p key={line}>{line}</p>)}
      <p>{kmLabel(estimate)}{extraKm > 0 && km !== null ? ` Avec ${extraKm} km sur place : ${km} km.` : ""}</p>
      {routeReason(estimate.route.status) && <p className="text-amber-800">{routeReason(estimate.route.status)}</p>}
      <p>{stationsLabel(estimate.stationsStatus, estimate.stations.length, estimate.priceStats?.count ?? estimate.stations.length)}</p>
      {(estimate.priceStats || estimate.stations.length > 0) && <fieldset className="space-y-1"><legend className="sr-only">Prix retenu</legend>
        {estimate.priceStats && <label className="flex items-start gap-2"><input type="radio" name="fuel-price" value="MEDIAN" checked={priceKey === "MEDIAN"} onChange={() => setPriceKey("MEDIAN")} />
          <span><strong>{decimalFr(estimate.priceStats.median, 3)} €/L</strong> · prix médian des {estimate.priceStats.count} stations du trajet (de {decimalFr(estimate.priceStats.min, 3)} à {decimalFr(estimate.priceStats.max, 3)} €/L)</span></label>}
        {estimate.stations.map((s) => <label key={s.id} className="flex items-start gap-2"><input type="radio" name="fuel-price" value={s.id} checked={s.id === priceKey} onChange={() => setPriceKey(s.id)} />
          <span><strong>{decimalFr(s.price, 3)} €/L</strong> · {s.label}, {s.city} · {s.offRouteKm === 0 ? "sur le trajet" : `à ${decimalFr(s.offRouteKm, 1)} km du trajet`} · prix du {s.updatedAt.slice(8, 10)}/{s.updatedAt.slice(5, 7)}{s.open24h ? " · automate 24/24" : ""}</span></label>)}
      </fieldset>}
      {priceWarnings(estimate, station, today).map((w) => <p key={w} className="text-amber-800">{w}</p>)}
      {computed && choice ? <p className="font-medium">Estimation : {km} km × {decimalFr(consumption!, 1)} L/100 km = {litresFr(computed.litres)} L × {decimalFr(choicePrice(choice), 3)} €/L = {decimalFr(computed.amount, 2)} € (péages non compris)</p>
        : <p>{consumption === null ? "Indiquez la consommation pour estimer les litres et le montant." : estimate.km === null ? "Distance inconnue : litres et montant non estimés." : "Choisissez un prix pour estimer le montant."}</p>}
      {proposed && <button type="button" className={button} onClick={() => onPropose(proposed, true)}>Reprendre l'estimation</button>}
    </div>}
  </div>
}
