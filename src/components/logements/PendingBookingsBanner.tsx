"use client"

import { useMemo, useState } from "react"
import { Bell, ChevronRight } from "lucide-react"
import { PendingBookingsDialog } from "./PendingBookingsDialog"
import { Badge } from "@/components/ui/badge"
import { isPendingReady } from "@/lib/booking/booking-pending-ready"
import type { PendingAccommodationListItem } from "./pending-accommodation-list.types"

export type { PendingAccommodationListItem } from "./pending-accommodation-list.types"
export { isPendingReady } from "@/lib/booking/booking-pending-ready"

interface Team {
  id: string
  name: string
}

interface Props {
  pendings: PendingAccommodationListItem[]
  teams: Team[]
}

export type PendingReadyFilter = "all" | "ready" | "incomplete"

export function PendingBookingsBanner({ pendings, teams }: Props) {
  const [dialogOpen, setDialogOpen] = useState(false)
  const [filter, setFilter] = useState<PendingReadyFilter>("all")

  const filtered = useMemo(() => {
    if (filter === "ready") return pendings.filter(isPendingReady)
    if (filter === "incomplete") return pendings.filter((p) => !isPendingReady(p))
    return pendings
  }, [pendings, filter])

  if (pendings.length === 0) return null

  const readyCount = pendings.filter(isPendingReady).length
  const incompleteCount = pendings.length - readyCount

  return (
    <>
      <div className="w-full space-y-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3">
        <div className="flex items-center gap-3">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-amber-200">
            <Bell className="h-4 w-4 text-amber-700" />
          </div>

          <button
            type="button"
            onClick={() => setDialogOpen(true)}
            className="min-w-0 flex-1 text-left"
          >
            <p className="text-sm font-semibold text-amber-800">
              Logements Booking à valider ({pendings.length})
            </p>
            <p className="mt-0.5 text-xs text-amber-600">
              {readyCount} prêt{readyCount > 1 ? "s" : ""} · {incompleteCount} incomplet
              {incompleteCount > 1 ? "s" : ""} — revue humaine requise
            </p>
          </button>

          <ChevronRight
            className="h-4 w-4 shrink-0 cursor-pointer text-amber-500"
            onClick={() => setDialogOpen(true)}
          />
        </div>

        <div className="flex flex-wrap gap-2">
          {(
            [
              { id: "all" as const, label: "Tous", count: pendings.length },
              { id: "ready" as const, label: "Prêts", count: readyCount },
              { id: "incomplete" as const, label: "Incomplets", count: incompleteCount },
            ] as const
          ).map((f) => (
            <button
              key={f.id}
              type="button"
              onClick={() => setFilter(f.id)}
              className={`inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-medium transition-colors ${
                filter === f.id
                  ? "border-[#0f3460] bg-[#0f3460] text-white"
                  : "border-amber-200 bg-white text-amber-800 hover:bg-amber-100"
              }`}
            >
              {f.label}
              <Badge
                variant="secondary"
                className={`h-5 px-1.5 text-[10px] ${
                  filter === f.id ? "bg-white/20 text-white" : ""
                }`}
              >
                {f.count}
              </Badge>
            </button>
          ))}
          <button
            type="button"
            onClick={() => setDialogOpen(true)}
            className="ml-auto text-xs font-semibold text-[#0f3460] hover:underline"
          >
            Ouvrir la revue
          </button>
        </div>
      </div>

      <PendingBookingsDialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        pendings={filtered}
        teams={teams}
        filterLabel={
          filter === "ready" ? "Prêts" : filter === "incomplete" ? "Incomplets" : "Tous"
        }
      />
    </>
  )
}
