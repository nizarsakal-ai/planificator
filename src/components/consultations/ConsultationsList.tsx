"use client"

import Link from "next/link"
import { useRouter, useSearchParams } from "next/navigation"
import type { WorksiteImportDraftStatus } from "@prisma/client"
import type { ImportDraftListItem } from "@/lib/acquisition/review/import-draft-review.types"
import {
  CONSULTATION_STATUS_BADGE_CLASS,
  CONSULTATION_STATUS_LABELS,
  truncateSubject,
} from "@/lib/acquisition/review/consultation-ui"
import { REVIEW_STATUSES } from "@/lib/acquisition/review/import-draft-review.schema"
import { cn } from "@/lib/utils"

function fmt(d: Date | string) {
  return new Intl.DateTimeFormat("fr-FR", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(d))
}

export function ConsultationsList({
  items,
  currentStatus,
}: {
  items: ImportDraftListItem[]
  currentStatus: string | null
}) {
  const router = useRouter()
  const searchParams = useSearchParams()

  function onFilterChange(value: string) {
    const params = new URLSearchParams(searchParams.toString())
    if (!value || value === "ALL") params.delete("status")
    else params.set("status", value)
    const q = params.toString()
    router.push(q ? `/consultations?${q}` : "/consultations")
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <label className="text-sm text-muted-foreground" htmlFor="status-filter">
          Statut
        </label>
        <select
          id="status-filter"
          className="h-9 rounded-md border bg-background px-3 text-sm"
          value={currentStatus ?? "ALL"}
          onChange={(e) => onFilterChange(e.target.value)}
        >
          <option value="ALL">Tous</option>
          {REVIEW_STATUSES.map((s) => (
            <option key={s} value={s}>
              {CONSULTATION_STATUS_LABELS[s]}
            </option>
          ))}
        </select>
        <span className="text-xs text-muted-foreground">{items.length} résultat(s) · max 50</span>
      </div>

      {items.length === 0 ? (
        <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
          Aucune consultation
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-left text-xs uppercase text-muted-foreground">
              <tr>
                <th className="px-3 py-2 font-medium">Sujet</th>
                <th className="px-3 py-2 font-medium">Expéditeur</th>
                <th className="px-3 py-2 font-medium">Reçu</th>
                <th className="px-3 py-2 font-medium">Chantier</th>
                <th className="px-3 py-2 font-medium">Statut</th>
                <th className="px-3 py-2 font-medium">Mis à jour</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => {
                const status = item.status as WorksiteImportDraftStatus
                return (
                  <tr key={item.draftId} className="border-t hover:bg-muted/30">
                    <td className="px-3 py-2">
                      <Link
                        href={`/consultations/${item.draftId}`}
                        className="font-medium text-foreground underline-offset-2 hover:underline"
                      >
                        {truncateSubject(item.message.subject)}
                      </Link>
                      {status === "FAILED" && item.lastExtractionErrorCode ? (
                        <div className="mt-0.5 text-xs text-red-700">
                          {item.lastExtractionErrorCode}
                        </div>
                      ) : null}
                    </td>
                    <td className="px-3 py-2 text-muted-foreground">{item.message.senderEmail}</td>
                    <td className="px-3 py-2 whitespace-nowrap">{fmt(item.message.receivedAt)}</td>
                    <td className="px-3 py-2">{item.proposedWorksiteName ?? "—"}</td>
                    <td className="px-3 py-2">
                      <span
                        className={cn(
                          "inline-flex rounded-full px-2 py-0.5 text-xs font-medium",
                          CONSULTATION_STATUS_BADGE_CLASS[status]
                        )}
                      >
                        {CONSULTATION_STATUS_LABELS[status]}
                      </span>
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap">{fmt(item.updatedAt)}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
