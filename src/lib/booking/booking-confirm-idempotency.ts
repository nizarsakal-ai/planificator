/**
 * Idempotence confirm PendingAccommodation / Accommodation (P2002 gmailSourceMessageId).
 *
 * Règle critique PostgreSQL : ne jamais intercepter P2002 *dans* le callback
 * d’une `$transaction` interactive puis continuer sur le même `tx` (TX abortée).
 * Le catch P2002 ciblé doit être *extérieur* ; la résolution utilise un nouveau contexte.
 */

import type { Prisma, PrismaClient } from "@prisma/client"
import {
  accommodationFieldsFromPendingIdentity,
  type PendingSourceKind,
} from "@/lib/booking/booking-pending-identity"

export function isPrismaUniqueViolation(
  error: unknown,
  fieldHints: readonly string[]
): boolean {
  if (
    typeof error !== "object" ||
    error === null ||
    !("code" in error) ||
    (error as { code: string }).code !== "P2002"
  ) {
    return false
  }
  const target = (error as { meta?: { target?: string | string[] } }).meta?.target
  if (target == null) return false
  const targets = (Array.isArray(target) ? target : [target]).map((t) =>
    String(t).toLowerCase()
  )
  return fieldHints.some((hint) =>
    targets.some((t) => t.includes(hint.toLowerCase()))
  )
}

export function isAnyPrismaUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code: string }).code === "P2002"
  )
}

/** Contrainte Accommodation @@unique([companyId, gmailSourceMessageId]). */
export const ACCOMMODATION_GMAIL_SOURCE_UNIQUE_HINTS = [
  "gmailSourceMessageId",
  "companyId_gmailSourceMessageId",
] as const

/** Contrainte Accommodation @@unique([companyId, bookingReference]). */
export const ACCOMMODATION_BOOKING_REF_UNIQUE_HINTS = [
  "bookingReference",
  "companyId_bookingReference",
] as const

export type ConfirmCreateInput = {
  companyId: string
  userId: string
  pendingId: string
  /** Null si pending N8N/agent (pas d'id Gmail). */
  gmailMessageId: string | null
  sourceKind: PendingSourceKind | string
  externalSourceId: string | null
  idempotencyKey: string
  teamId: string
  finalAddress: string
  city: string | null
  zipCode: string | null
  doorCode: string | null
  contactName: string | null
  contactPhone: string | null
  notes: string | null
  startDate: Date
  endDate: Date
  notifyUserIds: string[]
  teamName: string
  startLabel: string
  endLabel: string
}

export type ConfirmResult =
  | { success: true; idempotent: boolean }
  | { error: string }

type Db = PrismaClient | Prisma.TransactionClient

/**
 * Chemin normal : create Accommodation + CONFIRMED dans une seule TX.
 * Aucun catch P2002 ici — laisse remonter pour gestion externe.
 */
export async function runConfirmCreateTransaction(
  db: PrismaClient,
  input: ConfirmCreateInput
): Promise<void> {
  const identity = accommodationFieldsFromPendingIdentity({
    sourceKind: input.sourceKind,
    gmailMessageId: input.gmailMessageId,
    externalSourceId: input.externalSourceId,
    idempotencyKey: input.idempotencyKey,
  })

  await db.$transaction(async (tx) => {
    const created = await tx.accommodation.create({
      data: {
        companyId: input.companyId,
        teamId: input.teamId,
        createdById: input.userId,
        startDate: input.startDate,
        endDate: input.endDate,
        address: input.finalAddress,
        city: input.city,
        zipCode: input.zipCode,
        doorCode: input.doorCode,
        contactName: input.contactName,
        contactPhone: input.contactPhone,
        notes: input.notes,
        gmailSourceMessageId: identity.gmailSourceMessageId,
        bookingReference: identity.bookingReference,
        source: identity.source,
      },
    })

    const updated = await tx.pendingAccommodation.updateMany({
      where: {
        id: input.pendingId,
        companyId: input.companyId,
        status: "PENDING",
      },
      data: {
        status: "CONFIRMED",
        accommodationId: created.id,
        confirmedById: input.userId,
        confirmedAt: new Date(),
      },
    })
    if (updated.count === 0) {
      throw new Error("PENDING_CONFIRM_RACE")
    }

    if (input.notifyUserIds.length > 0) {
      await tx.notification.createMany({
        data: input.notifyUserIds.map((uid) => ({
          userId: uid,
          companyId: input.companyId,
          type: "ACCOMMODATION_CREATED" as const,
          title: `Logement réservé — ${input.teamName}`,
          message: `Un logement a été réservé pour votre équipe du ${input.startLabel} au ${input.endLabel}.`,
          link: "/planning/moi",
        })),
      })
    }
  })
}

