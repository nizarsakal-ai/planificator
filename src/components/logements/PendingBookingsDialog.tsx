"use client"

import { useState, useTransition } from "react"
import { CalendarDays, MapPin, CheckCircle, X, Loader2, BedDouble, AlertTriangle } from "lucide-react"
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { confirmPendingAccommodation, dismissPendingAccommodation } from "@/lib/actions/gmail.actions"
import { toast } from "sonner"

interface Team { id: string; name: string }

interface PendingAccommodation {
  id:              string
  propertyName:    string | null
  address:         string | null
  city:            string | null
  zipCode:         string | null
  startDate:       Date   | null
  endDate:         Date   | null
  /** Aperçu UI borné (≤500) — jamais le corps complet. */
  emailPreview:    string | null
}

interface Props {
  open:     boolean
  onClose:  () => void
  pendings: PendingAccommodation[]
  teams:    Team[]
}

function fmtDate(d: Date | null) {
  if (!d) return "?"
  return new Intl.DateTimeFormat("fr-FR", { day: "2-digit", month: "short", year: "numeric" }).format(new Date(d))
}

export function PendingBookingsDialog({ open, onClose, pendings, teams }: Props) {
  const [teamSelections, setTeamSelections] = useState<Record<string, string>>({})
  const [addressOverrides, setAddressOverrides] = useState<Record<string, string>>({})
  const [dismissed, setDismissed]           = useState<Set<string>>(new Set())
  const [confirmed, setConfirmed]           = useState<Set<string>>(new Set())
  const [isPending, startTransition]        = useTransition()

  const visible = pendings.filter((p) => !dismissed.has(p.id) && !confirmed.has(p.id))

  function effectiveAddress(p: PendingAccommodation): string {
    return (p.address?.trim() || addressOverrides[p.id]?.trim() || "")
  }

  function handleConfirm(id: string) {
    const teamId = teamSelections[id]
    if (!teamId) {
      toast.error("Sélectionnez une équipe d'abord.")
      return
    }
    const pending = visible.find((p) => p.id === id)
    if (!pending) return
    const override = addressOverrides[id]?.trim() || undefined
    if (!pending.address?.trim() && !override) {
      toast.error("Adresse manquante — saisissez l'adresse du logement (fallback exceptionnel).")
      return
    }
    startTransition(async () => {
      const res = await confirmPendingAccommodation(id, teamId, override)
      if ("error" in res) {
        toast.error(res.error)
      } else {
        toast.success(
          res.idempotent
            ? "Logement déjà confirmé."
            : "Logement créé et équipe notifiée."
        )
        setConfirmed((prev) => new Set([...prev, id]))
      }
    })
  }

  function handleDismiss(id: string) {
    startTransition(async () => {
      const res = await dismissPendingAccommodation(id)
      if (res.error) {
        toast.error(res.error)
      } else {
        setDismissed((prev) => new Set([...prev, id]))
      }
    })
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-lg max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <BedDouble className="h-4 w-4 text-amber-500" />
            Réservations détectées ({visible.length})
          </DialogTitle>
        </DialogHeader>

        {visible.length === 0 ? (
          <div className="py-8 text-center text-sm text-slate-400">
            Toutes les réservations ont été traitées.
          </div>
        ) : (
          <div className="space-y-4">
            {visible.map((p) => {
              const hasExtractedAddress = Boolean(p.address?.trim())
              const canAssign = Boolean(teamSelections[p.id] && effectiveAddress(p))
              return (
              <div key={p.id} className="border border-slate-100 rounded-xl p-4 space-y-3 bg-slate-50">
                {/* Nom + dates */}
                <div className="flex items-start justify-between gap-2">
                  <div className="font-medium text-sm text-slate-800 leading-tight">
                    {p.propertyName ?? "Logement Booking.com"}
                  </div>
                  <Badge variant="secondary" className="text-xs shrink-0">Nouveau</Badge>
                </div>

                {(p.startDate || p.endDate) && (
                  <div className="flex items-center gap-1.5 text-xs text-slate-500">
                    <CalendarDays className="h-3.5 w-3.5 shrink-0" />
                    {fmtDate(p.startDate)} → {fmtDate(p.endDate)}
                  </div>
                )}

                {hasExtractedAddress ? (
                  <div className="flex items-start gap-1.5 text-xs text-slate-500">
                    <MapPin className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                    <span>{p.address}{p.city ? `, ${p.city}` : ""}{p.zipCode ? ` ${p.zipCode}` : ""}</span>
                  </div>
                ) : (
                  <div className="space-y-2">
                    <div className="flex items-start gap-1.5 text-xs text-amber-700 bg-amber-50 border border-amber-100 rounded-md px-2 py-1.5">
                      <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                      <span>
                        Adresse non extraite automatiquement. Saisie manuelle exceptionnelle requise avant affectation.
                      </span>
                    </div>
                    <label className="block text-xs text-slate-600">
                      Adresse du logement
                      <input
                        type="text"
                        value={addressOverrides[p.id] ?? ""}
                        onChange={(e) =>
                          setAddressOverrides((prev) => ({ ...prev, [p.id]: e.target.value }))
                        }
                        placeholder="Ex. 12 rue de la Paix, 75002 Paris"
                        className="mt-1 w-full h-8 rounded-md border border-slate-200 bg-white px-2 text-xs text-slate-700 focus:outline-none focus:ring-1 focus:ring-[#0f3460]"
                        autoComplete="street-address"
                      />
                    </label>
                  </div>
                )}

                {p.emailPreview && (
                  <p className="text-xs text-slate-400 italic line-clamp-2 bg-white px-2 py-1.5 rounded border border-slate-100">
                    {p.emailPreview}
                  </p>
                )}

                {/* Sélection équipe */}
                <select
                  value={teamSelections[p.id] ?? ""}
                  onChange={(e) => setTeamSelections((prev) => ({ ...prev, [p.id]: e.target.value }))}
                  className="w-full h-8 rounded-md border border-slate-200 bg-white px-2 text-xs text-slate-700 focus:outline-none focus:ring-1 focus:ring-[#0f3460]"
                >
                  <option value="" disabled>Choisir une équipe…</option>
                  {teams.map((t) => (
                    <option key={t.id} value={t.id}>{t.name}</option>
                  ))}
                </select>

                {/* Actions */}
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    className="flex-1 h-8 bg-[#0f3460] hover:bg-[#0f3460]/90 text-xs"
                    onClick={() => handleConfirm(p.id)}
                    disabled={isPending || !canAssign}
                  >
                    {isPending
                      ? <Loader2 className="h-3 w-3 animate-spin" />
                      : <><CheckCircle className="h-3 w-3 mr-1" /> Affecter</>}
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-8 text-xs text-slate-500"
                    onClick={() => handleDismiss(p.id)}
                    disabled={isPending}
                  >
                    <X className="h-3 w-3" />
                  </Button>
                </div>
              </div>
              )
            })}
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
