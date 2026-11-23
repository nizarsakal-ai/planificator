"use server"

import { auth } from "@/auth"
import { prisma } from "@/lib/prisma"
import { isAcquisitionEnabled } from "@/lib/acquisition/acquisition-feature-flag"
import { createAnthropicExtractionClient } from "@/lib/acquisition/extraction/anthropic-extraction.client"
import {
  consultationSummaryConfig, reserveConsultationSummary, summarizeConsultation,
} from "@/lib/acquisition/assistant/consultation-summary"

type SummaryState = { status: "idle" } | { status: "ok"; text: string } | { status: "error"; text: string }

export async function summarizeConsultationAction(
  draftId: string,
  _previous: SummaryState,
  _formData: FormData
): Promise<SummaryState> {
  const session = await auth()
  const user = session?.user
  if (!user?.id || !user.companyId || !["ADMIN", "SUPER_ADMIN"].includes(user.role) || !isAcquisitionEnabled()) {
    return { status: "error", text: "Assistant IA indisponible." }
  }
  const config = consultationSummaryConfig(user.companyId)
  if (!config) return { status: "error", text: "Assistant IA indisponible." }

  try {
    const draft = await prisma.worksiteImportDraft.findFirst({
      where: { id: draftId, companyId: user.companyId },
      select: { acquisitionMessage: { select: { subject: true, content: { select: { normalizedText: true } } } } },
    })
    const message = draft?.acquisitionMessage
    const text = message?.content?.normalizedText?.trim()
    if (!message || !text) return { status: "error", text: "Aucun texte disponible pour ce résumé." }

    const allowed = await reserveConsultationSummary(prisma, {
      companyId: user.companyId, actorId: user.id, draftId, dailyLimit: config.dailyLimit,
    })
    if (!allowed) return { status: "error", text: "La limite quotidienne de résumés a été atteinte." }

    return {
      status: "ok",
      text: await summarizeConsultation({ subject: message.subject, text }, createAnthropicExtractionClient(config.apiKey)),
    }
  } catch {
    return { status: "error", text: "Le résumé est indisponible pour le moment." }
  }
}
