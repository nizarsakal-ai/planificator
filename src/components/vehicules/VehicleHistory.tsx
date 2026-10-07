import { History } from "lucide-react"
import {
  historyReasonLabel,
  VEHICLE_HISTORY_LIMIT,
  type VehicleHistoryEntry,
} from "@/lib/vehicules/vehicules-view"

const fmtDate = (iso: string) =>
  new Date(iso).toLocaleDateString("fr-FR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  })

interface VehicleHistoryProps {
  entries: VehicleHistoryEntry[]
  /** Des périodes plus anciennes que celles affichées existent. */
  truncated: boolean
}

/** Historique des affectations (V1B) avec le motif de chaque période ; lecture seule. */
export function VehicleHistory({ entries, truncated }: VehicleHistoryProps) {
  return (
    <div className="mt-3 pt-3 border-t border-slate-100">
      <p className="text-xs font-medium text-slate-500 uppercase tracking-wide mb-2 flex items-center gap-1.5">
        <History className="h-3.5 w-3.5" aria-hidden="true" />
        Historique des affectations
      </p>
      {entries.length === 0 ? (
        <p className="text-xs text-slate-400 italic py-1">
          Aucun historique pour le moment. Les prochains changements de chauffeur ou d&apos;équipe seront enregistrés ici.
        </p>
      ) : (
        <div className="space-y-1.5 max-h-48 overflow-y-auto pr-1">
          {entries.map((h) => {
            const reason = historyReasonLabel(h.reason)
            return (
              <div key={h.id} className="text-xs bg-slate-50 rounded-lg px-2.5 py-1.5 flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <p className="font-medium text-slate-700 truncate">
                    {h.chauffeurName ?? "Aucun chauffeur"}
                    {h.teamName && <span className="text-slate-400 font-normal"> · équipe {h.teamName}</span>}
                  </p>
                  <p className="text-slate-400">
                    {fmtDate(h.startedAt)} → {h.endedAt ? fmtDate(h.endedAt) : "en cours"}
                  </p>
                </div>
                <div className="flex shrink-0 flex-col items-end gap-1">
                  {reason && (
                    <span className="text-[10px] font-medium text-slate-600 bg-white border border-slate-200 rounded px-1.5 py-0.5">
                      {reason}
                    </span>
                  )}
                  {!h.endedAt && (
                    <span className="text-[10px] font-medium text-green-700 bg-green-50 border border-green-200 rounded px-1.5 py-0.5">
                      Actuel
                    </span>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}
      {truncated && (
        <p className="mt-2 text-[11px] text-slate-400">{VEHICLE_HISTORY_LIMIT} dernières périodes affichées</p>
      )}
    </div>
  )
}
