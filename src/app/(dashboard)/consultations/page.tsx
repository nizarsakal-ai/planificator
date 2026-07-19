import type { Metadata } from "next"
import { Suspense } from "react"
import { auth } from "@/auth"
import { redirect } from "next/navigation"
import type { WorksiteImportDraftStatus } from "@prisma/client"
import { isAcquisitionEnabled } from "@/lib/acquisition/acquisition-feature-flag"
import { importDraftReadRepository } from "@/lib/acquisition/review/import-draft-read.repository"
import { reviewStatusFilterSchema } from "@/lib/acquisition/review/import-draft-review.schema"
import { ConsultationsList } from "@/components/consultations/ConsultationsList"
import { Card, CardContent } from "@/components/ui/card"

export const metadata: Metadata = { title: "Consultations" }

export default async function ConsultationsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>
}) {
  const session = await auth()
  if (!session?.user) redirect("/login")
  if (!["ADMIN", "SUPER_ADMIN"].includes(session.user.role) || !session.user.companyId) {
    redirect("/dashboard")
  }

  if (!isAcquisitionEnabled()) {
    return (
      <div className="space-y-4 p-6">
        <h1 className="text-2xl font-semibold">Consultations</h1>
        <Card>
          <CardContent className="p-6 text-sm text-muted-foreground">
            Le module Acquisition est désactivé.
          </CardContent>
        </Card>
      </div>
    )
  }

  const sp = await searchParams
  const statusParse = sp.status ? reviewStatusFilterSchema.safeParse(sp.status) : null
  const statusFilter = statusParse?.success
    ? (statusParse.data as WorksiteImportDraftStatus)
    : undefined

  const items = await importDraftReadRepository.listImportDraftsForReview({
    companyId: session.user.companyId,
    status: statusFilter,
    limit: 50,
  })

  return (
    <div className="space-y-4 p-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Consultations</h1>
        <p className="text-sm text-muted-foreground">
          Revue humaine des brouillons d’import chantier (emails @lauralu.fr).
        </p>
      </div>
      <Suspense fallback={<div className="text-sm text-muted-foreground">Chargement…</div>}>
        <ConsultationsList
          items={items}
          currentStatus={statusFilter ?? null}
        />
      </Suspense>
    </div>
  )
}
