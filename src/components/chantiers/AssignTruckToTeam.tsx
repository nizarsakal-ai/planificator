"use client"

/**
 * Affecte un véhicule à une équipe du chantier, depuis la fiche chantier. Même opération que la page
 * Véhicules (PATCH /api/trucks/{id} { teamId }) : historique d'affectation conservé, ancien rattachement
 * retiré par le serveur.
 */
import { useState } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import type { AssignableTruck } from "@/lib/chantiers/worksite-vehicles"

const ERRORS: Record<string, string> = {
  FORBIDDEN: "Vous n’avez pas le droit d’affecter ce véhicule.",
  TEAM_NOT_FOUND: "Équipe introuvable : actualisez la page.",
  TRUCK_NOT_FOUND: "Véhicule introuvable : actualisez la page.",
}

export function AssignTruckToTeam({ teamId, teamName, trucks }: { teamId: string; teamName: string; trucks: AssignableTruck[] }) {
  const router = useRouter()
  const [truckId, setTruckId] = useState(trucks[0]?.id ?? "")
  const [busy, setBusy] = useState(false)
  const selected = trucks.find((t) => t.id === truckId) ?? null
  const duplicate = trucks.find((t) => t.sameNameTeam) ?? null

  if (trucks.length === 0) return <p className="text-sm text-slate-500">Aucun véhicule actif : ajoutez-en un dans Véhicules.</p>

  async function assign() {
    if (!selected || busy) return
    setBusy(true)
    try {
      const res = await fetch(`/api/trucks/${encodeURIComponent(selected.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ teamId }),
      })
      const body = (await res.json().catch(() => ({}))) as { code?: string; error?: string }
      if (!res.ok) { toast.error(ERRORS[body.code ?? ""] ?? body.error ?? "Affectation impossible, réessayez."); return }
      toast.success(`${selected.matricule} affecté à l’équipe ${teamName}.`)
      router.refresh()
    } catch {
      toast.error("Connexion perdue : réessayez.")
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-2 rounded-md bg-amber-50/60 p-2">
      {duplicate && (
        <p className="text-xs text-amber-800">
          Le véhicule <span className="font-mono">{duplicate.matricule}</span> est rattaché à une autre équipe nommée « {duplicate.team?.name} » (équipe en double) :
          affectez-le à l’équipe planifiée sur ce chantier.
        </p>
      )}
      <div className="flex flex-wrap items-end gap-2">
        <label className="text-xs text-slate-600">
          Véhicule
          <select className="mt-0.5 block rounded border border-slate-300 bg-white px-2 py-1 text-sm text-slate-900" value={truckId} disabled={busy} onChange={(e) => setTruckId(e.target.value)}>
            {trucks.map((t) => (
              <option key={t.id} value={t.id}>
                {t.matricule} · {t.label}{t.chauffeurName ? ` · ${t.chauffeurName}` : ""}{t.team ? ` (équipe ${t.team.name}${t.sameNameTeam ? ", doublon" : ""})` : " (libre)"}
              </option>
            ))}
          </select>
        </label>
        <button type="button" disabled={!selected || busy} onClick={() => void assign()} className="rounded bg-blue-700 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50">
          {busy ? "Affectation…" : `Affecter à l’équipe ${teamName}`}
        </button>
      </div>
      {selected?.team && !selected.sameNameTeam && (
        <p className="text-xs text-slate-600">Ce véhicule quittera l’équipe {selected.team.name}.</p>
      )}
    </div>
  )
}
