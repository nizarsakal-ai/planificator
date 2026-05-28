"use server"

import { revalidatePath } from "next/cache"
import { prisma } from "@/lib/prisma"
import { auth } from "@/auth"
import { createChantierSchema, extendChantierSchema } from "@/lib/validations/chantier"

async function requireAdmin() {
  const session = await auth()
  if (!session?.user) throw new Error("Non authentifié")
  if (!["ADMIN", "SUPER_ADMIN"].includes(session.user.role)) throw new Error("Accès refusé")
  if (!session.user.companyId) throw new Error("Entreprise introuvable")
  return session.user
}

// ─── Créer un chantier ───────────────────────────────────────────────────────

export async function createChantier(formData: FormData) {
  const user = await requireAdmin()

  const raw = {
    name:        formData.get("name")        as string,
    description: formData.get("description") as string,
    address:     formData.get("address")     as string,
    clientId:    formData.get("clientId")    as string,
    startDate:   formData.get("startDate")   as string,
    endDate:     formData.get("endDate")     as string,
    dailyHours:  formData.get("dailyHours")  as string,
  }

  const parsed = createChantierSchema.safeParse(raw)
  if (!parsed.success) return { error: parsed.error.errors[0].message }

  // Vérifier que le client appartient à cette entreprise
  const client = await prisma.client.findFirst({
    where: { id: parsed.data.clientId, companyId: user.companyId! },
  })
  if (!client) return { error: "Client introuvable." }

  // Géocodage de l'adresse via Nominatim (OpenStreetMap)
  let latitude: number | null = null
  let longitude: number | null = null
  if (parsed.data.address) {
    try {
      const geoRes = await fetch(
        `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(parsed.data.address)}&format=json&limit=1`,
        { headers: { "User-Agent": "Planificator/1.0" } }
      )
      const geoData = await geoRes.json()
      if (geoData.length > 0) {
        latitude  = parseFloat(geoData[0].lat)
        longitude = parseFloat(geoData[0].lon)
      }
    } catch {
      // Géocodage échoué, on continue sans coordonnées
    }
  }

  await prisma.worksite.create({
    data: {
      name:        parsed.data.name,
      description: parsed.data.description || null,
      address:     parsed.data.address || null,
      clientId:    parsed.data.clientId,
      companyId:   user.companyId!,
      createdById: user.id,
      startDate:   new Date(parsed.data.startDate),
      endDate:     new Date(parsed.data.endDate),
      dailyHours:  parsed.data.dailyHours,
      status:      "PLANNED",
      latitude,
      longitude,
    },
  })

  revalidatePath("/chantiers")
  return { success: true }
}

// ─── Changer le statut ───────────────────────────────────────────────────────

export async function updateChantierStatus(
  worksiteId: string,
  status: "PLANNED" | "IN_PROGRESS" | "COMPLETED" | "ARCHIVED"
) {
  const user = await requireAdmin()

  const worksite = await prisma.worksite.findFirst({
    where: { id: worksiteId, companyId: user.companyId! },
  })
  if (!worksite) return { error: "Chantier introuvable." }

  const data: Record<string, unknown> = { status }
  if (status === "COMPLETED") data.completedAt = new Date()
  if (status === "ARCHIVED")  data.archivedAt  = new Date()

  await prisma.worksite.update({ where: { id: worksiteId }, data })

  revalidatePath("/chantiers")
  revalidatePath(`/chantiers/${worksiteId}`)
  return { success: true }
}

// ─── Prolonger un chantier ───────────────────────────────────────────────────

export async function prolongerChantier(worksiteId: string, formData: FormData) {
  const user = await requireAdmin()

  const raw = {
    newEndDate: formData.get("newEndDate") as string,
    reason:     formData.get("reason")     as string,
  }

  const parsed = extendChantierSchema.safeParse(raw)
  if (!parsed.success) return { error: parsed.error.errors[0].message }

  const worksite = await prisma.worksite.findFirst({
    where: { id: worksiteId, companyId: user.companyId! },
  })
  if (!worksite) return { error: "Chantier introuvable." }

  const newEndDate = new Date(parsed.data.newEndDate)
  if (newEndDate <= worksite.endDate) {
    return { error: "La nouvelle date doit être après la date de fin actuelle." }
  }

  await prisma.$transaction([
    // Enregistrer l'extension
    prisma.extension.create({
      data: {
        worksiteId,
        previousEndDate: worksite.endDate,
        newEndDate,
        reason:     parsed.data.reason || null,
        createdById: user.id,
      },
    }),
    // Mettre à jour le chantier
    prisma.worksite.update({
      where: { id: worksiteId },
      data: { endDate: newEndDate, status: "EXTENDED" },
    }),
  ])

  revalidatePath("/chantiers")
  revalidatePath(`/chantiers/${worksiteId}`)
  return { success: true }
}

// ─── Affecter une équipe à un chantier pour une date ─────────────────────────

