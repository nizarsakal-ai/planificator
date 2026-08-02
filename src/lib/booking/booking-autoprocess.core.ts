/**
 * Core testable de autoProcessPendingAccommodations (garde N8N/Agent + chemin Gmail).
 * Pas de "use server" — façade dans logement.actions.ts.
 */

import type { PendingAccommodation } from "@prisma/client"
import { isGmailAutoProcessSafe } from "@/lib/booking/booking-pending-identity"
import {
  BOOKING_EMAIL_BODY_PERSIST_MAX,
  BOOKING_SNIPPET_RICH_MIN,
  pickEmailTextForReprocess,
} from "@/lib/booking/booking-pending-merge"
import {
  mergeAiWithRegexFallback,
  tryParseAiBookingContent,
} from "@/lib/booking/extract-booking-fields"

/* Surface injectable — `any` volontaire pour accepter PrismaClient et fakes de tests. */
export type AutoProcessDb = {
  pendingAccommodation: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    findMany: (args?: any) => Promise<PendingAccommodation[]>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    updateMany: (args?: any) => Promise<unknown>
  }
  team: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    findMany: (args?: any) => Promise<Array<{ id: string; name: string }>>
  }
  user: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    findFirst: (args?: any) => Promise<{ id: string } | null>
  }
  accommodation: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    findMany: (args?: any) => Promise<Array<{ teamId: string; address: string | null }>>
  }
  $transaction: (
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    fn: (tx: any) => Promise<unknown>
  ) => Promise<unknown>
}

export type AutoProcessFetchGmailBody = (
  companyId: string,
  messageId: string
) => Promise<{ ok: true; text: string } | { ok: false }>

export type AutoProcessCreateAiMessage = (input: {
  emailText: string
  teamNames: string
  today: string
}) => Promise<{ type: "text"; text: string } | { type: "other" }>

export type AutoProcessPendingAccommodationsDeps = {
  companyId: string
  userId: string
  db: AutoProcessDb
  anthropicApiKey: string | null | undefined
  fetchGmailBody: AutoProcessFetchGmailBody
  createAiMessage: AutoProcessCreateAiMessage
  revalidatePath?: (path: string) => void
}

export type AutoProcessResult =
  | { error: string }
  | {
      success: true
      processed: number
      failed: number
      skippedNonGmail: number
    }