/**
 * Résolution idempotente après P2002 ciblé — **nouveau** contexte DB
 * (jamais le `tx` ayant reçu la violation).
 */
export async function resolveConfirmAfterGmailSourceConflict(
  db: PrismaClient,
  input: {
    companyId: string
    userId: string
    pendingId: string
    gmailMessageId: string | null
  }
): Promise<ConfirmResult> {
  return db.$transaction(async (tx) => {
    if (!input.gmailMessageId) {
      return { error: "Conflit d'unicité Gmail sans gmailMessageId." }
    }
    const accommodation = await tx.accommodation.findFirst({
      where: {
        companyId: input.companyId,
        gmailSourceMessageId: input.gmailMessageId,
      },
      orderBy: { createdAt: "asc" },
    })
    if (!accommodation) {
      return { error: "Logement introuvable après conflit d'unicité." }
    }
    if (accommodation.companyId !== input.companyId) {
      return { error: "Conflit d'isolation locataire." }
    }

    const pending = await tx.pendingAccommodation.findFirst({
      where: { id: input.pendingId, companyId: input.companyId },
    })
    if (!pending) {
      return { error: "Réservation introuvable." }
    }
    if (pending.status === "DISMISSED") {
      return { error: "Réservation déjà ignorée — confirmation impossible." }
    }
    if (pending.status === "CONFIRMED") {
      return { success: true, idempotent: true }
    }

    await tx.pendingAccommodation.updateMany({
      where: {
        id: input.pendingId,
        companyId: input.companyId,
        status: "PENDING",
      },
      data: {
        status: "CONFIRMED",
        accommodationId: accommodation.id,
        confirmedById: input.userId,
        confirmedAt: new Date(),
      },
    })

    return { success: true, idempotent: true }
  })
}

/**
 * Résolution après P2002 sur (companyId, bookingReference) — N8N / Agent avec ref.
 */
export async function resolveConfirmAfterBookingRefConflict(
  db: PrismaClient,
  input: {
    companyId: string
    userId: string
    pendingId: string
    bookingReference: string | null
  }
): Promise<ConfirmResult> {
  return db.$transaction(async (tx) => {
    if (!input.bookingReference) {
      return { error: "Conflit d'unicité bookingReference sans référence." }
    }
    const accommodation = await tx.accommodation.findUnique({
      where: {
        companyId_bookingReference: {
          companyId: input.companyId,
          bookingReference: input.bookingReference,
        },
      },
    })
    if (!accommodation) {
      return { error: "Logement introuvable après conflit d'unicité." }
    }
    if (accommodation.companyId !== input.companyId) {
      return { error: "Conflit d'isolation locataire." }
    }

    const pending = await tx.pendingAccommodation.findFirst({
      where: { id: input.pendingId, companyId: input.companyId },
    })
    if (!pending) {
      return { error: "Réservation introuvable." }
    }
    if (pending.status === "DISMISSED") {
      return { error: "Réservation déjà ignorée — confirmation impossible." }
    }
    if (pending.status === "CONFIRMED") {
      return { success: true, idempotent: true }
    }

    await tx.pendingAccommodation.updateMany({
      where: {
        id: input.pendingId,
        companyId: input.companyId,
        status: "PENDING",
      },
      data: {
        status: "CONFIRMED",
        accommodationId: accommodation.id,
        confirmedById: input.userId,
        confirmedAt: new Date(),
      },
    })

    return { success: true, idempotent: true }
  })
}

/** Exposé pour tests structurels / typage. */
export type { Db }
