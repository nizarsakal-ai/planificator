/**
 * Handler testable POST /api/booking/agent (deps injectables).
 * La route Next reste un wrapper fin.
 */

import { NextResponse } from "next/server"
import Anthropic from "@anthropic-ai/sdk"
import { z } from "zod"
import { assertCronBearerAuth } from "@/lib/cron/assert-cron-bearer-auth"
import {
  PENDING_SOURCE_KIND,
  resolveAgentPendingIdentity,
  zodUtf8MaxNullish,
  BOOKING_REFERENCE_MAX_BYTES,
  EXTERNAL_SOURCE_ID_MAX_BYTES,
} from "@/lib/booking/booking-pending-identity"

async function withRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn()
    } catch (err) {
      if (i === attempts - 1) throw err
      await new Promise((r) => setTimeout(r, 1000 * (i + 1)))
    }
  }
  throw new Error("unreachable")
}

export const AgentSchema = z.object({
  companyId: z.string().min(1),
  rawEmailText: z.string().min(1),
  bookingReference: zodUtf8MaxNullish(
    BOOKING_REFERENCE_MAX_BYTES,
    "bookingReference"
  ),
  externalEventId: zodUtf8MaxNullish(
    EXTERNAL_SOURCE_ID_MAX_BYTES,
    "externalEventId"
  ),
  status: z.enum(["confirmed", "modified", "cancelled"]).optional(),
})

/** Surface Prisma minimale pour le handler Agent (fakes + PrismaClient). */
export type BookingAgentDb = {
  company: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    findUnique: (args?: any) => Promise<{ id: string } | null>
  }
  team: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    findMany: (args?: any) => Promise<Array<{ id: string; name: string }>>
  }
  user: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    findFirst: (args?: any) => Promise<{ id: string } | null>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    findMany: (args?: any) => Promise<Array<{ id: string }>>
  }
  accommodation: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    findUnique: (args?: any) => Promise<{ id: string; companyId: string } | null>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    findMany: (args?: any) => Promise<Array<{ teamId: string; address: string | null }>>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    update: (args?: any) => Promise<unknown>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    upsert: (args?: any) => Promise<{ id: string }>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    create: (args?: any) => Promise<{ id: string }>
  }
  pendingAccommodation: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    findUnique: (args?: any) => Promise<{ id: string } | null>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    update: (args?: any) => Promise<{ id: string }>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    create: (args?: any) => Promise<{ id: string }>
  }
  notification: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    createMany: (args?: any) => Promise<unknown>
  }
}

export type BookingAgentExtractFn = (input: {
  rawEmailText: string
  teamNames: string
  today: string
}) => Promise<Record<string, string | null>>

export type BookingAgentHandlerDeps = {
  db: BookingAgentDb
  /** Injecté en tests ; défaut = Anthropic si clé présente. */
  extractFromEmail?: BookingAgentExtractFn
  anthropicApiKey?: string | null
}

async function defaultExtract(
  input: { rawEmailText: string; teamNames: string; today: string },
  apiKey: string
): Promise<Record<string, string | null>> {
  const client = new Anthropic({ apiKey })
  const msg = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 1024,
    system: `Tu analyses un email de réservation Booking.com et extrais toutes les informations.
Équipes disponibles dans Planificator: ${input.teamNames || "aucune"}
Aujourd'hui: ${input.today}

Réponds UNIQUEMENT en JSON valide, sans markdown, sans explication.
Format attendu (toutes les valeurs peuvent être null si introuvables):
{
  "status": "confirmed|cancelled|modified",
  "propertyName": "nom complet de l'établissement",
  "address": "adresse complète avec numéro et rue",
  "city": "ville",
  "zipCode": "code postal",
  "startDate": "YYYY-MM-DD",
  "endDate": "YYYY-MM-DD",
  "teamName": "nom d'une des équipes disponibles si mentionnée comme réservant",
  "doorCode": "code porte ou accès",
  "contactName": "nom du propriétaire ou hôte",
  "contactPhone": "téléphone",
  "bookingReference": "numéro de réservation Booking.com"
}`,
    messages: [{ role: "user", content: input.rawEmailText.substring(0, 4000) }],
  })
  const content = msg.content[0]
  if (content.type !== "text") return {}
  const cleaned = content.text
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/, "")
    .trim()
  return JSON.parse(cleaned) as Record<string, string | null>
}