export async function autoProcessPendingAccommodationsCore(
  deps: AutoProcessPendingAccommodationsDeps
): Promise<AutoProcessResult> {
  if (!deps.anthropicApiKey) {
    return { error: "Clé API Anthropic non configurée." }
  }

  const { db, companyId, userId } = deps

  const [pendings, teams, admin] = await Promise.all([
    db.pendingAccommodation.findMany({
      where: { companyId, status: "PENDING" },
      orderBy: { createdAt: "desc" },
    }),
    db.team.findMany({
      where: { companyId, active: true },
      select: { id: true, name: true },
    }),
    db.user.findFirst({
      where: { companyId, role: { in: ["SUPER_ADMIN", "ADMIN"] } },
      select: { id: true },
    }),
  ])

  if (pendings.length === 0) {
    return { success: true, processed: 0, failed: 0, skippedNonGmail: 0 }
  }

  const teamNames = teams.map((t) => t.name).join(", ")
  const today = new Date().toISOString().split("T")[0]

  let processed = 0
  let failed = 0
  let skippedNonGmail = 0

  for (const pending of pendings) {
    if (!isGmailAutoProcessSafe(pending)) {
      skippedNonGmail++
      console.info(
        "[autoProcess] skip non-Gmail pending",
        pending.id,
        pending.sourceKind ?? "(null)"
      )
      continue
    }

    let gmailBody: string | null = null
    const persisted = pending.rawEmailSnippet
    const needsGmail =
      !persisted || persisted.trim().length < BOOKING_SNIPPET_RICH_MIN

    if (needsGmail && pending.gmailMessageId) {
      const fetched = await deps.fetchGmailBody(
        companyId,
        pending.gmailMessageId
      )
      if (fetched.ok) {
        gmailBody = fetched.text
        if (fetched.text.length > (persisted?.length ?? 0)) {
          await db.pendingAccommodation.updateMany({
            where: { id: pending.id, companyId },
            data: {
              rawEmailSnippet: fetched.text.substring(
                0,
                BOOKING_EMAIL_BODY_PERSIST_MAX
              ),
            },
          })
        }
      }
    }

    const chosen = pickEmailTextForReprocess({
      propertyName: pending.propertyName,
      persistedText: pending.rawEmailSnippet,
      gmailBody,
      snippetFallback: pending.rawEmailSnippet,
    })
    const emailText = chosen.text

    if (!emailText.trim()) {
      failed++
      continue
    }

    try {
      const content = await deps.createAiMessage({
        emailText,
        teamNames,
        today,
      })
      if (content.type !== "text") {
        failed++
        continue
      }

      const aiParsed = tryParseAiBookingContent(content)
      const extracted = aiParsed
        ? mergeAiWithRegexFallback(aiParsed, emailText)
        : mergeAiWithRegexFallback(
            {
              propertyName: null,
              address: null,
              city: null,
              zipCode: null,
              startDate: null,
              endDate: null,
              doorCode: null,
              contactName: null,
              contactPhone: null,
              notes: null,
              teamName: null,
            },
            emailText
          )

      const finalAddress =
        pending.address?.trim() || extracted.address?.trim() || null

      await db.pendingAccommodation.updateMany({
        where: { id: pending.id, companyId },
        data: {
          address: finalAddress,
          city: extracted.city?.trim() || pending.city || null,
          zipCode: extracted.zipCode?.trim() || pending.zipCode || null,
          doorCode: extracted.doorCode?.trim() || pending.doorCode || null,
          contactPhone:
            extracted.contactPhone?.trim() || pending.contactPhone || null,
          contactName:
            extracted.contactName?.trim() || pending.contactName || null,
        },
      })

      let teamId: string | null = null
      if (finalAddress) {
        const normalizeAddr = (s: string) =>
          s.toLowerCase().replace(/[^a-z0-9]/g, "")
        const allAcc = await db.accommodation.findMany({
          where: { companyId },
          select: { teamId: true, address: true },
        })
        const addrPrefix = normalizeAddr(finalAddress).substring(0, 10)
        const match = allAcc.find(
          (a) =>
            a.address && normalizeAddr(a.address).includes(addrPrefix)
        )
        if (match) teamId = match.teamId
      }

      if (!teamId) {
        const teamName = extracted.teamName
        if (teamName) {
          const match = teams.find(
            (t) =>
              t.name.toLowerCase() === teamName.toLowerCase() ||
              t.name.toLowerCase().includes(teamName.toLowerCase()) ||
              teamName.toLowerCase().includes(t.name.toLowerCase())
          )
          teamId = match?.id ?? null
        }
      }

      if (
        !teamId ||
        !finalAddress ||
        !pending.startDate ||
        !pending.endDate ||
        !admin
      ) {
        failed++
        continue
      }

      const notesValue =
        [pending.propertyName, pending.notes].filter(Boolean).join(" — ") ||
        null

      await db.$transaction(async (tx) => {
        const created = await tx.accommodation.create({
          data: {
            companyId,
            teamId: teamId!,
            createdById: admin.id,
            startDate: pending.startDate!,
            endDate: pending.endDate!,
            address: finalAddress!,
            city: extracted.city?.trim() || pending.city || null,
            zipCode: extracted.zipCode?.trim() || pending.zipCode || null,
            doorCode: extracted.doorCode?.trim() || pending.doorCode || null,
            contactName:
              extracted.contactName?.trim() || pending.contactName || null,
            contactPhone:
              extracted.contactPhone?.trim() || pending.contactPhone || null,
            notes: notesValue,
            gmailSourceMessageId: pending.gmailMessageId,
            source: "gmail-scan",
          },
        })

        await tx.pendingAccommodation.updateMany({
          where: { id: pending.id, companyId },
          data: {
            status: "CONFIRMED",
            accommodationId: created.id,
            confirmedById: userId,
            confirmedAt: new Date(),
          },
        })
      })

      processed++
    } catch {
      failed++
    }
  }

  deps.revalidatePath?.("/logements")
  deps.revalidatePath?.("/planning/moi")
  return { success: true, processed, failed, skippedNonGmail }
}
