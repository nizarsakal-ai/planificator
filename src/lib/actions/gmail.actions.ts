"use server"

import { revalidatePath } from "next/cache"
import { prisma } from "@/lib/prisma"
import { auth } from "@/auth"
import { sendLogementCreatedEmail } from "@/lib/email"
import {
  updatePendingAccommodationImpl,
  type UpdatePendingAccommodationPatch,
} from "@/lib/actions/gmail-pending-update.core"
import { confirmPendingAccommodationImpl } from "@/lib/actions/gmail-pending-confirm.core"
import { dismissPendingAccommodationImpl } from "@/lib/actions/gmail-pending-dismiss.core"

export type { UpdatePendingAccommodationPatch }

/** Auth large (Paramètres Gmail, etc.) — ne pas élargir au centre de validation. */
async function requireAdmin() {
  const session = await auth()
  if (!session?.user) throw new Error("Non authentifié")
  if (!["ADMIN", "SUPER_ADMIN", "TEAM_LEADER"].includes(session.user.role)) throw new Error("Accès refusé")
  if (!session.user.companyId) throw new Error("Entreprise introuvable")
  return session.user
}

/** Centre de validation Booking — ADMIN / SUPER_ADMIN uniquement. */
async function requireBookingValidationAdmin() {
  const session = await auth()
  if (!session?.user) throw new Error("Non authentifié")
  if (!["ADMIN", "SUPER_ADMIN"].includes(session.user.role)) throw new Error("Accès refusé")
  if (!session.user.companyId) throw new Error("Entreprise introuvable")
  return session.user
}

export async function disconnectGmail() {
  const user = await requireAdmin()
  await prisma.gmailConnection.deleteMany({ where: { companyId: user.companyId! } })
  revalidatePath("/parametres")
  return { success: true }
}

export async function getPendingAccommodations() {
  const user = await requireBookingValidationAdmin()
  const rows = await prisma.pendingAccommodation.findMany({
    where: { companyId: user.companyId!, status: "PENDING" },
    orderBy: { createdAt: "desc" },
  })
  const { toBookingUiEmailPreview } = await import("@/lib/booking/booking-pending-merge")
  return rows.map(({ rawEmailSnippet, ...rest }) => ({
    ...rest,
    emailPreview: toBookingUiEmailPreview(rawEmailSnippet),
  }))
}

/**
 * Met à jour les champs métier d’un pending PENDING du tenant courant.
 * Ne touche jamais companyId, gmailMessageId, rawEmailSnippet, status, audit confirm.
 */
export async function updatePendingAccommodation(
  id: string,
  patch: UpdatePendingAccommodationPatch
) {
  return updatePendingAccommodationImpl(id, patch, {
    auth,
    db: prisma,
    revalidatePath,
  })
}

export async function confirmPendingAccommodation(
  id: string,
  teamId: string,
  overrideAddress?: string
) {
  return confirmPendingAccommodationImpl(
    id,
    teamId,
    {
      auth,
      db: prisma as never,
      revalidatePath,
      sendLogementCreatedEmail,
    },
    overrideAddress
  )
}

export async function dismissPendingAccommodation(id: string) {
  return dismissPendingAccommodationImpl(id, {
    auth,
    db: prisma as never,
    revalidatePath,
  })
}
