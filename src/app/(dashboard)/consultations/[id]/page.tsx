import type { Metadata } from "next"
import { auth } from "@/auth"
import { notFound, redirect } from "next/navigation"
import { prisma } from "@/lib/prisma"
import { isAcquisitionEnabled } from "@/lib/acquisition/acquisition-feature-flag"
import { isAcquisitionExtractionEnabled } from "@/lib/acquisition/extraction/extraction-feature-flag"
import { isAcquisitionConversionFullyEnabled } from "@/lib/acquisition/conversion/conversion-feature-flag"
import { importDraftReadRepository } from "@/lib/acquisition/review/import-draft-read.repository"
import { ConsultationDetail } from "@/components/consultations/ConsultationDetail"
import { Card, CardContent } from "@/components/ui/card"

export const metadata: Metadata = { title: "Consultation" }

/**
 * PLAN-ACQ-MULTIMODAL — les Server Actions de la page (relance d'extraction :
 * récupération contenu + PJ + provider vision) héritent de cette durée.
 * Aligné sur les routes cron Acquisition (300 s). L'action s'impose une échéance
 * interne plus courte (RELAUNCH_DEADLINE_MS) pour toujours libérer le brouillon.
 */
export const maxDuration = 300

export default async function ConsultationDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const session = await auth()
  if (!session?.user) redirect("/login")
  if (!["ADMIN", "SUPER_ADMIN"].includes(session.user.role) || !session.user.companyId) {
    redirect("/dashboard")
  }

  const { id } = await params

  if (!isAcquisitionEnabled()) {
    return (
      <div className="space-y-4 p-6">
        <h1 className="text-2xl font-semibold">Consultation</h1>
        <Card>
          <CardContent className="p-6 text-sm text-muted-foreground">
            Le module Acquisition est désactivé.
          </CardContent>
        </Card>
      </div>
    )
  }

  const bundle = await importDraftReadRepository.getImportDraftReviewBundle({
    companyId: session.user.companyId,
    draftId: id,
  })
  if (!bundle) notFound()

  const clients =
    ["PENDING_REVIEW", "FAILED", "APPROVED", "CONVERTED"].includes(bundle.draft.status)
      ? await prisma.client.findMany({
          where: { companyId: session.user.companyId, active: true },
          select: { id: true, name: true },
          orderBy: { name: "asc" },
          take: 200,
        })
      : []

  return (
    <div className="p-6">
      <ConsultationDetail
        bundle={bundle}
        extractionEnabled={isAcquisitionExtractionEnabled()}
        conversionEnabled={isAcquisitionConversionFullyEnabled()}
        clients={clients}
      />
    </div>
  )
}
