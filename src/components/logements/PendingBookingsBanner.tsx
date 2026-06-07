"use client"

import { useState } from "react"
import { Bell, ChevronRight } from "lucide-react"
import { PendingBookingsDialog } from "./PendingBookingsDialog"

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

  if (pendings.length === 0) return null

  return (
    <>
      <button
        onClick={() => setDialogOpen(true)}
        className="w-full flex items-center gap-3 px-4 py-3 rounded-xl bg-amber-50 border border-amber-200 hover:bg-amber-100 transition-colors text-left"
      >
        <div className="w-8 h-8 rounded-full bg-amber-200 flex items-center justify-center shrink-0">
          <Bell className="h-4 w-4 text-amber-700" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold text-amber-800">
            {pendings.length} réservation{pendings.length > 1 ? "s" : ""} Booking.com détectée{pendings.length > 1 ? "s" : ""}
          </p>
          <p className="text-xs text-amber-600 mt-0.5">
            Cliquez pour affecter une équipe
          </p>
        </div>
        <ChevronRight className="h-4 w-4 text-amber-500 shrink-0" />
      </button>

      <PendingBookingsDialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        pendings={pendings}
        teams={teams}
      />
    </>
  )
}
