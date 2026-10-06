"use client"

import { Archive, ArchiveRestore, History, Layers, Pencil, Truck, User } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent } from "@/components/ui/card"
import { VehicleHistory } from "@/components/vehicules/VehicleHistory"
import { vehicleIdentityLabel, formatVehicleIdentity, vehicleAssignmentBadge, type VehicleViewItem } from "@/lib/vehicules/vehicules-view"

export interface VehicleTeamOption {
  id: string
  name: string
}
export interface VehicleEmployeeOption {
  id: string
  firstName: string
  lastName: string
}

interface VehiculeCardProps {
  truck: VehicleViewItem
  /** Équipes ACTIVES (seules affectables). */
  teams: VehicleTeamOption[]
  /** Employés ACTIFS (seuls nouvellement affectables). */
  employees: VehicleEmployeeOption[]
  layout: "grid" | "list"
  loading: boolean
  historyOpen: boolean
  onToggleHistory: () => void
  onEdit: () => void
  onArchive: () => void
  onRestore: () => void
  onAssign: (body: { teamId: string | null } | { chauffeurId: string | null }) => void
}

const SELECT =
  "flex-1 min-w-0 text-sm border border-slate-200 rounded-lg px-2 py-1.5 bg-white text-slate-700 focus:outline-none focus:ring-2 focus:ring-blue-500"
const ICON_BTN =
  "p-1.5 rounded-lg border border-slate-200 text-slate-500 transition-colors"

/** Carte véhicule compacte (mosaïque ou liste) : identité, statut, équipe, chauffeur, actions, historique. */
export function VehiculeCard({
  truck: t, teams, employees, layout, loading, historyOpen, onToggleHistory, onEdit, onArchive, onRestore, onAssign,
}: VehiculeCardProps) {
  const identity = formatVehicleIdentity(t.marque, t.modele)
  const teamArchived = t.team !== null && !teams.some((team) => team.id === t.team!.id)
  const badge = vehicleAssignmentBadge(t)
  const driverInactive = t.chauffeur !== null && !employees.some((e) => e.id === t.chauffeur!.id)

  const historyButton = (
    <button
      type="button"
      onClick={onToggleHistory}
      title="Historique des affectations"
      aria-label={`Historique du véhicule ${t.matricule}`}
      aria-expanded={historyOpen}
      className={`${ICON_BTN} ${
        historyOpen ? "border-blue-400 text-blue-500 bg-blue-50" : "hover:border-blue-400 hover:text-blue-500"
      }`}
    >
      <History className="h-3.5 w-3.5" />
    </button>
  )

  // Véhicule archivé : jamais d'affectation possible ; consultation et restauration uniquement.
  if (!t.active) {
    return (
      <Card className="border-slate-200 bg-slate-50/60">
        <CardContent className="p-4">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <p className="font-semibold text-slate-700">{t.matricule}</p>
                <Badge variant="secondary">Archivé</Badge>
              </div>
              <p className="text-xs text-slate-400">
                {vehicleIdentityLabel(t.marque, t.modele)}
                {t.archivedAt && ` · archivé le ${new Date(t.archivedAt).toLocaleDateString("fr-FR")}`}
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
              {historyButton}
              <Button variant="outline" size="sm" disabled={loading} onClick={onRestore} className="gap-1.5">
                <ArchiveRestore className="h-3.5 w-3.5" />
                Restaurer
              </Button>
            </div>
          </div>
          {historyOpen && <VehicleHistory entries={t.history} truncated={t.historyTruncated} />}
        </CardContent>
      </Card>
    )
  }

  const isList = layout === "list"

  return (
    <Card className="overflow-hidden hover:shadow-md transition-shadow">
      {!isList && <div className="h-1.5 w-full" style={{ backgroundColor: t.team?.color ?? "#94a3b8" }} />}
      <CardContent className={isList ? "p-3 border-l-4" : "p-5"} style={isList ? { borderLeftColor: t.team?.color ?? "#94a3b8" } : undefined}>
        <div className={isList ? "flex flex-col gap-3 lg:flex-row lg:items-center" : ""}>
          <div className={`flex items-start justify-between gap-3 ${isList ? "lg:w-[22rem] lg:shrink-0" : "mb-4"}`}>
            <div className="flex min-w-0 items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-slate-100 flex items-center justify-center shrink-0">
                <Truck className="h-5 w-5 text-slate-500" />
              </div>
              <div className="min-w-0">
                <h3 className="font-semibold tracking-wide text-slate-900">{t.matricule}</h3>
                <p className={`text-xs mt-0.5 truncate ${identity ? "text-slate-500" : "text-slate-400"}`}>
                  {vehicleIdentityLabel(t.marque, t.modele)}
                </p>
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
              <Badge variant={badge.assigned ? "default" : "secondary"}>
                {`${badge.label}${t.team && teamArchived ? " (archivée)" : ""}`}
              </Badge>
              {historyButton}
              <button
                type="button"
                onClick={onEdit}
                disabled={loading}
                title="Modifier le véhicule"
                aria-label={`Modifier le véhicule ${t.matricule}`}
                className={`${ICON_BTN} hover:border-blue-400 hover:text-blue-500`}
              >
                <Pencil className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                onClick={onArchive}
                disabled={loading}
                title="Archiver le véhicule"
                aria-label={`Archiver le véhicule ${t.matricule}`}
                className={`${ICON_BTN} hover:border-amber-400 hover:text-amber-600`}
              >
                <Archive className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>

          <div className={isList ? "flex flex-1 flex-col gap-2 sm:flex-row" : "space-y-2"}>
            {/* Affectation équipe */}
            <div className="flex flex-1 items-center gap-2 min-w-0">
              <Layers className="h-3.5 w-3.5 text-slate-400 shrink-0" aria-hidden="true" />
              <select
                aria-label={`Équipe du véhicule ${t.matricule}`}
                disabled={loading}
                value={t.team?.id ?? ""}
                onChange={(e) => onAssign({ teamId: e.target.value || null })}
                className={SELECT}
              >
                <option value="">Aucune équipe</option>
                {/* Équipe actuelle archivée (legacy) : affichée telle quelle, jamais réécrite sans action. */}
                {t.team && teamArchived && <option value={t.team.id}>{t.team.name} (archivée)</option>}
                {teams.map((team) => (
                  <option key={team.id} value={team.id}>{team.name}</option>
                ))}
              </select>
            </div>

            {/* Affectation chauffeur */}
            <div className="flex flex-1 items-center gap-2 min-w-0">
              <User className="h-3.5 w-3.5 text-slate-400 shrink-0" aria-hidden="true" />
              <select
                aria-label={`Chauffeur du véhicule ${t.matricule}`}
                disabled={loading}
                value={t.chauffeur?.id ?? ""}
                onChange={(e) => onAssign({ chauffeurId: e.target.value || null })}
                className={SELECT}
              >
                <option value="">Aucun chauffeur</option>
                {/* Chauffeur actuel inactif (legacy) : affiché tel quel, jamais réécrit sans action. */}
                {t.chauffeur && driverInactive && (
                  <option value={t.chauffeur.id}>
                    {t.chauffeur.firstName} {t.chauffeur.lastName} (inactif)
                  </option>
                )}
                {employees.map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.firstName} {e.lastName}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </div>

        {historyOpen && <VehicleHistory entries={t.history} truncated={t.historyTruncated} />}
      </CardContent>
    </Card>
  )
}
