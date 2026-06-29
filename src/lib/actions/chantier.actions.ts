"use server"

import { revalidatePath } from "next/cache"
import { prisma } from "@/lib/prisma"
import { auth } from "@/auth"
import { createChantierSchema, updateChantierSchema, extendChantierSchema } from "@/lib/validations/chantier"
import { sendAssignmentCreatedEmail, sendAssignmentConfirmedEmail, sendAssignmentRefusedEmail } from "@/lib/email"

async function requireAdmin() {
  const session = await auth()
  if (!session?.user) throw new Error("Non authentifié")
  if (!["ADMIN", "SUPER_ADMIN", "TEAM_LEADER"].includes(session.user.role)) throw new Error("Accès refusé")
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

// ─── Modifier un chantier ────────────────────────────────────────────────────

export async function updateChantier(worksiteId: string, formData: FormData) {
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

  const parsed = updateChantierSchema.safeParse(raw)
  if (!parsed.success) return { error: parsed.error.errors[0].message }

  const worksite = await prisma.worksite.findFirst({
    where: { id: worksiteId, companyId: user.companyId! },
  })
  if (!worksite) return { error: "Chantier introuvable." }

  const client = await prisma.client.findFirst({
    where: { id: parsed.data.clientId, companyId: user.companyId! },
  })
  if (!client) return { error: "Client introuvable." }

  let latitude: number | null = worksite.latitude
  let longitude: number | null = worksite.longitude
  if (parsed.data.address && parsed.data.address !== worksite.address) {
    try {
      const geoRes = await fetch(
        `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(parsed.data.address)}&format=json&limit=1`,
        { headers: { "User-Agent": "Planificator/1.0" } }
      )
      const geoData = await geoRes.json()
      if (geoData[0]) {
        latitude  = parseFloat(geoData[0].lat)
        longitude = parseFloat(geoData[0].lon)
      }
    } catch { /* géocodage non bloquant */ }
  }

  await prisma.worksite.update({
    where: { id: worksiteId },
    data: {
      name:        parsed.data.name,
      description: parsed.data.description || null,
      address:     parsed.data.address     || null,
      clientId:    parsed.data.clientId,
      startDate:   new Date(parsed.data.startDate),
      endDate:     new Date(parsed.data.endDate),
      dailyHours:  parsed.data.dailyHours,
      latitude,
      longitude,
    },
  })

  revalidatePath("/chantiers")
  revalidatePath(`/chantiers/${worksiteId}`)
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

// ─── Affecter une équipe à un chantier pour une plage de dates ───────────────

export async function affecterEquipe(formData: FormData) {
  const user = await requireAdmin()

  const worksiteId  = formData.get("worksiteId")  as string
  const teamId      = formData.get("teamId")      as string
  const dateFromStr = formData.get("dateFrom")    as string
  const dateToStr   = formData.get("dateTo")      as string

  if (!worksiteId || !teamId || !dateFromStr) {
    return { error: "Informations manquantes." }
  }

  const dateFrom = new Date(dateFromStr); dateFrom.setHours(0, 0, 0, 0)
  const dateTo   = dateToStr ? new Date(dateToStr) : new Date(dateFrom)
  dateTo.setHours(0, 0, 0, 0)

  if (dateTo < dateFrom) return { error: "La date de fin doit être après la date de début." }

  // Construire la liste des jours de la plage
  const dates: Date[] = []
  const cursor = new Date(dateFrom)
  while (cursor <= dateTo) {
    dates.push(new Date(cursor))
    cursor.setDate(cursor.getDate() + 1)
  }

  // Vérifier que le chantier appartient à l'entreprise
  const worksite = await prisma.worksite.findFirst({
    where: { id: worksiteId, companyId: user.companyId! },
  })
  if (!worksite) return { error: "Chantier introuvable." }

  // Vérifier que l'équipe appartient à l'entreprise
  const team = await prisma.team.findFirst({
    where: { id: teamId, companyId: user.companyId! },
    include: {
      members: { where: { leftAt: null }, select: { employeeId: true } },
      leader:  { select: { userId: true } },
    },
  })
  if (!team) return { error: "Équipe introuvable." }

  const memberIds = team.members.map((m) => m.employeeId)

  // Vérifier les conflits sur toute la plage
  const conflitEquipe = await prisma.assignment.findFirst({
    where: { teamId, date: { in: dates } },
  })
  if (conflitEquipe) {
    const d = new Intl.DateTimeFormat("fr-FR", { day: "2-digit", month: "long" }).format(conflitEquipe.date)
    return { error: `Cette équipe est déjà affectée le ${d}.` }
  }

  if (memberIds.length > 0) {
    const conflitsEmployes = await prisma.employeeAssignment.findMany({
      where: { employeeId: { in: memberIds }, date: { in: dates } },
      include: {
        employee:   { select: { firstName: true, lastName: true } },
        assignment: { select: { worksite: { select: { name: true } }, team: { select: { name: true } } } },
      },
      orderBy: [{ employeeId: "asc" }, { date: "asc" }],
    })
    if (conflitsEmployes.length > 0) {
      const fmt = new Intl.DateTimeFormat("fr-FR", { day: "2-digit", month: "long" })
      const lignes = conflitsEmployes.map((c) => {
        const nom = `${c.employee.firstName} ${c.employee.lastName}`
        return `${nom} est affecté le ${fmt.format(c.date)} au chantier « ${c.assignment.worksite.name} » avec l'équipe ${c.assignment.team.name}.`
      })
      return {
        error: `${lignes.join("\n")}\nDésaffectez-${conflitsEmployes.length > 1 ? "les" : "le"} avant de réaffecter l'équipe.`,
      }
    }
  }

  // Créer une affectation par jour
  try { await prisma.$transaction(async (tx) => {
    for (const date of dates) {
      const assignment = await tx.assignment.create({
        data: { worksiteId, teamId, date, status: "PENDING" },
      })
      if (memberIds.length > 0) {
        await tx.employeeAssignment.createMany({
          data: memberIds.map((employeeId) => ({
            assignmentId: assignment.id,
            employeeId,
            date,
          })),
        })
      }
    }

    // Passer le chantier en IN_PROGRESS si encore PLANNED
    if (worksite.status === "PLANNED") {
      await tx.worksite.update({
        where: { id: worksiteId },
        data: { status: "IN_PROGRESS" },
      })
    }

    // Notifier le chef d'équipe (une seule notification pour toute la plage)
    if (team.leader?.userId) {
      const fromLabel = new Intl.DateTimeFormat("fr-FR", { day: "2-digit", month: "long" }).format(dateFrom)
      const toLabel   = new Intl.DateTimeFormat("fr-FR", { day: "2-digit", month: "long" }).format(dateTo)
      const rangeLabel = dates.length === 1 ? fromLabel : `du ${fromLabel} au ${toLabel}`

      await tx.notification.create({
        data: {
          userId:    team.leader.userId,
          companyId: user.companyId!,
          type:      "ASSIGNMENT_CREATED",
          title:     `Nouvelle affectation — ${worksite.name}`,
          message:   `Votre équipe est affectée ${rangeLabel}. Confirmez ou refusez.`,
          link:      `/planning`,
        },
      })

      const leaderUser = await tx.user.findUnique({
        where:  { id: team.leader.userId },
        select: { email: true, name: true },
      })
      if (leaderUser?.email) {
        const company = await tx.company.findUnique({ where: { id: user.companyId! }, select: { name: true } })
        sendAssignmentCreatedEmail({
          to:             leaderUser.email,
          teamLeaderName: leaderUser.name ?? leaderUser.email,
          worksiteName:   worksite.name,
          dateLabel:      rangeLabel,
          companyName:    company?.name ?? "",
        }).catch(() => {})
      }
    }
  }) } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error("[affecterEquipe] transaction error:", msg)
    return { error: "Erreur lors de la création des affectations. Veuillez réessayer." }
  }

  revalidatePath("/chantiers")
  revalidatePath(`/chantiers/${worksiteId}`)
  revalidatePath("/planning")
  return { success: true, count: dates.length }
}

// ─── Décaler un chantier ────────────────────────────────────────────────────

export async function decalerChantier(worksiteId: string, formData: FormData) {
  const user = await requireAdmin()

  const delayedUntilStr = formData.get("delayedUntil") as string
  if (!delayedUntilStr) return { error: "Veuillez saisir une date de décalage." }

  const worksite = await prisma.worksite.findFirst({
    where: { id: worksiteId, companyId: user.companyId! },
  })
  if (!worksite) return { error: "Chantier introuvable." }

  const delayedUntil = new Date(delayedUntilStr)
  if (delayedUntil <= new Date()) return { error: "La date de décalage doit être dans le futur." }

  await prisma.worksite.update({
    where: { id: worksiteId },
    data: { status: "DELAYED", delayedUntil },
  })

  revalidatePath("/chantiers")
  revalidatePath(`/chantiers/${worksiteId}`)
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
      // date needed for email label
    },
  })

  // Notifier les admins de l'entreprise
  const admins = await prisma.user.findMany({
    where: { companyId: assignment.worksite.companyId, role: { in: ["ADMIN", "SUPER_ADMIN"] } },
    select: { id: true, email: true },
  })

  const isConfirmed = status === "CONFIRMED"
  const dateLabel   = new Intl.DateTimeFormat("fr-FR", { weekday: "long", day: "2-digit", month: "long" }).format(assignment.date)

  if (admins.length > 0) {
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

    // Emails aux admins
    for (const admin of admins) {
      if (!admin.email) continue
      if (isConfirmed) {
        sendAssignmentConfirmedEmail({
          to: admin.email, teamName: assignment.team.name,
          worksiteName: assignment.worksite.name, dateLabel,
          worksiteId: assignment.worksite.id,
        }).catch(() => {})
      } else {
        sendAssignmentRefusedEmail({
          to: admin.email, teamName: assignment.team.name,
          worksiteName: assignment.worksite.name, dateLabel,
          refusalReason, worksiteId: assignment.worksite.id,
        }).catch(() => {})
      }
    }
  }

  revalidatePath("/chantiers")
  revalidatePath("/planning")
  return { success: true }
}

