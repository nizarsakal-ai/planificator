"use client"
import { useEffect, useMemo, useRef, useState } from "react"
import { FUEL_LABELS, FUEL_TYPES, choicePrice, decimalFr, estimateFuel, estimateKmLimit, gapKey, parseConsumption, type FuelEstimate, type FuelType, type PlannedStay, type TravelMode } from "@/lib/vehicules/v3/fuel-estimate-domain"
import {
  STALE_DECISION_CODES, createEstimateRequests, decisionsFor, decisionsOwner, defaultPriceKey, emptyDecisions, gapLabel, handoverConfirmLabel, kmLabel, medianLabel, medianUsable, missingDecisionsLabel,
  priceChoice, priceWarnings, proposedExpense, routeReason, stationDistanceLabel, stationsLabel, stayBlockedReason, stayDetails, stayLabel, staySelectable, totalKm, travelRecommendationLabel, uncomputedReason,
  type EstimateDecisions, type ExpenseProposal,
} from "./vehicle-fuel-estimate-ui"

const field = "block border rounded p-2 w-full text-black bg-white"
const button = "border rounded px-3 py-2 disabled:opacity-50"
const storageKey = (truckId: string) => `planificator:fuel-consumption:${truckId}`
const litresFr = (litres: number) => decimalFr(litres, 3).replace(/0+$/, "").replace(/,$/, "")

/**
 * Choix des déplacements d'un séjour : proposition de la règle interne affichée si la distance aller est connue, mais
 * les deux choix restent toujours accessibles et seul `mode` (choix explicite de l'opérateur) est coché — jamais la
 * proposition.
 */
export function TravelModeChoice({ mode, oneWayKm, onChoose }: { mode: TravelMode | null; oneWayKm: number | null; onChoose: (mode: TravelMode) => void }) {
  const recommendation = travelRecommendationLabel(oneWayKm)
  return <>
    {recommendation && <p className="text-slate-700">{recommendation}</p>}
    <label className="flex items-start gap-2"><input type="radio" name="fuel-travel" value="ONE_ROUND_TRIP" checked={mode === "ONE_ROUND_TRIP"} onChange={() => onChoose("ONE_ROUND_TRIP")} />
      <span>Séjour sur place (hébergement près du chantier) : un seul aller-retour siège ↔ chantier pour tout le séjour, le camion reste sur place</span></label>
    <label className="flex items-start gap-2"><input type="radio" name="fuel-travel" value="DAILY" checked={mode === "DAILY"} onChange={() => onChoose("DAILY")} />
      <span>Retour quotidien au siège : un aller-retour par jour planifié (jours sans planning non comptés)</span></label>
  </>
}

/**
 * Encadré « Estimation du trajet ». Source : un séjour planifié sur un chantier (départ le premier jour, retour le dernier,
 * équipe, chef actuel et chauffeur tirés du planning) ou un trajet relevé au compteur. Kilomètres, stations proches du
 * tracé, prix publics ; avec la consommation saisie, litres et montant estimés. La proposition est transmise au
 * formulaire (`onPropose`) à chaque changement — `null` dès que l'estimation n'est plus valable (« Aucun », chargement
 * d'une autre source, erreur, démontage) pour que le formulaire retire les valeurs automatiques périmées.
 */
