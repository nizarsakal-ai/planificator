"use server"

import { revalidatePath } from "next/cache"
import { prisma } from "@/lib/prisma"
import { auth } from "@/auth"
import { sendLogementCreatedEmail } from "@/lib/email"
import { resolveConfirmAddress } from "@/lib/booking/booking-pending-merge"
import {
  ACCOMMODATION_GMAIL_SOURCE_UNIQUE_HINTS,
  isAnyPrismaUniqueViolation,
  isPrismaUniqueViolation,
  resolveConfirmAfterGmailSourceConflict,
  runConfirmCreateTransaction,
} from "@/lib/booking/booking-confirm-idempotency"

async function requireAdmin() {
  const session = await auth()
  if (!session?.user) throw new Error("Non authentifié")
  if (!["ADMIN", "SUPER_ADMIN", "TEAM_LEADER"].includes(session.user.role)) throw new Error("Accès refusé")
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
  const user = await requireAdmin()
  const rows = await prisma.pendingAccommodation.findMany({
    where:   { companyId: user.companyId!, status: "PENDING" },
    orderBy: { createdAt: "desc" },
  })
  const { toBookingUiEmailPreview } = await import("@/lib/booking/booking-pending-merge")
  return rows.map(({ rawEmailSnippet, ...rest }) => ({
    ...rest,
    emailPreview: toBookingUiEmailPreview(rawEmailSnippet),
  }))
}

export async function confirmPendingAccommodation(id: string, teamId: string, overrideAddress?: string) {
  const user = await requireAdmin()
  const companyId = user.companyId!

  const pending = await prisma.pendingAccommodation.findFirst({
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

  if (!pending.startDate || !pending.endDate) return { error: "Dates manquantes dans l'email." }
  const finalAddress = resolveConfirmAddress(pending.address, overrideAddress)
  if (!finalAddress) return { error: "Veuillez saisir l'adresse du logement." }

  const team = await prisma.team.findFirst({
    where: { id: teamId, companyId },
    include: {
      leader: { select: { userId: true } },
      members: {
        where: { leftAt: null },
        include: {
          employee: {
            select: {
              userId:    true,
              firstName: true,
              lastName:  true,
              user: { select: { email: true } },
            },
          },
        },
      },
    },
  })
  if (!team) return { error: "Équipe introuvable." }

  const fmtDate = (d: Date) =>
    new Intl.DateTimeFormat("fr-FR", { day: "2-digit", month: "long", year: "numeric" }).format(d)
  const startLabel = fmtDate(pending.startDate)
  const endLabel   = fmtDate(pending.endDate)

  const userIds = [
    team.leader.userId,
    ...team.members.map((m) => m.employee.userId),
  ].filter(Boolean) as string[]

  const notesValue = [pending.propertyName, pending.notes].filter(Boolean).join(" — ") || null

  const createInput = {
    companyId,
    userId: user.id,
    pendingId: id,
    gmailMessageId: pending.gmailMessageId,
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

  let createdNew = true
  try {
    // Chemin normal : TX atomique. Aucun catch P2002 *dans* ce callback.
    await runConfirmCreateTransaction(prisma, createInput)
  } catch (error) {
    // P2002 ciblé : la TX ci-dessus a rollback — résolution dans un *nouveau* contexte.
    if (isPrismaUniqueViolation(error, ACCOMMODATION_GMAIL_SOURCE_UNIQUE_HINTS)) {
      const resolved = await resolveConfirmAfterGmailSourceConflict(prisma, {
        companyId,
        userId: user.id,
        pendingId: id,
        gmailMessageId: pending.gmailMessageId,
      })
      if ("error" in resolved) return resolved
      createdNew = false
      revalidatePath("/logements")
      revalidatePath("/planning/moi")
      return resolved
    }
    // Autre contrainte unique : ne pas masquer.
    if (isAnyPrismaUniqueViolation(error)) {
      throw error
    }
    return { error: "Impossible de confirmer la réservation. Réessayez." }
  }

  if (createdNew) {
    const company = await prisma.company.findUnique({
      where: { id: companyId },
      select: { name: true },
    })
    for (const membre of team.members) {
      const email = membre.employee.user?.email
      if (!email) continue
      sendLogementCreatedEmail({
        to:            email,
        recipientName: `${membre.employee.firstName} ${membre.employee.lastName}`,
        teamName:      team.name,
        address:       `${finalAddress}${pending.city ? `, ${pending.city}` : ""}`,
        startLabel,
        endLabel,
        doorCode:      pending.doorCode  ?? undefined,
        contactPhone:  pending.contactPhone ?? undefined,
        companyName:   company?.name ?? "",
      }).catch(() => {})
    }
  }

  revalidatePath("/logements")
  revalidatePath("/planning/moi")
  return { success: true, idempotent: false }
}

export async function dismissPendingAccommodation(id: string) {
  const user = await requireAdmin()
  const pending = await prisma.pendingAccommodation.findFirst({
    where: { id, companyId: user.companyId! },
  })
  if (!pending) return { error: "Réservation introuvable." }
  await prisma.pendingAccommodation.update({
    where: { id },
    data:  { status: "DISMISSED" },
  })
  revalidatePath("/logements")
  return { success: true }
}
