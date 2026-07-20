/**
 * Persistance idempotente des résultats Booking dans une transaction.
 */

import type { BookingGmailResultType, Prisma } from "@prisma/client"

export type ParsedBookingFields = Record<string, string | null>

export async function createOrGetBookingScanResult(
  tx: Prisma.TransactionClient,
  input: {
    companyId: string
    messageId: string
    snippet: string
    parsed: ParsedBookingFields
    matchedTeamId: string | null
    adminId: string | null
  }
): Promise<{ resultType: BookingGmailResultType; resultEntityId: string | null; createdNew: boolean }> {
  const { companyId, messageId, snippet, parsed, matchedTeamId, adminId } = input

  // Annulation (chemin existant — rarement déclenché faute de champs dans le prompt)
  if (parsed.status === "cancelled" && parsed.bookingReference) {
    const existing = await tx.accommodation.findFirst({
      where: { companyId, bookingReference: parsed.bookingReference },
      select: { id: true },
    })
    if (existing) {
      await tx.accommodation.update({
        where: { id: existing.id },
        data: { status: "CANCELLED" },
      })
      return {
        resultType: "CANCELLATION",
        resultEntityId: existing.id,
        createdNew: false,
      }
    }
  }

  // Idempotence pending : un message Gmail → au plus un pending réutilisable
  const existingPending = await tx.pendingAccommodation.findFirst({
    where: { companyId, gmailMessageId: messageId },
    orderBy: { createdAt: "asc" },
  })

  if (matchedTeamId && adminId && parsed.address && parsed.startDate && parsed.endDate) {
    // Si un pending existe déjà pour ce message (rejeu après crash partiel legacy),
    // on ne crée pas d'Accommodation en double : on rattache le succès au pending.
    if (existingPending) {
      return {
        resultType: "PENDING_ACCOMMODATION",
        resultEntityId: existingPending.id,
        createdNew: false,
      }
    }

    // Idempotence Accommodation : même company + adresse + dates + équipe
    const startDate = new Date(parsed.startDate)
    const endDate = new Date(parsed.endDate)
    const existingAcc = await tx.accommodation.findFirst({
      where: {
        companyId,
        teamId: matchedTeamId,
        address: parsed.address,
        startDate,
        endDate,
      },
      orderBy: { createdAt: "desc" },
    })
    if (existingAcc) {
      return {
        resultType: "ACCOMMODATION",
        resultEntityId: existingAcc.id,
        createdNew: false,
      }
    }

    const accommodation = await tx.accommodation.create({
      data: {
        companyId,
        teamId: matchedTeamId,
        createdById: adminId,
        address: parsed.address,
        city: parsed.city ?? null,
        zipCode: parsed.zipCode ?? null,
        startDate,
        endDate,
        doorCode: parsed.doorCode ?? null,
        contactName: parsed.contactName ?? null,
        contactPhone: parsed.contactPhone ?? null,
        notes: parsed.notes ?? null,
        source: "gmail-scan",
      },
    })

    const admins = await tx.user.findMany({
      where: { companyId, role: { in: ["ADMIN", "SUPER_ADMIN"] } },
      select: { id: true },
    })
    const dateInfo = ` du ${parsed.startDate} au ${parsed.endDate}`
    if (admins.length > 0) {
      await tx.notification.createMany({
        data: admins.map((a) => ({
          userId: a.id,
          companyId,
          type: "BOOKING_DETECTED" as const,
          title: "Logement créé automatiquement",
          message: `${parsed.propertyName ?? parsed.address}${dateInfo} — Équipe ${parsed.teamName} affectée.`,
          link: "/logements",
        })),
      })
    }

    return {
      resultType: "ACCOMMODATION",
      resultEntityId: accommodation.id,
      createdNew: true,
    }
  }

  if (existingPending) {
    return {
      resultType: "PENDING_ACCOMMODATION",
      resultEntityId: existingPending.id,
      createdNew: false,
    }
  }

  const pending = await tx.pendingAccommodation.create({
    data: {
      companyId,
      gmailMessageId: messageId,
      propertyName: parsed.propertyName ?? null,
      address: parsed.address ?? null,
      city: parsed.city ?? null,
      zipCode: parsed.zipCode ?? null,
      startDate: parsed.startDate ? new Date(parsed.startDate) : null,
      endDate: parsed.endDate ? new Date(parsed.endDate) : null,
      doorCode: parsed.doorCode ?? null,
      contactName: parsed.contactName ?? null,
      contactPhone: parsed.contactPhone ?? null,
      notes: parsed.notes ?? null,
      rawEmailSnippet: snippet.substring(0, 500),
    },
  })

  const admins = await tx.user.findMany({
    where: { companyId, role: { in: ["ADMIN", "SUPER_ADMIN"] } },
    select: { id: true },
  })
  const dateInfo = parsed.startDate
    ? ` du ${parsed.startDate}${parsed.endDate ? ` au ${parsed.endDate}` : ""}`
    : ""
  if (admins.length > 0) {
    await tx.notification.createMany({
      data: admins.map((a) => ({
        userId: a.id,
        companyId,
        type: "BOOKING_DETECTED" as const,
        title: "Réservation Booking.com détectée",
        message: `${parsed.propertyName ?? "Logement"}${dateInfo} — Cliquez pour affecter une équipe.`,
        link: "/logements",
      })),
    })
  }

  return {
    resultType: "PENDING_ACCOMMODATION",
    resultEntityId: pending.id,
    createdNew: true,
  }
}