export async function affecterEquipe(formData: FormData) {
  const user = await requireAdmin()

  const worksiteId = formData.get("worksiteId") as string
  const teamId     = formData.get("teamId")     as string
  const dateStr    = formData.get("date")       as string

  if (!worksiteId || !teamId || !dateStr) {
    return { error: "Informations manquantes." }
  }

  const date = new Date(dateStr)
  date.setHours(0, 0, 0, 0)

  // Vérifier que le chantier appartient à l'entreprise
  const worksite = await prisma.worksite.findFirst({
    where: { id: worksiteId, companyId: user.companyId! },
  })
  if (!worksite) return { error: "Chantier introuvable." }

  // Vérifier que l'équipe appartient à l'entreprise
  const team = await prisma.team.findFirst({
    where: { id: teamId, companyId: user.companyId! },
    include: {
      members: {
        where: { leftAt: null },
        select: { employeeId: true },
      },
      leader: { select: { userId: true } },
    },
  })
  if (!team) return { error: "Équipe introuvable." }

  // Vérifier contrainte : équipe déjà affectée ce jour-là ?
  const conflitEquipe = await prisma.assignment.findFirst({
    where: { teamId, date },
  })
  if (conflitEquipe) {
    return { error: "Cette équipe est déjà affectée à un chantier ce jour-là." }
  }

  // Vérifier contrainte : un employé déjà affecté ce jour-là ?
  const memberIds = team.members.map((m) => m.employeeId)
  const conflitEmploye = await prisma.employeeAssignment.findFirst({
    where: { employeeId: { in: memberIds }, date },
  })
  if (conflitEmploye) {
    return { error: "Un ou plusieurs membres de cette équipe sont déjà affectés ce jour-là." }
  }

  // Créer l'affectation
  await prisma.$transaction(async (tx) => {
    const assignment = await tx.assignment.create({
      data: { worksiteId, teamId, date, status: "PENDING" },
    })

    // Affecter individuellement chaque membre
    await tx.employeeAssignment.createMany({
      data: memberIds.map((employeeId) => ({
        assignmentId: assignment.id,
        employeeId,
        date,
      })),
    })

    // Passer le chantier en IN_PROGRESS si encore PLANNED
    if (worksite.status === "PLANNED") {
      await tx.worksite.update({
        where: { id: worksiteId },
        data: { status: "IN_PROGRESS" },
      })
    }

    // Notifier le chef d'équipe
    if (team.leader?.userId) {
      const dateLabel = new Intl.DateTimeFormat("fr-FR", { weekday: "long", day: "2-digit", month: "long" }).format(date)
      await tx.notification.create({
        data: {
          userId:    team.leader.userId,
          companyId: user.companyId!,
          type:      "ASSIGNMENT_CREATED",
          title:     `Nouvelle affectation — ${worksite.name}`,
          message:   `Votre équipe est affectée le ${dateLabel}. Confirmez ou refusez.`,
          link:      `/planning`,
        },
      })
    }
  })

  revalidatePath("/chantiers")
  revalidatePath(`/chantiers/${worksiteId}`)
  revalidatePath("/planning")
  return { success: true }
}

// ─── Confirmer ou refuser une affectation ────────────────────────────────────

export async function updateAssignmentStatus(
  assignmentId: string,
  status: "CONFIRMED" | "REFUSED",
  refusalReason?: string
) {
  const session = await auth()
  if (!session?.user) throw new Error("Non authentifié")

  if (status === "REFUSED" && !refusalReason?.trim()) {
    return { error: "La raison du refus est obligatoire." }
  }

  const assignment = await prisma.assignment.update({
    where: { id: assignmentId },
    data: { status, refusalReason: refusalReason || null },
    include: {
      worksite: { select: { id: true, name: true, companyId: true } },
      team:     { select: { name: true } },
    },
  })

  // Notifier les admins de l'entreprise
  const admins = await prisma.user.findMany({
    where: { companyId: assignment.worksite.companyId, role: { in: ["ADMIN", "SUPER_ADMIN"] } },
    select: { id: true },
  })
  if (admins.length > 0) {
    const isConfirmed = status === "CONFIRMED"
    await prisma.notification.createMany({
      data: admins.map((admin) => ({
        userId:    admin.id,
        companyId: assignment.worksite.companyId,
        type:      isConfirmed ? ("ASSIGNMENT_CONFIRMED" as const) : ("ASSIGNMENT_REFUSED" as const),
        title:     isConfirmed
          ? `Affectation confirmée — ${assignment.worksite.name}`
          : `Affectation refusée — ${assignment.worksite.name}`,
        message: isConfirmed
          ? `L'équipe ${assignment.team.name} a confirmé l'affectation.`
          : `L'équipe ${assignment.team.name} a refusé l'affectation.${refusalReason ? ` Raison : ${refusalReason}` : ""}`,
        link: `/chantiers/${assignment.worksite.id}`,
      })),
    })
  }

  revalidatePath("/chantiers")
  revalidatePath("/planning")
  return { success: true }
}
