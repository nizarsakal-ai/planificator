/**
 * Cœur testable de `updatePendingAccommodation` (deps injectables).
 * Pas de "use server" — la façade reste dans gmail.actions.ts.
 */

import { z } from "zod"
import type { PendingAccommodation, PendingAccommodationStatus, Role } from "@prisma/client"
import {
  isCalendarRangeValid,
  parseStrictCalendarYmd,
} from "@/lib/booking/booking-date-only"

export type BookingValidationSessionUser = {
  id: string
  role: Role
  companyId: string | null
}

export type UpdatePendingAccommodationPatch = {
  propertyName?: string | null
  address?: string | null
  city?: string | null
  zipCode?: string | null
  startDate?: string | null
  endDate?: string | null
  doorCode?: string | null
  contactName?: string | null
  contactPhone?: string | null
  notes?: string | null
}

const optionalCalendarYmd = z
  .string()
  .nullable()
  .optional()
  .superRefine((val, ctx) => {
    if (val === undefined || val === null) return
    if (!parseStrictCalendarYmd(val)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Date invalide (YYYY-MM-DD calendaire)",
      })
    }
  })

export const updatePendingAccommodationSchema = z
  .object({
    propertyName: z.string().max(200).nullable().optional(),
    address: z.string().max(500).nullable().optional(),
    city: z.string().max(120).nullable().optional(),
    zipCode: z.string().max(20).nullable().optional(),
    startDate: optionalCalendarYmd,
    endDate: optionalCalendarYmd,
    doorCode: z.string().max(40).nullable().optional(),
    contactName: z.string().max(120).nullable().optional(),
    contactPhone: z.string().max(40).nullable().optional(),
    notes: z.string().max(2000).nullable().optional(),
  })
  .strict()

function normalizeOptionalString(value: string | null | undefined): string | null | undefined {
  if (value === undefined) return undefined
  if (value === null) return null
  const t = value.trim()
  return t.length === 0 ? null : t
}

export type UpdatePendingDb = {
  pendingAccommodation: {
    findFirst: (args: {
      where: { id: string; companyId: string }
    }) => Promise<Pick<
      PendingAccommodation,
      "id" | "companyId" | "status" | "startDate" | "endDate"
    > | null>
    updateMany: (args: {
      where: { id: string; companyId: string; status: PendingAccommodationStatus }
      data: Record<string, string | Date | null>
    }) => Promise<{ count: number }>
  }
}

export type UpdatePendingAccommodationDeps = {
  auth: () => Promise<{ user?: BookingValidationSessionUser } | null>
  db: UpdatePendingDb
  revalidatePath: (path: string) => void
}

export type UpdatePendingAccommodationResult =
  | { success: true }
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

export async function updatePendingAccommodationImpl(
  id: string,
  patch: UpdatePendingAccommodationPatch,
  deps: UpdatePendingAccommodationDeps
): Promise<UpdatePendingAccommodationResult> {
  const user = requireBookingValidationAdmin(await deps.auth())
  const companyId = user.companyId!

  const parsed = updatePendingAccommodationSchema.safeParse(patch)
  if (!parsed.success) {
    return { error: parsed.error.errors[0]?.message ?? "Données invalides." }
  }

  const pending = await deps.db.pendingAccommodation.findFirst({
    where: { id, companyId },
  })
  if (!pending) return { error: "Réservation introuvable." }
  if (pending.status !== "PENDING") {
    return { error: "Réservation déjà traitée — modification impossible." }
  }

  const data: Record<string, string | Date | null> = {}
  const p = parsed.data

  if (p.propertyName !== undefined) data.propertyName = normalizeOptionalString(p.propertyName) ?? null
  if (p.address !== undefined) data.address = normalizeOptionalString(p.address) ?? null
  if (p.city !== undefined) data.city = normalizeOptionalString(p.city) ?? null
  if (p.zipCode !== undefined) data.zipCode = normalizeOptionalString(p.zipCode) ?? null
  if (p.doorCode !== undefined) data.doorCode = normalizeOptionalString(p.doorCode) ?? null
  if (p.contactName !== undefined) data.contactName = normalizeOptionalString(p.contactName) ?? null
  if (p.contactPhone !== undefined) data.contactPhone = normalizeOptionalString(p.contactPhone) ?? null
  if (p.notes !== undefined) data.notes = normalizeOptionalString(p.notes) ?? null

  if (p.startDate !== undefined) {
    if (p.startDate === null) data.startDate = null
    else {
      const d = parseStrictCalendarYmd(p.startDate)
      if (!d) return { error: "Date d'arrivée invalide." }
      data.startDate = d
    }
  }
  if (p.endDate !== undefined) {
    if (p.endDate === null) data.endDate = null
    else {
      const d = parseStrictCalendarYmd(p.endDate)
      if (!d) return { error: "Date de départ invalide." }
      data.endDate = d
    }
  }

  const nextStart =
    data.startDate !== undefined ? (data.startDate as Date | null) : pending.startDate
  const nextEnd =
    data.endDate !== undefined ? (data.endDate as Date | null) : pending.endDate
  if (nextStart && nextEnd && !isCalendarRangeValid(nextStart, nextEnd)) {
    return { error: "La date de départ doit être après la date d'arrivée" }
  }

  if (Object.keys(data).length === 0) {
    return { success: true }
  }

  const updated = await deps.db.pendingAccommodation.updateMany({
    where: { id, companyId, status: "PENDING" },
    data,
  })
  if (updated.count === 0) {
    return { error: "Réservation déjà traitée — modification impossible." }
  }

  deps.revalidatePath("/logements")
  return { success: true }
}
