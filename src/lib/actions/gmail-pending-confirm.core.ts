/**
 * Cœur testable de `confirmPendingAccommodation` (deps injectables).
 * Pas de "use server" — la façade reste dans gmail.actions.ts.
 */

import type { PendingAccommodation, PrismaClient, Role } from "@prisma/client"
import { resolveConfirmAddress } from "@/lib/booking/booking-pending-merge"
import { isCalendarRangeValid } from "@/lib/booking/booking-date-only"
import {
  ACCOMMODATION_BOOKING_REF_UNIQUE_HINTS,
  ACCOMMODATION_GMAIL_SOURCE_UNIQUE_HINTS,
  isAnyPrismaUniqueViolation,
  isPrismaUniqueViolation,
  resolveConfirmAfterBookingRefConflict,
  resolveConfirmAfterGmailSourceConflict,
  runConfirmCreateTransaction,
} from "@/lib/booking/booking-confirm-idempotency"
import { accommodationFieldsFromPendingIdentity } from "@/lib/booking/booking-pending-identity"

export type BookingValidationSessionUser = {
  id: string
  role: Role
  companyId: string | null
}

export type ConfirmPendingTeam = {
  id: string
  name: string
  leader: { userId: string | null }
  members: Array<{
    employee: {
      userId: string | null
      firstName: string
      lastName: string
      user: { email: string | null } | null
    }
  }>
}

/** Surface minimale ; la façade passe `prisma` via cast (tests = fakes). */
export type ConfirmPendingDb = {
  pendingAccommodation: {
    findFirst: (args: {
      where: { id: string; companyId: string }
    }) => Promise<PendingAccommodation | null>
  }
  team: {
    findFirst: (args: {
      where: { id: string; companyId: string; active: boolean }
      include?: unknown
    }) => Promise<ConfirmPendingTeam | null>
  }
  company: {
    findUnique: (args: {
      where: { id: string }
      select: { name: true }
    }) => Promise<{ name: string } | null>
  }
  $transaction: (
    fn: (tx: unknown) => Promise<unknown>
  ) => Promise<unknown>
}

export type SendLogementCreatedEmailFn = (input: {
  to: string
  recipientName: string
  teamName: string
  address: string
  startLabel: string
  endLabel: string
  doorCode?: string
  contactPhone?: string
  companyName: string
}) => Promise<unknown>

export type ConfirmPendingAccommodationDeps = {
  auth: () => Promise<{ user?: BookingValidationSessionUser } | null>
  db: ConfirmPendingDb
  revalidatePath: (path: string) => void
  /** Injecté pour éviter tout réseau dans les tests. */
  sendLogementCreatedEmail: SendLogementCreatedEmailFn
}

export type ConfirmPendingAccommodationResult =
  | { success: true; idempotent: boolean }
  | { error: string }

function requireBookingValidationAdmin(
  session: { user?: BookingValidationSessionUser } | null
): BookingValidationSessionUser {
  if (!session?.user) throw new Error("Non authentifié")
  if (!["ADMIN", "SUPER_ADMIN"].includes(session.user.role)) {
    throw new Error("Accès refusé")
  }
  if (!session.user.companyId) throw new Error("Entreprise introuvable")
  return session.user
}