// ─── Supprimer un chantier ───────────────────────────────────────────────────

export async function deleteChantier(worksiteId: string) {
  const user = await requireAdmin()

  const worksite = await prisma.worksite.findFirst({
    where: { id: worksiteId, companyId: user.companyId! },
    select: { id: true },
  })
  if (!worksite) return { error: "Chantier introuvable." }

  await prisma.worksite.delete({ where: { id: worksiteId } })

  revalidatePath("/chantiers")
  revalidatePath("/planning")
  return { success: true }
}

// ─── Supprimer une plage d'affectation d'une équipe ─────────────────────────

export async function deleteAssignmentBlock(
  worksiteId: string,
  teamId: string,
  startDate: string,
  endDate: string
) {
  const user = await requireAdmin()

  const worksite = await prisma.worksite.findFirst({
    where: { id: worksiteId, companyId: user.companyId! },
    select: { id: true },
  })
  if (!worksite) return { error: "Chantier introuvable." }

  await prisma.assignment.deleteMany({
    where: {
      worksiteId,
      teamId,
      date: {
        gte: new Date(startDate),
        lte: new Date(endDate),
      },
    },
  })

  revalidatePath(`/chantiers/${worksiteId}`)
  revalidatePath("/planning")
  return { success: true }
}

export async function removeEmployeeFromAssignment(assignmentId: string, employeeId: string) {
  const session = await auth()
  if (!session?.user || !["ADMIN", "SUPER_ADMIN", "TEAM_LEADER"].includes(session.user.role)) {
    return { error: "Non autorisé" }
  }

  const assignment = await prisma.assignment.findFirst({
    where: { id: assignmentId, worksite: { companyId: session.user.companyId! } },
    select: { worksiteId: true },
  })
  if (!assignment) return { error: "Affectation introuvable" }

  await prisma.employeeAssignment.deleteMany({
    where: { assignmentId, employeeId },
  })

  revalidatePath(`/chantiers/${assignment.worksiteId}`)
  revalidatePath("/planning")
  return { success: true }
}

