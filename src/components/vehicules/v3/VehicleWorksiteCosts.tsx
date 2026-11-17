"use client"

/**
 * Coûts du camion par chantier — vue automatique : aucune saisie, aucun rattachement manuel.
 * Km des tournées, carburant estimé et dépenses réelles rattachées au chantier du jour.
 */
import { useEffect, useState } from "react"
import Link from "next/link"
import type { WorksiteCostsResult } from "@/lib/vehicules/v3/worksite-costs-service"
import { VehicleBankFuel } from "./VehicleBankFuel"

const eur = new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR" })
const num = new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 1 })
const input = "block w-full rounded-lg border border-slate-300 bg-white p-2 text-black"

function monthStart(today: string) { return `${today.slice(0, 8)}01` }

export function VehicleWorksiteCosts({ truckId, timeZone }: { truckId: string; timeZone: string }) {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date())
  const [from, setFrom] = useState(monthStart(today))
  const [to, setTo] = useState(today)
  const [data, setData] = useState<WorksiteCostsResult | null>(null)
  const [state, setState] = useState<"loading" | "ready" | "error">("loading")
  const [reload, setReload] = useState(0)

  useEffect(() => {
    if (!from || !to || to < from) return
    const controller = new AbortController()
    setState("loading")
    const query = new URLSearchParams({ from, to })
    fetch(`/api/trucks/${encodeURIComponent(truckId)}/worksite-costs?${query}`, { cache: "no-store", signal: controller.signal })
      .then(async (r) => { if (!r.ok) throw new Error(); return (await r.json()) as WorksiteCostsResult })
      .then((d) => { setData(d); setState("ready") })
      .catch(() => { if (!controller.signal.aborted) setState("error") })
    return () => controller.abort()
  }, [truckId, from, to, reload])

  const priceNote = data?.fuelPrice
    ? `${num.format(data.consumptionLPer100Km)} L/100 km × ${data.fuelPrice.pricePerLitre.toFixed(3).replace(".", ",")} €/L (${data.fuelPrice.source === "TRUCK_HISTORY" ? "prix moyen des tickets de ce camion" : "prix moyen du gazole en France aujourd’hui"})`
    : `${num.format(data?.consumptionLPer100Km ?? 10)} L/100 km (prix du carburant indisponible : montant non calculé)`

  return (
    <section aria-labelledby="worksite-costs" className="space-y-4 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 id="worksite-costs" className="text-xl font-semibold">Coûts par chantier</h2>
          <p className="text-sm text-slate-600">Calcul automatique à partir des tournées, du planning de l’équipe, des dépenses et des relevés de la carte du camion.</p>
        </div>
        <div className="flex gap-2">
          <label className="text-sm">Du<input type="date" className={input} value={from} max={to} onChange={(e) => setFrom(e.target.value)} /></label>
          <label className="text-sm">Au<input type="date" className={input} value={to} min={from} onChange={(e) => setTo(e.target.value)} /></label>
        </div>
      </div>

      {state === "loading" && <p role="status" className="text-sm text-slate-500">Calcul en cours…</p>}
      {state === "error" && <p role="alert" className="text-sm text-red-700">Coûts par chantier indisponibles pour le moment. Réessayez dans un instant.</p>}

      {state === "ready" && data && (data.rows.length === 0 ? (
        <p className="rounded-lg bg-slate-50 p-3 text-sm text-slate-700">
          Aucune tournée ni dépense sur cette période. Créez la tournée depuis la fiche chantier ou l’onglet{" "}
          <Link className="underline" href={`/vehicules/${encodeURIComponent(truckId)}/tournees`}>Tournées</Link> : les kilomètres et le carburant se calculent ensuite seuls.
        </p>
      ) : (
        <>
          <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <div className="rounded-xl bg-slate-50 p-3"><dt className="text-sm text-slate-600">Kilomètres des tournées</dt><dd className="text-2xl font-semibold">{num.format(data.totals.km)} km</dd></div>
            <div className="rounded-xl bg-slate-50 p-3"><dt className="text-sm text-slate-600">Carburant estimé</dt><dd className="text-2xl font-semibold">{data.totals.estimatedFuelCost === null ? "—" : eur.format(data.totals.estimatedFuelCost)}</dd></div>
            <div className="rounded-xl bg-slate-50 p-3"><dt className="text-sm text-slate-600">Dépenses enregistrées</dt><dd className="text-2xl font-semibold">{eur.format(data.totals.expensesTotal)}</dd></div>
            <div className="rounded-xl bg-slate-50 p-3"><dt className="text-sm text-slate-600">Péages, repas, hôtels (carte)</dt><dd className="text-2xl font-semibold">{eur.format(data.totals.cardSpendTotal)}</dd></div>
          </dl>

          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="border-b text-slate-600">
                <tr><th className="py-2 pr-3">Chantier</th><th className="py-2 pr-3">Tournées</th><th className="py-2 pr-3 text-right">Km</th><th className="py-2 pr-3 text-right">Carburant estimé</th><th className="py-2 pr-3 text-right">Dépenses enregistrées</th><th className="py-2 text-right">Péages, repas, hôtels</th></tr>
              </thead>
              <tbody>
                {data.rows.map((r) => (
                  <tr key={r.key} className="border-b align-top last:border-0">
                    <td className="py-2 pr-3 font-medium">
                      {r.worksiteId ? <Link className="underline" href={`/chantiers/${encodeURIComponent(r.worksiteId)}`}>{r.name}</Link> : <span className="text-slate-500">{r.name}</span>}
                    </td>
                    <td className="py-2 pr-3">
                      {r.tours.length === 0 ? <span className="text-slate-400">—</span> : r.tours.map((t) => <span key={t.id} className="block">{t.title}</span>)}
                      {r.toursWithoutKm > 0 && (
                        <Link className="block text-xs text-amber-700 underline" href={`/vehicules/${encodeURIComponent(truckId)}/tournees`}>
                          {r.toursWithoutKm} tournée{r.toursWithoutKm > 1 ? "s" : ""} sans km : calculer dans Tournées
                        </Link>
                      )}
                    </td>
                    <td className="whitespace-nowrap py-2 pr-3 text-right">{r.km > 0 ? `${num.format(r.km)} km` : "—"}</td>
                    <td className="py-2 pr-3 text-right">
                      {r.estimatedFuelCost !== null ? eur.format(r.estimatedFuelCost) : r.estimatedLitres !== null ? `${num.format(r.estimatedLitres)} L` : "—"}
                      {r.estimatedLitres !== null && r.estimatedFuelCost !== null && <span className="block text-xs text-slate-500">{num.format(r.estimatedLitres)} L</span>}
                    </td>
                    <td className="py-2 pr-3 text-right">
                      {r.expensesTotal > 0 ? eur.format(r.expensesTotal) : "—"}
                      {r.pendingExpenses > 0 && <span className="block text-xs text-amber-700">dont {r.pendingExpenses} à valider</span>}
                    </td>
                    <td className="py-2 text-right">
                      {r.cardSpendTotal > 0 ? eur.format(r.cardSpendTotal) : "—"}
                      {r.cardSpendTotal > 0 && <span className="block text-xs text-slate-500">{[["Péages", r.cardSpend.TOLL], ["Repas", r.cardSpend.MEAL], ["Hôtels", r.cardSpend.HOTEL]].filter(([, v]) => (v as number) > 0).map(([k, v]) => `${k} ${eur.format(v as number)}`).join(" · ")}</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <p className="text-xs text-slate-500">
            Carburant estimé : {priceNote}. C’est une estimation, pas une dépense : les tickets enregistrés restent la référence.
            Dépenses et frais de carte sont rattachés au chantier de la tournée du camion à leur date, sinon au chantier où l’équipe est planifiée ce jour-là.
            {data.otherCurrencyExpenses > 0 && ` ${data.otherCurrencyExpenses} dépense(s) dans une autre devise non comptée(s).`}
          </p>
        </>
      ))}

      {state !== "error" && <VehicleBankFuel truckId={truckId} from={from} to={to} onRecorded={() => setReload((n) => n + 1)} />}
    </section>
  )
}