export function VehicleFuelEstimate({ truckId, today, trips, onPropose }: { truckId: string; today: string; trips: { id: string; label: string }[]; onPropose: (proposal: ExpenseProposal | null, explicit: boolean) => void }) {
  const [source, setSource] = useState(""), [fuel, setFuel] = useState<FuelType>("GAZOLE"), [consumptionInput, setConsumptionInput] = useState(""), [extraInput, setExtraInput] = useState("")
  const [stays, setStays] = useState<PlannedStay[] | null>(null), [staysPartial, setStaysPartial] = useState(false), [staysError, setStaysError] = useState("")
  const [estimate, setEstimate] = useState<FuelEstimate | null>(null), [priceKey, setPriceKey] = useState(""), [loading, setLoading] = useState(false), [error, setError] = useState("")
  // Décisions de déplacement : rien de présélectionné ; rattachées au camion, à la source et au contexte du séjour.
  const [decisionsState, setDecisions] = useState<EstimateDecisions>(() => emptyDecisions(""))
  // Relecture de la liste des séjours (planning modifié depuis l'affichage).
  const [staysVersion, setStaysVersion] = useState(0)
  const propose = useRef(onPropose)
  propose.current = onPropose
  const requests = useMemo(() => createEstimateRequests((input, init) => fetch(input, init), {
    onReset: () => { setEstimate(null); setPriceKey(""); setError("") },
    onLoading: setLoading,
    onResult: (result) => { setEstimate(result); setPriceKey(defaultPriceKey(result)) },
    onError: (message, code) => {
      setError(message)
      // Contexte périmé : choix retirés, séjours relus ; rien n'est transposé sur le nouveau planning.
      if (code && STALE_DECISION_CODES.has(code)) { setDecisions(emptyDecisions("")); setStaysVersion((v) => v + 1) }
    },
  }), [])

  // Consommation retenue pour ce véhicule dans ce navigateur seulement (commodité, jamais une donnée partagée).
  useEffect(() => { try { setConsumptionInput(window.localStorage.getItem(storageKey(truckId)) ?? "") } catch { /* stockage indisponible */ } }, [truckId])
  const consumption = parseConsumption(consumptionInput)
  useEffect(() => { if (consumption === null) return; try { window.localStorage.setItem(storageKey(truckId), consumptionInput.trim()) } catch { /* stockage indisponible */ } }, [truckId, consumption, consumptionInput])
  const extraKm = /^\d{1,5}$/.test(extraInput.trim()) ? Number(extraInput.trim()) : 0

  useEffect(() => {
    const controller = new AbortController()
    void fetch(`/api/trucks/${encodeURIComponent(truckId)}/fuel-estimate/stays`, { cache: "no-store", signal: controller.signal })
      .then(async (response) => { const body = await response.json().catch(() => ({})); if (controller.signal.aborted) return; if (!response.ok) throw new Error(); setStays(body.stays); setStaysPartial(!!body.partial) })
      .catch(() => { if (!controller.signal.aborted) setStaysError("Chantiers planifiés indisponibles : les trajets relevés au compteur restent utilisables.") })
    return () => controller.abort()
  }, [truckId, staysVersion])

  // Remises à zéro à chaque changement de source, de véhicule ou de contexte du séjour (planning relu différent).
  const selectedStay = useMemo(() => source.startsWith("stay:") ? stays?.find((s) => `stay:${s.id}` === source) ?? null : null, [source, stays])
  const owner = decisionsOwner(truckId, source, selectedStay?.context)
  const decisions = useMemo(() => decisionsFor(decisionsState, owner), [decisionsState, owner])
  const update = (patch: Partial<Omit<EstimateDecisions, "owner">>) => setDecisions({ ...decisions, ...patch, owner })
  const chooseSource = (value: string) => { setSource(value); setDecisions(emptyDecisions("")) }
  useEffect(() => { setDecisions(emptyDecisions("")) }, [truckId])
  // Réaffectation en journée non déclarée : aucune requête (le serveur refuserait), seulement la demande de déclaration.
  const awaitingHandover = selectedStay?.blocked === "HANDOVER" && !decisions.handover

  useEffect(() => { requests.select(truckId, awaitingHandover ? "" : source, fuel, decisions, selectedStay) }, [truckId, source, fuel, decisions, selectedStay, awaitingHandover, requests])
  // Démontage (fermeture, passage en modification) : plus aucune réponse appliquée, valeurs automatiques retirées.
  useEffect(() => () => { requests.dispose(); propose.current(null, false) }, [requests])

  // Mémorisé : un nouvel objet à chaque rendu relancerait le préremplissage en boucle.
  const choice = useMemo(() => estimate ? priceChoice(estimate, priceKey, today) : null, [estimate, priceKey, today])
  const proposed = useMemo(() => estimate ? proposedExpense(estimate, choice, consumption, extraKm) : null, [estimate, choice, consumption, extraKm])
  // `null` aussi : estimation effacée (autre source, erreur, « Aucun ») = valeurs automatiques retirées du formulaire.
  useEffect(() => { propose.current(proposed, false) }, [proposed])
  const km = estimate ? totalKm(estimate, extraKm) : null
  const computed = estimate ? estimateFuel({ km, consumptionLPer100Km: consumption, pricePerLitre: choice ? choicePrice(choice) : null, maxKm: estimateKmLimit(estimate) }) : null
  const station = choice?.kind === "STATION" ? choice.station : null
  const median = estimate ? medianLabel(estimate) : null

  return <div className="md:col-span-2 border rounded p-3 space-y-3 bg-slate-50" aria-busy={loading}>
    <h3 className="font-semibold">Estimation du trajet</h3>
    <p className="text-sm">Choisissez un chantier planifié ou un trajet relevé : la dépense est préremplie avec les kilomètres, le prix du carburant près du trajet et la date de départ. C'est une estimation en euros : elle reste « À valider » et le montant du ticket prime.</p>
    <div className="grid md:grid-cols-2 gap-3">
      <label className="md:col-span-2">Chantier ou trajet<select className={field} value={source} onChange={(e) => chooseSource(e.target.value)}>
        <option value="">Aucun</option>
        {!!stays?.length && <optgroup label="Chantiers planifiés (départ → retour)">{stays.map((s) => <option key={s.id} value={`stay:${s.id}`} disabled={!staySelectable(s)}>{stayLabel(s)}</option>)}</optgroup>}
        {trips.length > 0 && <optgroup label="Trajets relevés au compteur">{trips.map((t) => <option key={t.id} value={`trip:${t.id}`}>{t.label}</option>)}</optgroup>}
      </select></label>
      <label>Carburant<select className={field} value={fuel} onChange={(e) => setFuel(e.target.value as FuelType)}>{FUEL_TYPES.map((f) => <option key={f} value={f}>{FUEL_LABELS[f]}</option>)}</select></label>
      <label>Consommation (L/100 km)<input className={field} inputMode="decimal" value={consumptionInput} onChange={(e) => setConsumptionInput(e.target.value)} placeholder="Ex. 9,5" aria-invalid={!!consumptionInput.trim() && consumption === null} /></label>
      <label>Déplacements sur place (km, facultatif)<input className={field} inputMode="numeric" value={extraInput} onChange={(e) => setExtraInput(e.target.value)} placeholder="0" aria-invalid={!!extraInput.trim() && !/^\d{1,5}$/.test(extraInput.trim())} /></label>
    </div>
    {staysError && <p role="status" className="text-sm text-amber-800">{staysError}</p>}
    {stays && !stays.length && <p className="text-sm">Aucun chantier planifié pour l'équipe de ce véhicule sur les 60 derniers et 60 prochains jours.</p>}
    {staysPartial && <p role="status" className="text-sm text-amber-800">Planning très chargé : la liste des chantiers est partielle.</p>}
    {stays?.some((s) => !s.estimable) && <p className="text-sm">{[...new Set(stays.filter((s) => !s.estimable).map((s) => stayBlockedReason(s)))].join(" ")}</p>}
    {selectedStay && <fieldset className="space-y-1 text-sm"><legend className="font-medium">Déplacements siège ↔ chantier (à choisir, aucun choix par défaut)</legend>
      {/* Distance aller du résultat déjà reçu pour ce séjour (réinitialisé à chaque changement de source) : aucun appel en plus. */}
      <TravelModeChoice mode={decisions.mode} oneWayKm={estimate?.source === "STAY" ? estimate.route.oneWayKm : null}
        onChoose={(mode) => update(mode === "DAILY" ? { mode, gaps: {} } : { mode })} />
      {decisions.mode === "ONE_ROUND_TRIP" && selectedStay.gaps.map((g) => { const k = gapKey(g); return <div key={k} role="group" aria-label={gapLabel(g)} className="pl-6 space-y-1">
        <p>{gapLabel(g)} : le camion est-il resté sur place ?</p>
        <label className="flex items-start gap-2"><input type="radio" name={`fuel-gap-${k}`} value="STAY" checked={decisions.gaps[k] === "STAY"} onChange={() => update({ gaps: { ...decisions.gaps, [k]: "STAY" } })} /><span>Resté sur place</span></label>
        <label className="flex items-start gap-2"><input type="radio" name={`fuel-gap-${k}`} value="RETURN" checked={decisions.gaps[k] === "RETURN"} onChange={() => update({ gaps: { ...decisions.gaps, [k]: "RETURN" } })} /><span>Rentré au siège puis reparti (un aller-retour de plus)</span></label>
      </div> })}
    </fieldset>}
    {selectedStay?.blocked === "HANDOVER" && <label className="flex items-start gap-2 text-sm"><input type="checkbox" name="fuel-handover" checked={decisions.handover} onChange={(e) => update({ handover: e.target.checked })} />
      <span>{handoverConfirmLabel(selectedStay)}</span></label>}
    {source && (selectedStay || decisions.depot || estimate?.missing.includes("DEPOT")) && <label className="flex items-start gap-2 text-sm"><input type="checkbox" name="fuel-depot" checked={decisions.depot} onChange={(e) => update({ depot: e.target.checked })} />
      <span>Le camion part du siège de l'entreprise et y revient (sinon l'itinéraire ne correspond pas au trajet : saisissez le montant du ticket).</span></label>}
    {consumptionInput.trim() && consumption === null && <p role="status" className="text-sm text-amber-800">Consommation attendue entre 1 et 80 L/100 km.</p>}
    {loading && <p role="status" className="text-sm">Calcul de l'itinéraire et recherche des stations près du trajet…</p>}
    {error && <p role="status" className="text-sm text-amber-800">{error}</p>}
    {estimate && <div className="space-y-2 text-sm">
      {estimate.stay && stayDetails(estimate.stay).map((line) => <p key={line}>{line}</p>)}
      <p>{kmLabel(estimate)}{extraKm > 0 && km !== null ? ` Avec ${extraKm} km sur place : ${km} km.` : ""}</p>
      {missingDecisionsLabel(estimate.missing).map((m) => <p key={m} role="status" className="text-amber-800">{m}</p>)}
      {routeReason(estimate.route.status) && <p className="text-amber-800">{routeReason(estimate.route.status)}</p>}
      <p>{stationsLabel(estimate.stationsStatus, estimate.stations.length, estimate.priceStats?.count ?? estimate.stations.length, estimate.priceStats?.sampled ?? false)}</p>
      {(estimate.priceStats || estimate.stations.length > 0) && <fieldset className="space-y-1"><legend className="sr-only">Prix retenu</legend>
        {estimate.priceStats && (medianUsable(estimate)
          ? <label className="flex items-start gap-2"><input type="radio" name="fuel-price" value="MEDIAN" checked={priceKey === "MEDIAN"} onChange={() => setPriceKey("MEDIAN")} />
            <span><strong>{decimalFr(estimate.priceStats.median, 3)} €/L</strong> · {median}</span></label>
          // Échantillon tronqué : médiane affichée désactivée, sans valeur chiffrée qui passerait pour représentative.
          : <label className="flex items-start gap-2 text-slate-600"><input type="radio" name="fuel-price" value="MEDIAN" checked={false} disabled aria-describedby="fuel-median-unavailable" onChange={() => {}} />
            <span id="fuel-median-unavailable">{median}</span></label>)}
        {estimate.stations.map((s) => <label key={s.id} className="flex items-start gap-2"><input type="radio" name="fuel-price" value={s.id} checked={s.id === priceKey} onChange={() => setPriceKey(s.id)} />
          <span><strong>{decimalFr(s.price, 3)} €/L</strong> · {s.label}, {s.city} · {stationDistanceLabel(s.offRouteKm)} · prix indicatif publié le {s.updatedAt.slice(8, 10)}/{s.updatedAt.slice(5, 7)}{s.open24h ? " · automate 24/24" : ""}</span></label>)}
      </fieldset>}
      {priceWarnings(estimate, station, today).map((w) => <p key={w} className="text-amber-800">{w}</p>)}
      {computed && choice ? <p className="font-medium">Estimation : {km} km × {decimalFr(consumption!, 1)} L/100 km = {litresFr(computed.litres)} L × {decimalFr(choicePrice(choice), 3)} €/L = {decimalFr(computed.amount, 2)} € (péages non compris)</p>
        : <p>{uncomputedReason(estimate, km, consumption, choice)}</p>}
      {proposed?.provenance && <p className="text-xs text-slate-700">Provenance enregistrée avec la dépense (en plus de vos notes) : {proposed.provenance}</p>}
      {proposed && <button type="button" className={button} onClick={() => onPropose(proposed, true)}>Reprendre l'estimation</button>}
    </div>}
  </div>
}
