"use server"

import { revalidatePath } from "next/cache"
import { prisma } from "@/lib/prisma"
import { auth } from "@/auth"
import { sendLogementCreatedEmail } from "@/lib/email"

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
  return prisma.pendingAccommodation.findMany({
    where:   { companyId: user.companyId!, status: "PENDING" },
    orderBy: { createdAt: "desc" },
  })
}

export async function confirmPendingAccommodation(id: string, teamId: string, overrideAddress?: string) {
  const user = await requireAdmin()

  const pending = await prisma.pendingAccommodation.findFirst({
    where: { id, companyId: user.companyId!, status: "PENDING" },
  })
  if (!pending)               return { error: "Réservation introuvable." }
  if (!pending.startDate || !pending.endDate) return { error: "Dates manquantes dans l'email." }
  const finalAddress = pending.address || overrideAddress?.trim()
  if (!finalAddress)          return { error: "Veuillez saisir l'adresse du logement." }

  const team = await prisma.team.findFirst({
    where: { id: teamId, companyId: user.companyId! },
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

  const acc = await prisma.$transaction(async (tx) => {
    const created = await tx.accommodation.create({
      data: {
        companyId:    user.companyId!,
        teamId,
        createdById:  user.id,
        startDate:    pending.startDate!,
        endDate:      pending.endDate!,
        address:      finalAddress,
        city:         pending.city         || null,
        zipCode:      pending.zipCode      || null,
        doorCode:     pending.doorCode     || null,
        contactName:  pending.contactName  || null,
        contactPhone: pending.contactPhone || null,
        notes:        notesValue,
      },
    })

    await tx.pendingAccommodation.update({
      where: { id },
      data:  {
        status:          "CONFIRMED",
        accommodationId: created.id,
        confirmedById:   user.id,
        confirmedAt:     new Date(),
      },
    })

    if (userIds.length > 0) {
      await tx.notification.createMany({
        data: userIds.map((uid) => ({
          userId:    uid,
          companyId: user.companyId!,
          type:      "ACCOMMODATION_CREATED" as const,
          title:     `Logement réservé — ${team.name}`,
          message:   `Un logement a été réservé pour votre équipe du ${startLabel} au ${endLabel}.`,
          link:      "/planning/moi",
        })),
      })
    }

    return created
  })

  // Emails fire-and-forget
  const company = await prisma.company.findUnique({
    where: { id: user.companyId! },
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

  void acc
  revalidatePath("/logements")
  revalidatePath("/planning/moi")
  return { success: true }
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