// ─── Retirer un employé de toutes les affectations d'un bloc ─────────────────

export async function removeEmployeeFromBlock(
  worksiteId: string,
  teamId: string,
  startDate: string,
  endDate: string,
  employeeId: string,
) {
  const session = await auth()
  if (!session?.user || !["ADMIN", "SUPER_ADMIN", "TEAM_LEADER"].includes(session.user.role)) {
    return { error: "Non autorisé" }
  }

  const isSuperAdmin = session.user.role === "SUPER_ADMIN"

  const worksite = await prisma.worksite.findFirst({
    where: {
      id: worksiteId,
      ...(isSuperAdmin ? {} : { companyId: session.user.companyId! }),
    },
    select: { id: true },
  })
  if (!worksite) return { error: "Chantier introuvable" }

  const assignments = await prisma.assignment.findMany({
    where: {
      worksiteId,
      teamId,
      date: { gte: new Date(startDate), lte: new Date(endDate) },
    },
    select: { id: true },
  })

  await prisma.employeeAssignment.deleteMany({
    where: { assignmentId: { in: assignments.map((a) => a.id) }, employeeId },
  })

  revalidatePath(`/chantiers/${worksiteId}`)
  revalidatePath("/planning")
  return { success: true }
}

export async function addEmployeeToBlock(
  worksiteId: string,
  teamId: string,
  startDate: string,
  endDate: string,
  employeeId: string,
) {
  const session = await auth()
  if (!session?.user || !["ADMIN", "SUPER_ADMIN"].includes(session.user.role)) {
    return { error: "Non autorisé" }
  }

  const isSuperAdmin = session.user.role === "SUPER_ADMIN"

  const worksite = await prisma.worksite.findFirst({
    where: {
      id: worksiteId,
      ...(isSuperAdmin ? {} : { companyId: session.user.companyId! }),
    },
    select: { id: true },
  })
  if (!worksite) return { error: "Chantier introuvable" }

  const assignments = await prisma.assignment.findMany({
    where: {
      worksiteId,
      teamId,
      date: { gte: new Date(startDate), lte: new Date(endDate) },
    },
    select: { id: true, date: true },
  })

  // Créer les EmployeeAssignment un par un en ignorant les conflits (employé déjà affecté ce jour-là)
  let added = 0
  const skippedDates: Date[] = []
  for (const assignment of assignments) {
    try {
      await prisma.employeeAssignment.create({
        data: { assignmentId: assignment.id, employeeId, date: assignment.date },
      })
      added++
    } catch {
      // Conflit unique (employé déjà sur un autre chantier ce jour) — on note la date
      skippedDates.push(assignment.date)
    }
  }

  // Pour les jours ignorés, retrouver OÙ l'employé est déjà affecté (chantier + équipe)
  const conflicts: { iso: string; date: string; worksiteName: string; teamName: string }[] = []
  if (skippedDates.length > 0) {
    const existing = await prisma.employeeAssignment.findMany({
      where: { employeeId, date: { in: skippedDates } },
      include: {
        assignment: { select: { worksite: { select: { name: true } }, team: { select: { name: true } } } },
      },
      orderBy: { date: "asc" },
    })
    for (const ea of existing) {
      conflicts.push({
        iso: ea.date.toISOString().slice(0, 10),
        date: new Intl.DateTimeFormat("fr-FR", { day: "2-digit", month: "long" }).format(ea.date),
        worksiteName: ea.assignment.worksite.name,
        teamName: ea.assignment.team.name,
      })
    }
  }

  revalidatePath(`/chantiers/${worksiteId}`)
  revalidatePath("/planning")
  return { success: true, added, skipped: skippedDates.length, conflicts }
}