export async function confirmPendingAccommodationImpl(
  id: string,
  teamId: string,
  deps: ConfirmPendingAccommodationDeps,
  overrideAddress?: string
): Promise<ConfirmPendingAccommodationResult> {
  const user = requireBookingValidationAdmin(await deps.auth())
  const companyId = user.companyId!

  const pending = await deps.db.pendingAccommodation.findFirst({
    where: { id, companyId },
  })
  if (!pending) return { error: "Réservation introuvable." }
  if (pending.status === "DISMISSED") {
    return { error: "Réservation déjà ignorée — confirmation impossible." }
  }
  if (pending.status === "CONFIRMED") {
    return { success: true, idempotent: true }
  }
  if (pending.status !== "PENDING") {
    return { error: "Réservation introuvable." }
  }

  if (!pending.startDate || !pending.endDate) {
    return { error: "Dates manquantes dans l'email." }
  }
  if (!isCalendarRangeValid(pending.startDate, pending.endDate)) {
    return { error: "La date de départ doit être après la date d'arrivée" }
  }
  const finalAddress = resolveConfirmAddress(pending.address, overrideAddress)
  if (!finalAddress) {
    return { error: "Veuillez saisir l'adresse du logement." }
  }

  const team = await deps.db.team.findFirst({
    where: { id: teamId, companyId, active: true },
    include: {
      leader: { select: { userId: true } },
      members: {
        where: { leftAt: null },
        include: {
          employee: {
            select: {
              userId: true,
              firstName: true,
              lastName: true,
              user: { select: { email: true } },
            },
          },
        },
      },
    },
  })
  if (!team) return { error: "Équipe introuvable." }

  const fmtDate = (d: Date) =>
    new Intl.DateTimeFormat("fr-FR", {
      day: "2-digit",
      month: "long",
      year: "numeric",
    }).format(d)
  const startLabel = fmtDate(pending.startDate)
  const endLabel = fmtDate(pending.endDate)

  const userIds = [
    team.leader.userId,
    ...team.members.map((m) => m.employee.userId),
  ].filter(Boolean) as string[]

  const notesValue =
    [pending.propertyName, pending.notes].filter(Boolean).join(" — ") || null

  const createInput = {
    companyId,
    userId: user.id,
    pendingId: id,
    gmailMessageId: pending.gmailMessageId,
    sourceKind: pending.sourceKind,
    externalSourceId: pending.externalSourceId,
    idempotencyKey: pending.idempotencyKey,
    teamId,
    finalAddress,
    city: pending.city ?? null,
    zipCode: pending.zipCode ?? null,
    doorCode: pending.doorCode ?? null,
    contactName: pending.contactName ?? null,
    contactPhone: pending.contactPhone ?? null,
    notes: notesValue,
    startDate: pending.startDate,
    endDate: pending.endDate,
    notifyUserIds: userIds,
    teamName: team.name,
    startLabel,
    endLabel,
  }

  const identity = accommodationFieldsFromPendingIdentity({
    sourceKind: pending.sourceKind,
    gmailMessageId: pending.gmailMessageId,
    externalSourceId: pending.externalSourceId,
    idempotencyKey: pending.idempotencyKey,
  })

  let createdNew = true
  try {
    await runConfirmCreateTransaction(deps.db as unknown as PrismaClient, createInput)
  } catch (error) {
    if (isPrismaUniqueViolation(error, ACCOMMODATION_GMAIL_SOURCE_UNIQUE_HINTS)) {
      const resolved = await resolveConfirmAfterGmailSourceConflict(
        deps.db as unknown as PrismaClient,
        {
          companyId,
          userId: user.id,
          pendingId: id,
          gmailMessageId: pending.gmailMessageId,
        }
      )
      if ("error" in resolved) return resolved
      createdNew = false
      deps.revalidatePath("/logements")
      deps.revalidatePath("/planning/moi")
      return resolved
    }
    if (isPrismaUniqueViolation(error, ACCOMMODATION_BOOKING_REF_UNIQUE_HINTS)) {
      const resolved = await resolveConfirmAfterBookingRefConflict(
        deps.db as unknown as PrismaClient,
        {
          companyId,
          userId: user.id,
          pendingId: id,
          bookingReference: identity.bookingReference,
        }
      )
      if ("error" in resolved) return resolved
      createdNew = false
      deps.revalidatePath("/logements")
      deps.revalidatePath("/planning/moi")
      return resolved
    }
    if (isAnyPrismaUniqueViolation(error)) {
      throw error
    }
    return { error: "Impossible de confirmer la réservation. Réessayez." }
  }

  if (createdNew) {
    const company = await deps.db.company.findUnique({
      where: { id: companyId },
      select: { name: true },
    })
    for (const membre of team.members) {
      const email = membre.employee.user?.email
      if (!email) continue
      deps
        .sendLogementCreatedEmail({
          to: email,
          recipientName: `${membre.employee.firstName} ${membre.employee.lastName}`,
          teamName: team.name,
          address: `${finalAddress}${pending.city ? `, ${pending.city}` : ""}`,
          startLabel,
          endLabel,
          doorCode: pending.doorCode ?? undefined,
          contactPhone: pending.contactPhone ?? undefined,
          companyName: company?.name ?? "",
        })
        .catch(() => {})
    }
  }

  deps.revalidatePath("/logements")
  deps.revalidatePath("/planning/moi")
  return { success: true, idempotent: false }
}
