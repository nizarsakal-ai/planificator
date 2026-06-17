import { NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import Anthropic from "@anthropic-ai/sdk"
import { z } from "zod"

const AgentSchema = z.object({
  companyId:        z.string().min(1),
  rawEmailText:     z.string().min(1),
  bookingReference: z.string().optional().nullable(),
  status:           z.enum(["confirmed", "modified", "cancelled"]).optional(),
})

export async function POST(req: Request) {
  const authHeader = req.headers.get("authorization")
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  let body: unknown
  try { body = await req.json() }
  catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }) }

  const parsed = AgentSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: "Validation failed", details: parsed.error.flatten() }, { status: 422 })
  }

  const { companyId, rawEmailText, bookingReference, status } = parsed.data

  const company = await prisma.company.findUnique({ where: { id: companyId }, select: { id: true } })
  if (!company) return NextResponse.json({ error: "Company not found" }, { status: 404 })

  const [teams, admin] = await Promise.all([
    prisma.team.findMany({
      where: { companyId, active: true },
      select: { id: true, name: true },
    }),
    prisma.user.findFirst({
      where: { companyId, role: { in: ["SUPER_ADMIN", "ADMIN"] } },
      select: { id: true },
    }),
  ])

  // ── Agent IA : extraction intelligente ─────────────────────────────────────
  const teamNames = teams.map((t) => t.name).join(", ")
  const today = new Date().toISOString().split("T")[0]

  let extracted: Record<string, string | null> = {}

  if (process.env.ANTHROPIC_API_KEY) {
    try {
      const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

      const msg = await client.messages.create({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 1024,
        system: `Tu analyses un email de réservation Booking.com et extrais toutes les informations.
Équipes disponibles dans Planificator: ${teamNames || "aucune"}
Aujourd'hui: ${today}

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
}

Instructions importantes:
- Pour teamName: cherche un prénom ou nom dans l'email qui correspond exactement à une des équipes disponibles
- Pour status: "cancelled" si annulation, "modified" si modification, sinon "confirmed"
- Pour address: extrais l'adresse physique du logement (pas celle de l'entreprise)
- Pour les dates: cherche "du XX au XX", "check-in", "arrivée", "départ"`,
        messages: [{ role: "user", content: rawEmailText.substring(0, 4000) }],
      })

      const content = msg.content[0]
      if (content.type === "text") {
        extracted = JSON.parse(content.text)
      }
    } catch (err) {
      console.error("[booking/agent] Claude error:", err)
    }
  }

  const finalStatus   = (extracted.status as string) || status || "confirmed"
  const finalRef      = bookingReference || (extracted.bookingReference as string) || null
  const finalAddress  = (extracted.address as string) || null
  const propertyName  = (extracted.propertyName as string) || null

  // ── CAS ANNULATION ─────────────────────────────────────────────────────────
  if (finalStatus === "cancelled" && finalRef) {
    const existing = await prisma.accommodation.findUnique({
      where: { bookingReference: finalRef },
      select: { id: true, companyId: true },
    })
    if (existing && existing.companyId === companyId) {
      await prisma.accommodation.update({ where: { id: existing.id }, data: { status: "CANCELLED" } })
      await notifyAdmins(companyId, "Réservation annulée (IA)", `Booking #${finalRef} annulée automatiquement.`, "/logements")
      return NextResponse.json({ ok: true, action: "cancelled", id: existing.id })
    }
  }

  // ── FILTRE : SEULEMENT CONFIRMÉES À PARTIR DU 17/06/2026 ──────────────────
  if (finalStatus !== "confirmed") {
    return NextResponse.json({ ok: true, action: "skipped", reason: "not confirmed" })
  }
  if (!extracted.startDate) {
    return NextResponse.json({ ok: true, action: "skipped", reason: "no start date found" })
  }
  const startDate = new Date(extracted.startDate as string)
  const cutoffDate = new Date("2026-06-17")
  cutoffDate.setHours(0, 0, 0, 0)
  if (startDate < cutoffDate) {
    return NextResponse.json({ ok: true, action: "skipped", reason: "before cutoff date" })
  }

  // ── MATCH ÉQUIPE ───────────────────────────────────────────────────────────
  let matchedTeamId: string | null = null

  // 1) Par adresse déjà connue (logements passés)
  if (finalAddress) {
    const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "")
    const prefix = normalize(finalAddress).substring(0, 10)
    const pastAcc = await prisma.accommodation.findMany({
      where: { companyId },
      select: { teamId: true, address: true },
    })
    const match = pastAcc.find((a) => a.address && normalize(a.address).includes(prefix))
    if (match) matchedTeamId = match.teamId
  }

  // 2) Fallback : nom d'équipe dans l'email
  if (!matchedTeamId) {
    const teamName = extracted.teamName as string | null
    if (teamName) {
      const match = teams.find((t) =>
        t.name.toLowerCase() === teamName.toLowerCase() ||
        t.name.toLowerCase().includes(teamName.toLowerCase()) ||
        teamName.toLowerCase().includes(t.name.toLowerCase())
      )
      matchedTeamId = match?.id ?? null
    }
  }

  const hasAllData = matchedTeamId && admin && finalAddress && extracted.startDate && extracted.endDate

  // ── CRÉATION AUTOMATIQUE ───────────────────────────────────────────────────
  if (hasAllData) {
    const accData = {
      companyId,
      teamId:           matchedTeamId!,
      createdById:      admin!.id,
      bookingReference: finalRef ?? undefined,
      source:           "agent",
      address:          finalAddress!,
      city:             (extracted.city as string)          || null,
      zipCode:          (extracted.zipCode as string)       || null,
      startDate:        new Date(extracted.startDate as string),
      endDate:          new Date(extracted.endDate as string),
      doorCode:         (extracted.doorCode as string)      || null,
      contactName:      (extracted.contactName as string)   || null,
      contactPhone:     (extracted.contactPhone as string)  || null,
      notes:            propertyName,
      status:           "UPCOMING" as const,
    }

    let result
    if (finalRef) {
      result = await prisma.accommodation.upsert({
        where:  { bookingReference: finalRef },
        create: accData,
        update: {
          teamId:       accData.teamId,
          address:      accData.address,
          city:         accData.city,
          zipCode:      accData.zipCode,
          startDate:    accData.startDate,
          endDate:      accData.endDate,
          doorCode:     accData.doorCode,
          contactName:  accData.contactName,
          contactPhone: accData.contactPhone,
          notes:        accData.notes,
        },
      })
    } else {
      result = await prisma.accommodation.create({ data: accData })
    }

    const teamLabel = teams.find((t) => t.id === matchedTeamId)?.name ?? ""
    await notifyAdmins(
      companyId,
      "✅ Logement créé automatiquement",
      `${propertyName || finalAddress} — Équipe ${teamLabel}.`,
      "/logements"
    )
    return NextResponse.json({ ok: true, action: "created", id: result.id })
  }

  // ── FALLBACK : PendingAccommodation avec données enrichies ─────────────────
  const pendingData = {
    propertyName,
    address:     finalAddress,
    city:        (extracted.city as string)         || null,
    zipCode:     (extracted.zipCode as string)      || null,
    startDate:   extracted.startDate ? new Date(extracted.startDate as string) : null,
    endDate:     extracted.endDate   ? new Date(extracted.endDate as string)   : null,
    doorCode:    (extracted.doorCode as string)     || null,
    contactName: (extracted.contactName as string)  || null,
    contactPhone:(extracted.contactPhone as string) || null,
    rawEmailSnippet: rawEmailText.substring(0, 500),
  }

  const gmailId = finalRef || `agent-${Date.now()}`
  const existingPending = finalRef
    ? await prisma.pendingAccommodation.findFirst({ where: { gmailMessageId: gmailId, companyId }, select: { id: true } })
    : null

  const pending = existingPending
    ? await prisma.pendingAccommodation.update({ where: { id: existingPending.id }, data: pendingData })
    : await prisma.pendingAccommodation.create({ data: { companyId, gmailMessageId: gmailId, ...pendingData } })

  const reason = !matchedTeamId ? "équipe non identifiée" : "adresse introuvable"
  await notifyAdmins(
    companyId,
    `⚠️ Réservation en attente (${reason})`,
    `${propertyName || "Logement"} — Affectation manuelle requise.`,
    "/logements"
  )

  return NextResponse.json({ ok: true, action: "pending", id: pending.id, reason })
}

async function notifyAdmins(companyId: string, title: string, message: string, link: string) {
  const admins = await prisma.user.findMany({
    where:  { companyId, role: { in: ["ADMIN", "SUPER_ADMIN"] } },
    select: { id: true },
  })
  if (!admins.length) return
  await prisma.notification.createMany({
    data: admins.map((a) => ({
      userId:    a.id,
      companyId,
      type:      "BOOKING_DETECTED" as const,
      title,
      message,
      link,
    })),
  })
}
