"use client"

import { useState, useTransition } from "react"
import { Bell, ChevronRight, Sparkles, Loader2 } from "lucide-react"
import { toast } from "sonner"
import { PendingBookingsDialog } from "./PendingBookingsDialog"
import { autoProcessPendingAccommodations } from "@/lib/actions/logement.actions"

interface Team { id: string; name: string }

interface PendingAccommodation {
  id:              string
  propertyName:    string | null
  address:         string | null
  city:            string | null
  zipCode:         string | null
  startDate:       Date   | null
  endDate:         Date   | null
  rawEmailSnippet: string | null
}

interface Props {
  pendings: PendingAccommodation[]
  teams:    Team[]
}

export function PendingBookingsBanner({ pendings, teams }: Props) {
  const [dialogOpen, setDialogOpen] = useState(false)
  const [isPending, startTransition] = useTransition()

  if (pendings.length === 0) return null

  function handleAutoProcess() {
    startTransition(async () => {
      const result = await autoProcessPendingAccommodations()
      if ("error" in result) {
        toast.error(result.error)
      } else {
        const { processed, failed } = result
        if (processed > 0) {
          toast.success(`${processed} logement${processed > 1 ? "s" : ""} créé${processed > 1 ? "s" : ""} automatiquement !`)
        }
        if (failed > 0) {
          toast.warning(`${failed} réservation${failed > 1 ? "s" : ""} nécessitent une affectation manuelle.`)
        }
        if (processed === 0 && failed === 0) {
          toast.info("Aucune réservation à traiter.")
        }
      }
    })
  }

  return (
    <>
      <div className="w-full flex items-center gap-3 px-4 py-3 rounded-xl bg-amber-50 border border-amber-200">
        <div className="w-8 h-8 rounded-full bg-amber-200 flex items-center justify-center shrink-0">
          <Bell className="h-4 w-4 text-amber-700" />
        </div>

        <button onClick={() => setDialogOpen(true)} className="flex-1 min-w-0 text-left">
          <p className="text-sm font-semibold text-amber-800">
            {pendings.length} réservation{pendings.length > 1 ? "s" : ""} Booking.com détectée{pendings.length > 1 ? "s" : ""}
          </p>
          <p className="text-xs text-amber-600 mt-0.5">
            Cliquez pour affecter une équipe manuellement
          </p>
        </button>

        {/* Bouton IA */}
        <button
          onClick={handleAutoProcess}
          disabled={isPending}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#0f3460] text-white text-xs font-semibold hover:bg-[#0f3460]/90 transition-colors disabled:opacity-60 shrink-0"
        >
          {isPending ? (
            <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Traitement…</>
          ) : (
            <><Sparkles className="h-3.5 w-3.5" /> Traiter avec l'IA</>
          )}
        </button>

        <ChevronRight
          className="h-4 w-4 text-amber-500 shrink-0 cursor-pointer"
          onClick={() => setDialogOpen(true)}
        />
      </div>

      <PendingBookingsDialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        pendings={pendings}
        teams={teams}
      />
    </>
  )
}
