"use client"

/**
 * Pleins payés avec les cartes d'entreprise, repérés dans les relevés bancaires importés.
 * Les pleins de la carte de ce camion sont créés seuls à l'import ; ici restent ceux à ajouter ou à confirmer.
 */
import { useCallback, useEffect, useState } from "react"
import Link from "next/link"
import { bankFuelExpenseCommand } from "@/lib/vehicules/v3/bank-fuel-domain"
import type { BankFuelResult, BankFuelSuggestion } from "@/lib/vehicules/v3/bank-fuel-service"

const eur = new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR" })
const date = (d: string) => new Intl.DateTimeFormat("fr-FR", { day: "2-digit", month: "short", timeZone: "UTC" }).format(new Date(`${d}T00:00:00Z`))
const button = "rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-medium hover:bg-slate-50 disabled:opacity-50"

function reason(s: BankFuelSuggestion): string {
  const r = s.resolution
  switch (r.kind) {
    case "CARD": return `Carte •${r.card} de ce camion`
    case "ONLY_TOUR": return "Seul camion en tournée ce jour-là"
    case "TOWN": return `Station à ${r.town[0]}${r.town.slice(1).toLowerCase()}, sur la tournée de ce camion`
    case "UNRESOLVED": {
      const names = r.candidates.map((c) => s.truckLabels[c] ?? "camion").join(", ")
      return r.candidates.length > 1 ? `Plusieurs camions en route ce jour-là : ${names}${s.card ? ` (carte •${s.card} pas encore reconnue)` : ""}` : `Aucune tournée ce jour-là${s.card ? `, carte •${s.card} pas encore reconnue` : ""}`
    }
    default: return ""
  }
}

export function VehicleBankFuel({ truckId, from, to, onRecorded }: { truckId: string; from: string; to: string; onRecorded: () => void }) {
  const [data, setData] = useState<BankFuelResult | null>(null)
  const [state, setState] = useState<"loading" | "ready" | "error">("loading")
  const [busy, setBusy] = useState<string | null>(null)
  const [message, setMessage] = useState("")
  const [reload, setReload] = useState(0)

  useEffect(() => {
    if (!from || !to || to < from) return
    const controller = new AbortController()
    setState("loading")
    fetch(`/api/trucks/${encodeURIComponent(truckId)}/bank-fuel?${new URLSearchParams({ from, to })}`, { cache: "no-store", signal: controller.signal })
      .then(async (r) => { if (!r.ok) throw new Error(); return (await r.json()) as BankFuelResult })
      .then((d) => { setData(d); setState("ready") })
      .catch(() => { if (!controller.signal.aborted) setState("error") })
    return () => controller.abort()
  }, [truckId, from, to, reload])

  const record = useCallback(async (lines: BankFuelSuggestion[]) => {
    if (busy || lines.length === 0) return
    setBusy(lines.length === 1 ? lines[0].id : "all")
    setMessage("")
    let ok = 0
    for (const l of lines) {
      try {
        const r = await fetch(`/api/trucks/${encodeURIComponent(truckId)}/expenses`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "Idempotency-Key": l.idempotencyKey },
          body: JSON.stringify(bankFuelExpenseCommand(l)),
        })
        if (r.ok) ok++
      } catch { /* compté comme échec ci-dessous */ }
    }
    setBusy(null)
    setMessage(ok === lines.length
      ? `${ok} plein${ok > 1 ? "s" : ""} ajouté${ok > 1 ? "s" : ""}, à valider dans le registre.`
      : `${ok} sur ${lines.length} ajouté(s). Réessayez pour les autres.`)
    setReload((n) => n + 1)
    onRecorded()
  }, [busy, onRecorded, truckId])

  if (state === "loading") return <p role="status" className="text-sm text-slate-500">Lecture des relevés bancaires…</p>
  if (state === "error" || !data) return <p className="text-sm text-slate-500">Relevés bancaires indisponibles pour le moment.</p>

  const nothing = data.forTruck.length === 0 && data.toConfirm.length === 0
  return (
    <div className="space-y-3 rounded-xl border border-slate-200 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-semibold">Pleins payés par carte bancaire</h3>
        {data.forTruck.length > 1 && <button className={button} disabled={!!busy} onClick={() => void record(data.forTruck)}>Tout ajouter ({data.forTruck.length})</button>}
      </div>
      {data.statementsInPeriod === 0 ? (
        <p className="text-sm text-slate-600">
          Aucun relevé bancaire sur cette période. Importez le relevé mensuel (CSV) dans{" "}
          <Link className="underline" href="/comptabilite/banque">Comptabilité → Banque</Link> : les pleins de la carte de ce camion s’ajoutent alors seuls.
        </p>
      ) : nothing ? (
        <p className="text-sm text-slate-600">
          Rien à traiter.{data.recordedCount > 0 && ` ${data.recordedCount} plein${data.recordedCount > 1 ? "s" : ""} du relevé déjà enregistré${data.recordedCount > 1 ? "s" : ""} sur ce camion.`}
        </p>
      ) : null}

      {[...data.forTruck.map((s) => ({ s, sure: true })), ...data.toConfirm.map((s) => ({ s, sure: false }))].map(({ s, sure }) => (
        <div key={s.id} className="flex flex-wrap items-center justify-between gap-2 border-t pt-2 text-sm first:border-0 first:pt-0">
          <div>
            <p className="font-medium">{date(s.day)} · {eur.format(Number(s.amount))} · <span className="font-normal">{s.label}</span></p>
            <p className={sure ? "text-xs text-emerald-700" : "text-xs text-amber-700"}>{reason(s)}</p>
          </div>
          <button className={button} disabled={!!busy} onClick={() => void record([s])}>{busy === s.id ? "Ajout…" : sure ? "Ajouter" : "C’est ce camion"}</button>
        </div>
      ))}
      {data.toConfirm.length > 0 && <p className="text-xs text-slate-500">Une confirmation suffit : la carte est alors reconnue pour ce camion, et ses pleins des prochains relevés s’ajoutent seuls.</p>}
      {message && <p role="status" className="text-sm text-slate-700">{message}</p>}
    </div>
  )
}
