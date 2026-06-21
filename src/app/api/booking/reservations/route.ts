import { NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { z } from "zod"

// ── Schéma de validation du payload N8N ──────────────────────────────────────
const ReservationSchema = z.object({
  // Identification
  companyId:        z.string().min(1),
  bookingReference: z.string().min(1),

  // Statut de la réservation Booking.com
  // confirmed → créer/mettre à jour
  // modified  → mettre à jour les données
  // cancelled → passer le statut à CANCELLED
  status: z.enum(["confirmed", "modified", "cancelled"]),

  // Affectation équipe (optionnel — fallback PendingAccommodation si absent)
  teamName: z.string().optional().nullable(),

  // Données du logement
  propertyName: z.string().optional().nullable(),
  address:      z.string().optional().nullable(),
  city:         z.string().optional().nullable(),
  zipCode:      z.string().optional().nullable(),
  startDate:    z.string().optional().nullable(), // "YYYY-MM-DD"
  endDate:      z.string().optional().nullable(), // "YYYY-MM-DD"
  doorCode:     z.string().optional().nullable(),
  contactName:  z.string().optional().nullable(),
  contactPhone: z.string().optional().nullable(),
  notes:        z.string().optional().nullable(),
})

export async function POST(req: Request) {
  // ── Auth : Bearer CRON_SECRET ────────────────────────────────────────────
  const authHeader = req.headers.get("authorization")
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  // ── Parse & validation ────────────────────────────────────────────────────
  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 })
  }

  const parsed = ReservationSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Validation failed", details: parsed.error.flatten() },
      { status: 422 }
    )
  }

  const data = parsed.data

  // ── Vérifier que l'entreprise existe ─────────────────────────────────────
  const company = await prisma.company.findUnique({
    where: { id: data.companyId },
    select: { id: true },
  })
  if (!company) {
    return NextResponse.json({ error: "Company not found" }, { status: 404 })
  }

  // ── Chercher le créateur (admin de l'entreprise) ──────────────────────────
  const admin = await prisma.user.findFirst({
    where: { companyId: data.companyId, role: { in: ["SUPER_ADMIN", "ADMIN"] } },
    select: { id: true },
  })

  // ── Cas CANCELLED : on annule l'accommodation existante ───────────────────
  if (data.status === "cancelled") {
    const existing = await prisma.accommodation.findUnique({
      where: { bookingReference: data.bookingReference },
      select: { id: true, companyId: true },
    })
    if (!existing || existing.companyId !== data.companyId) {
      return NextResponse.json({ error: "Reservation not found" }, { status: 404 })
    }

    await prisma.accommodation.update({
      where: { id: existing.id },
      data:  { status: "CANCELLED" },
    })

    // Notification admins
    await _notifyAdmins(data.companyId, "Réservation annulée", `Booking #${data.bookingReference} annulée.`, "/logements")

    return NextResponse.json({ ok: true, action: "cancelled", id: existing.id })
  }

  // ── Cas CONFIRMED ou MODIFIED : upsert ───────────────────────────────────

  // Chercher l'équipe par nom si fourni — exact d'abord, puis partiel
  let matchedTeamId: string | null = null
  if (data.teamName) {
    const exactTeam = await prisma.team.findFirst({
      where: {
        companyId: data.companyId,
        active:    true,
        name:      { equals: data.teamName, mode: "insensitive" },
      },
      select: { id: true },
    })
    if (exactTeam) {
      matchedTeamId = exactTeam.id
    } else {
      const partialTeam = await prisma.team.findFirst({
        where: {
          companyId: data.companyId,
          active:    true,
          name:      { contains: data.teamName, mode: "insensitive" },
        },
        select: { id: true },
      })
      matchedTeamId = partialTeam?.id ?? null
    }
  }

  const hasRequiredData =
    matchedTeamId &&
    admin &&
    data.address &&
    data.startDate &&
    data.endDate

  if (hasRequiredData) {
    // ── Upsert Accommodation ─────────────────────────────────────────────
    const accData = {
      companyId:        data.companyId,
      teamId:           matchedTeamId!,
      createdById:      admin!.id,
      bookingReference: data.bookingReference,
      source:           "n8n",
      address:          data.address!,
      city:             data.city         ?? null,
      zipCode:          data.zipCode      ?? null,
      startDate:        new Date(data.startDate!),
      endDate:          new Date(data.endDate!),
      doorCode:         data.doorCode     ?? null,
      contactName:      data.contactName  ?? null,
      contactPhone:     data.contactPhone ?? null,
      notes:            data.notes        ?? null,
      status:           "UPCOMING" as const,
    }

    const result = await prisma.accommodation.upsert({
      where:  { bookingReference: data.bookingReference },
      create: accData,
      update: {
        // Ne pas écraser le statut CANCELLED
        teamId:      accData.teamId,
        address:     accData.address,
        city:        accData.city,
        zipCode:     accData.zipCode,
        startDate:   accData.startDate,
        endDate:     accData.endDate,
        doorCode:    accData.doorCode,
        contactName: accData.contactName,
        contactPhone:accData.contactPhone,
        notes:       accData.notes,
      },
    })

    const action = data.status === "confirmed" ? "created" : "updated"
    const label  = data.status === "confirmed" ? "Logement créé via N8N" : "Logement mis à jour via N8N"
    const msg    = `${data.propertyName ?? data.address}${data.startDate ? ` du ${data.startDate} au ${data.endDate}` : ""} — Équipe ${data.teamName}.`
    await _notifyAdmins(data.companyId, label, msg, "/logements")

    return NextResponse.json({ ok: true, action, id: result.id })
  }

  // ── Fallback : PendingAccommodation si équipe non trouvée ─────────────────
  const pendingData = {
    propertyName:    data.propertyName  ?? null,
    address:         data.address       ?? null,
    city:            data.city          ?? null,
    zipCode:         data.zipCode       ?? null,
    startDate:       data.startDate ? new Date(data.startDate) : null,
    endDate:         data.endDate   ? new Date(data.endDate)   : null,
    doorCode:        data.doorCode      ?? null,
    contactName:     data.contactName   ?? null,
    contactPhone:    data.contactPhone  ?? null,
    notes:           data.notes         ?? null,
  }

  // Chercher si une PendingAccommodation existe déjà pour cette référence
  const existingPending = await prisma.pendingAccommodation.findFirst({
    where:  { gmailMessageId: data.bookingReference, companyId: data.companyId },
    select: { id: true },
  })

  const pending = existingPending
    ? await prisma.pendingAccommodation.update({
        where: { id: existingPending.id },
        data:  pendingData,
      })
    : await prisma.pendingAccommodation.create({
        data: {
          companyId:       data.companyId,
          gmailMessageId:  data.bookingReference,
          rawEmailSnippet: `[n8n] ${data.propertyName ?? ""} — ref: ${data.bookingReference}`.substring(0, 500),
          ...pendingData,
        },
      })

  const dateInfo = data.startDate ? ` du ${data.startDate}${data.endDate ? ` au ${data.endDate}` : ""}` : ""
  await _notifyAdmins(
    data.companyId,
    "Réservation en attente (équipe non trouvée)",
    `${data.propertyName ?? "Logement"}${dateInfo} — Cliquez pour affecter une équipe.`,
    "/logements"
  )

  return NextResponse.json({ ok: true, action: "pending", id: pending.id })
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function _notifyAdmins(companyId: string, title: string, message: string, link: string) {
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