async function notifyAdmins(
  db: BookingAgentDb,
  companyId: string,
  title: string,
  message: string,
  link: string
) {
  const admins = await db.user.findMany({
    where: { companyId, role: { in: ["ADMIN", "SUPER_ADMIN"] } },
    select: { id: true },
  })
  if (!admins.length) return
  await db.notification.createMany({
    data: admins.map((a) => ({
      userId: a.id,
      companyId,
      type: "BOOKING_DETECTED" as const,
      title,
      message,
      link,
    })),
  })
}

/**
 * Handler POST réel (auth + métier). Invocable depuis la route et les tests.
 */
export async function handleBookingAgentPost(
  req: Request,
  deps: BookingAgentHandlerDeps
): Promise<Response> {
  const unauthorized = assertCronBearerAuth(req)
  if (unauthorized) return unauthorized

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 })
  }

  const parsed = AgentSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Validation failed", details: parsed.error.flatten() },
      { status: 422 }
    )
  }

  const {
    companyId,
    rawEmailText,
    bookingReference,
    externalEventId,
    status,
  } = parsed.data
  const db = deps.db

  const company = await withRetry(() =>
    db.company.findUnique({ where: { id: companyId }, select: { id: true } })
  )
  if (!company) {
    return NextResponse.json({ error: "Company not found" }, { status: 404 })
  }

  const [teams, admin] = await withRetry(() =>
    Promise.all([
      db.team.findMany({
        where: { companyId, active: true },
        select: { id: true, name: true },
      }),
      db.user.findFirst({
        where: { companyId, role: { in: ["SUPER_ADMIN", "ADMIN"] } },
        select: { id: true },
      }),
    ])
  )

  const teamNames = teams.map((t) => t.name).join(", ")
  const today = new Date().toISOString().split("T")[0]
  let extracted: Record<string, string | null> = {}

  const extract = deps.extractFromEmail
  const apiKey =
    deps.anthropicApiKey === undefined
      ? process.env.ANTHROPIC_API_KEY
      : deps.anthropicApiKey

  if (extract) {
    extracted = await extract({ rawEmailText, teamNames, today })
  } else if (apiKey) {
    try {
      extracted = await defaultExtract(
        { rawEmailText, teamNames, today },
        apiKey
      )
    } catch (err) {
      console.error("[booking/agent] Claude error:", err)
    }
  }

  const finalStatus = (extracted.status as string) || status || "confirmed"
  const finalRef =
    bookingReference || (extracted.bookingReference as string) || null
  const finalAddress = (extracted.address as string) || null
  const propertyName = (extracted.propertyName as string) || null

  /**
   * Identité stable avant toute écriture métier (cancel / Acc / Pending).
   * Accommodation n’a pas de colonne d’idempotence Agent pour externalEventId :
   * auto-création Acc uniquement si bookingReference contractuelle
   * (clé tenant-safe companyId+bookingReference). Sinon → Pending agent:{id}.
   */
  const identity = resolveAgentPendingIdentity({
    bookingReference: finalRef,
    externalEventId,
  })

  if (finalStatus === "cancelled" && finalRef) {
    if (!identity.ok) {
      return NextResponse.json({ error: identity.error }, { status: 422 })
    }
    const existing = await db.accommodation.findUnique({
      where: {
        companyId_bookingReference: {
          companyId,
          bookingReference: finalRef,
        },
      },
      select: { id: true, companyId: true },
    })
    if (existing && existing.companyId === companyId) {
      await db.accommodation.update({
        where: { id: existing.id },
        data: { status: "CANCELLED" },
      })
      await notifyAdmins(
        db,
        companyId,
        "Réservation annulée (IA)",
        `Booking #${finalRef} annulée automatiquement.`,
        "/logements"
      )
      return NextResponse.json({
        ok: true,
        action: "cancelled",
        id: existing.id,
      })
    }
  }

  if (finalStatus !== "confirmed" && finalStatus !== "modified") {
    return NextResponse.json({
      ok: true,
      action: "skipped",
      reason: "not confirmed",
    })
  }
  if (!extracted.startDate) {
    return NextResponse.json({
      ok: true,
      action: "skipped",
      reason: "no start date found",
    })
  }
  if (extracted.endDate) {
    const endDate = new Date(extracted.endDate as string)
    const cutoffDate = new Date("2026-06-17")
    cutoffDate.setHours(0, 0, 0, 0)
    if (endDate < cutoffDate) {
      return NextResponse.json({
        ok: true,
        action: "skipped",
        reason: "reservation ended before cutoff",
      })
    }
  }

  // Toute suite peut écrire Acc ou Pending → identité obligatoire.
  if (!identity.ok) {
    return NextResponse.json({ error: identity.error }, { status: 422 })
  }

  let matchedTeamId: string | null = null
  if (finalAddress) {
    const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "")
    const prefix = normalize(finalAddress).substring(0, 10)
    const pastAcc = await db.accommodation.findMany({
      where: { companyId },
      select: { teamId: true, address: true },
    })
    const match = pastAcc.find(
      (a) => a.address && normalize(a.address).includes(prefix)
    )
    if (match) matchedTeamId = match.teamId
  }
  if (!matchedTeamId) {
    const teamName = extracted.teamName as string | null
    if (teamName) {
      const match = teams.find(
        (t) =>
          t.name.toLowerCase() === teamName.toLowerCase() ||
          t.name.toLowerCase().includes(teamName.toLowerCase()) ||
          teamName.toLowerCase().includes(t.name.toLowerCase())
      )
      matchedTeamId = match?.id ?? null
    }
  }

  const hasAllData =
    matchedTeamId &&
    admin &&
    finalAddress &&
    extracted.startDate &&
    extracted.endDate

  // Auto-création Acc idempotente uniquement via (companyId, bookingReference).
  // externalEventId seul : pas de colonne durable sur Accommodation → Pending.
  if (hasAllData && finalRef) {
    const accData = {
      companyId,
      teamId: matchedTeamId!,
      createdById: admin!.id,
      bookingReference: finalRef,
      gmailSourceMessageId: null as string | null,
      source: "agent",
      address: finalAddress!,
      city: (extracted.city as string) || null,
      zipCode: (extracted.zipCode as string) || null,
      startDate: new Date(extracted.startDate as string),
      endDate: new Date(extracted.endDate as string),
      doorCode: (extracted.doorCode as string) || null,
      contactName: (extracted.contactName as string) || null,
      contactPhone: (extracted.contactPhone as string) || null,
      notes: propertyName,
      status: "UPCOMING" as const,
    }

    const result = await db.accommodation.upsert({
      where: {
        companyId_bookingReference: {
          companyId,
          bookingReference: finalRef,
        },
      },
      create: accData,
      update: {
        teamId: accData.teamId,
        address: accData.address,
        city: accData.city,
        zipCode: accData.zipCode,
        startDate: accData.startDate,
        endDate: accData.endDate,
        doorCode: accData.doorCode,
        contactName: accData.contactName,
        contactPhone: accData.contactPhone,
        notes: accData.notes,
        source: "agent",
        gmailSourceMessageId: null,
      },
    })

    const teamLabel = teams.find((t) => t.id === matchedTeamId)?.name ?? ""
    await notifyAdmins(
      db,
      companyId,
      "✅ Logement créé automatiquement",
      `${propertyName || finalAddress} — Équipe ${teamLabel}.`,
      "/logements"
    )
    return NextResponse.json({ ok: true, action: "created", id: result.id })
  }

  const pendingData = {
    propertyName,
    address: finalAddress,
    city: (extracted.city as string) || null,
    zipCode: (extracted.zipCode as string) || null,
    startDate: extracted.startDate
      ? new Date(extracted.startDate as string)
      : null,
    endDate: extracted.endDate
      ? new Date(extracted.endDate as string)
      : null,
    doorCode: (extracted.doorCode as string) || null,
    contactName: (extracted.contactName as string) || null,
    contactPhone: (extracted.contactPhone as string) || null,
    rawEmailSnippet: rawEmailText.substring(0, 500),
  }

  const existingPending = await db.pendingAccommodation.findUnique({
    where: {
      companyId_idempotencyKey: {
        companyId,
        idempotencyKey: identity.idempotencyKey,
      },
    },
    select: { id: true },
  })

  const pending = existingPending
    ? await db.pendingAccommodation.update({
        where: { id: existingPending.id },
        data: pendingData,
      })
    : await db.pendingAccommodation.create({
        data: {
          companyId,
          gmailMessageId: null,
          idempotencyKey: identity.idempotencyKey,
          sourceKind: PENDING_SOURCE_KIND.AGENT,
          externalSourceId: identity.externalSourceId,
          ...pendingData,
        },
      })

  const reason = hasAllData
    ? "auto-création Accommodation refusée sans bookingReference (externalEventId non persistable sur Accommodation)"
    : !matchedTeamId
      ? "équipe non identifiée"
      : "adresse introuvable"
  await notifyAdmins(
    db,
    companyId,
    `⚠️ Réservation en attente (${reason})`,
    `${propertyName || "Logement"} — Affectation manuelle requise.`,
    "/logements"
  )

  return NextResponse.json({
    ok: true,
    action: "pending",
    id: pending.id,
    reason,
  })
}
