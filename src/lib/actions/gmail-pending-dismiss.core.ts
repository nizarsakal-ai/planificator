/**
 * Cœur testable de `dismissPendingAccommodation` (deps injectables).
 * Pas de "use server" — la façade reste dans gmail.actions.ts.
 */

import type { PendingAccommodation, PendingAccommodationStatus, Role } from "@prisma/client"

export type BookingValidationSessionUser = {
  id: string
  role: Role
  companyId: string | null
}

export type DismissPendingDb = {
  pendingAccommodation: {
    findFirst: (args: {
      where: { id: string; companyId: string }
    }) => Promise<Pick<PendingAccommodation, "id" | "companyId" | "status"> | null>
    updateMany: (args: {
      where: { id: string; companyId: string; status: PendingAccommodationStatus }
      data: { status: PendingAccommodationStatus }
    }) => Promise<{ count: number }>
  }
}

export type DismissPendingAccommodationDeps = {
  auth: () => Promise<{ user?: BookingValidationSessionUser } | null>
  db: DismissPendingDb
  revalidatePath: (path: string) => void
}

export type DismissPendingAccommodationResult =
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

export async function dismissPendingAccommodationImpl(
  id: string,
  deps: DismissPendingAccommodationDeps
): Promise<DismissPendingAccommodationResult> {
  const user = requireBookingValidationAdmin(await deps.auth())
  const companyId = user.companyId!

  const pending = await deps.db.pendingAccommodation.findFirst({
    where: { id, companyId },
  })
  if (!pending) return { error: "Réservation introuvable." }
  if (pending.status !== "PENDING") {
    return { error: "Réservation déjà traitée." }
  }
  const updated = await deps.db.pendingAccommodation.updateMany({
    where: { id, companyId, status: "PENDING" },
    data: { status: "DISMISSED" },
  })
  if (updated.count === 0) {
    return { error: "Réservation déjà traitée." }
  }
  deps.revalidatePath("/logements")
  return { success: true }
}
