/**
 * Persistance idempotente des résultats Booking dans une transaction.
 *
 * - bookingReference : uniquement la vraie référence Booking.com (si connue).
 * - Accommodation.gmailSourceMessageId : clé technique tenant-safe (companyId + messageId).
 * - PendingAccommodation : unique (companyId, gmailMessageId).
 * - Rejeu : enrichit un pending PENDING sans doublon ni écrasement d’adresse.
 */

import type { BookingGmailResultType, PendingAccommodation, Prisma } from "@prisma/client"
import {
  BOOKING_EMAIL_BODY_PERSIST_MAX,
  buildPendingEnrichmentUpdate,
} from "@/lib/booking/booking-pending-merge"
import { isBookingScanPendingOnly } from "@/lib/booking/booking-scan-pending-only-flag"

export type ParsedBookingFields = Record<string, string | null>

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code: string }).code === "P2002"
  )
}

async function enrichExistingPending(
  tx: Prisma.TransactionClient,
  existingPending: PendingAccommodation,
  parsed: ParsedBookingFields,
  emailBody: string
): Promise<{ resultType: BookingGmailResultType; resultEntityId: string; createdNew: boolean }> {
  const patch = buildPendingEnrichmentUpdate(existingPending, parsed, emailBody)
  if (patch) {
    await tx.pendingAccommodation.update({
      where: { id: existingPending.id },
      data: patch,
    })
  }
  return {
    resultType: "PENDING_ACCOMMODATION",
    resultEntityId: existingPending.id,
    createdNew: false,
  }
}

export async function createOrGetBookingScanResult(
  tx: Prisma.TransactionClient,
  input: {
    companyId: string
    messageId: string
    snippet: string
    parsed: ParsedBookingFields
    matchedTeamId: string | null
    adminId: string | null
    /** Corps normalisé (préféré au snippet Gmail pour persistance / rejeu). */
    emailBody?: string | null
  }
): Promise<{ resultType: BookingGmailResultType; resultEntityId: string | null; createdNew: boolean }> {
  const { companyId, messageId, snippet, parsed, matchedTeamId, adminId } = input
  const bookingRef = parsed.bookingReference?.trim() || null
  const emailBody = (input.emailBody?.trim() || snippet || "").substring(
    0,
    BOOKING_EMAIL_BODY_PERSIST_MAX
  )

  // Annulation (chemin existant — rarement déclenché faute de champs dans le prompt)
  if (parsed.status === "cancelled" && bookingRef) {
    const existing = await tx.accommodation.findFirst({
      where: { companyId, bookingReference: bookingRef },
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

  // Auto-Accommodation historique — désactivé si BOOKING_SCAN_PENDING_ONLY=true.
  if (
    !isBookingScanPendingOnly() &&
    matchedTeamId &&
    adminId &&
    parsed.address &&
    parsed.startDate &&
    parsed.endDate
  ) {
    // Pending déjà présent : enrichir si PENDING, ne jamais créer d’Accommodation en double.
    if (existingPending) {
      return enrichExistingPending(tx, existingPending, parsed, emailBody)
    }

    const existingAcc = await tx.accommodation.findFirst({
      where: { companyId, gmailSourceMessageId: messageId },
      orderBy: { createdAt: "asc" },
    })
    if (existingAcc) {
      return {
        resultType: "ACCOMMODATION",
        resultEntityId: existingAcc.id,
        createdNew: false,
      }
    }

    let accommodation
    try {
      accommodation = await tx.accommodation.create({
        data: {
          companyId,
          teamId: matchedTeamId,
          createdById: adminId,
          address: parsed.address,
          city: parsed.city ?? null,
          zipCode: parsed.zipCode ?? null,
          startDate: new Date(parsed.startDate),
          endDate: new Date(parsed.endDate),
          doorCode: parsed.doorCode ?? null,
          contactName: parsed.contactName ?? null,
          contactPhone: parsed.contactPhone ?? null,
          notes: parsed.notes ?? null,
          bookingReference: bookingRef,
          gmailSourceMessageId: messageId,
          source: "gmail-scan",
        },
      })
    } catch (error) {
      if (!isUniqueViolation(error)) throw error
      const raced = await tx.accommodation.findFirst({
        where: { companyId, gmailSourceMessageId: messageId },
        orderBy: { createdAt: "asc" },
      })
      if (!raced) throw error
      return {
        resultType: "ACCOMMODATION",
        resultEntityId: raced.id,
        createdNew: false,
      }
    }

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
    return enrichExistingPending(tx, existingPending, parsed, emailBody)
  }

  let pending
  try {
    pending = await tx.pendingAccommodation.create({
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
        rawEmailSnippet: emailBody.substring(0, BOOKING_EMAIL_BODY_PERSIST_MAX),
      },
    })
  } catch (error) {
    if (!isUniqueViolation(error)) throw error
    const raced = await tx.pendingAccommodation.findFirst({
      where: { companyId, gmailMessageId: messageId },
      orderBy: { createdAt: "asc" },
    })
    if (!raced) throw error
    return enrichExistingPending(tx, raced, parsed, emailBody)
  }

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
