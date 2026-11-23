"use server"

import { APIError } from "@anthropic-ai/sdk"
import { auth } from "@/auth"
import { prisma } from "@/lib/prisma"
import { isAcquisitionEnabled } from "@/lib/acquisition/acquisition-feature-flag"
import { createAnthropicExtractionClient, mapAnthropicSdkError } from "@/lib/acquisition/extraction/anthropic-extraction.client"
import {
  consultationSummaryConfig, ConsultationSummaryEmptyError, reserveConsultationSummary, summarizeConsultation,
} from "@/lib/acquisition/assistant/consultation-summary"

type SummaryState = { status: "idle" } | { status: "ok"; text: string } | { status: "error"; text: string }

export async function summarizeConsultationAction(
  draftId: string | null,
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

  let phase: "lecture" | "quota" | "model" = "lecture"
  try {
    let input = {
      subject: "Demande de devis fictive",
      text: "Pour un événement fictif à Lyon le 15 juin 2027, prévoir deux tentes de 25 m² et 40 chaises. Les horaires de montage restent à confirmer.",
    }
    if (draftId !== null) {
      const draft = await prisma.worksiteImportDraft.findFirst({
        where: { id: draftId, companyId: user.companyId },
        select: { acquisitionMessage: { select: { subject: true, content: { select: { normalizedText: true } } } } },
      })
      const message = draft?.acquisitionMessage
      const text = message?.content?.normalizedText?.trim()
      if (!message || !text) return { status: "error", text: "Aucun texte disponible pour ce résumé." }
      input = { subject: message.subject, text }
    }

    phase = "quota"
    const allowed = await reserveConsultationSummary(prisma, {
      companyId: user.companyId, actorId: user.id, draftId, dailyLimit: config.dailyLimit,
    })
    if (!allowed) return { status: "error", text: "La limite quotidienne de résumés a été atteinte." }

    phase = "model"
    return {
      status: "ok",
      text: await summarizeConsultation(input, createAnthropicExtractionClient(config.apiKey)),
    }
  } catch (error) {
    const code = phase !== "model" ? "PERSISTENCE"
      : error instanceof ConsultationSummaryEmptyError ? error.causeCode
      : mapAnthropicSdkError(error).kind
    console.warn("consultation_ai_summary_failed", {
      phase,
      code,
      ...(phase === "model" && error instanceof APIError && typeof error.status === "number"
        ? { status: error.status }
        : {}),
    })
    return { status: "error", text: "Le résumé est indisponible pour le moment." }
  }
}
