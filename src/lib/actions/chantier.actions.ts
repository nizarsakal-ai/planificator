"use server"

import { revalidatePath } from "next/cache"
import { prisma } from "@/lib/prisma"
import { auth } from "@/auth"
import { addEmployeeToBlockCore } from "@/lib/actions/chantier-block.core"
import { createWorksiteCore } from "@/lib/actions/chantier-create.core"
import { assignTeamCore } from "@/lib/actions/assignment-team.core"
import type { CoreResult, WriteActor } from "@/lib/actions/write-actor"
import {
  updateChantierSchema,
  extendChantierSchema,
  updateDateFieldToDb,
} from "@/lib/validations/chantier"
import { sendAssignmentCreatedEmail, sendAssignmentConfirmedEmail, sendAssignmentRefusedEmail } from "@/lib/email"

async function requireAdmin() {
  const session = await auth()
  if (!session?.user) throw new Error("Non authentifié")
  if (!["ADMIN", "SUPER_ADMIN", "TEAM_LEADER"].includes(session.user.role)) throw new Error("Accès refusé")
  if (!session.user.companyId) throw new Error("Entreprise introuvable")
  return session.user
}

// LOT-1W-1a : acteur d'écriture UI (SPEC §5.1) ; `agent` non renseigné dans ce sous-lot.
function writeActorOf(user: { id: string; companyId?: string | null }): WriteActor {
  return { companyId: user.companyId!, actorUserId: user.id }
}

// LOT-1W-1a : message UI porté par `details.message` (byte-identique à BASE_SHA).
function coreErrorMessage(result: Extract<CoreResult<unknown>, { ok: false }>): string {
  const message = result.details?.message
  if (typeof message !== "string") throw new Error(`[chantier.actions] message UI absent pour le code ${result.code}`)
  return message
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

  // LOT-1W-1a : logique dans chantier-create.core.ts ; ports à l'identique de BASE_SHA.
  const result = await createWorksiteCore(raw, writeActorOf(user), {
    findClient: (args) => prisma.client.findFirst(args),
    createWorksite: (args) => prisma.worksite.create(args),
    geocode: async (address) => {
      // Géocodage de l'adresse via Nominatim (OpenStreetMap)
      const { defaultGeocodePort } = await import("@/lib/geo/geocode.port")
      return defaultGeocodePort.geocodeAddress(address)
    },
  })
  if (!result.ok) return { error: coreErrorMessage(result) }

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
    const { defaultGeocodePort } = await import("@/lib/geo/geocode.port")
    const geo = await defaultGeocodePort.geocodeAddress(parsed.data.address)
    if (geo) {
      latitude = geo.latitude
      longitude = geo.longitude
    }
  }

  await prisma.worksite.update({
    where: { id: worksiteId },
    data: {
      name:        parsed.data.name,
      description: parsed.data.description || null,
      address:     parsed.data.address     || null,
      clientId:    parsed.data.clientId,
      startDate:   updateDateFieldToDb(parsed.data.startDate),
      endDate:     updateDateFieldToDb(parsed.data.endDate),
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

  if (!worksite.endDate) {
    return { error: "Impossible de prolonger : dates du chantier non définies." }
  }

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

  // LOT-1W-1a : logique dans assignment-team.core.ts ; requêtes et transaction à l'identique de BASE_SHA.
  const result = await assignTeamCore(
    { worksiteId, teamId, dateFrom: dateFromStr, dateTo: dateToStr },
    writeActorOf(user),
    {
      findWorksite: (args) => prisma.worksite.findFirst(args),
      findTeam: (args) => prisma.team.findFirst(args),
      findTeamConflict: (args) => prisma.assignment.findFirst(args),
      findEmployeeConflicts: (args) => prisma.employeeAssignment.findMany(args),
      transaction: (fn) => prisma.$transaction(fn),
      sendAssignmentCreatedEmail,
    }
  )
  if (!result.ok) {
    if (result.code === "TRANSACTION_FAILED") {
      console.error("[affecterEquipe] transaction error:", result.details?.cause)
    }
    return { error: coreErrorMessage(result) }
  }

  revalidatePath("/chantiers")
  revalidatePath(`/chantiers/${worksiteId}`)
  revalidatePath("/planning")
  return { success: true, count: result.data.assignmentIds.length }
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

  // Lot B (ADR-PLAN-003) : les factures sont des pièces conservées ; un chantier facturé ne se supprime pas.
  const invoiceCount = await prisma.invoice.count({ where: { worksiteId, companyId: user.companyId! } })
  if (invoiceCount > 0) {
    return { error: "Ce chantier a des factures : il ne peut pas être supprimé. Archivez-le plutôt." }
  }

  try {
    await prisma.worksite.delete({ where: { id: worksiteId } })
  } catch (error) {
    // Facture créée entre le contrôle et la suppression : la contrainte Restrict refuse (P2003).
    if (typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "P2003") {
      return { error: "Ce chantier a des factures : il ne peut pas être supprimé. Archivez-le plutôt." }
    }
    throw error
  }

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
  // T2bis (F4) : logique et règles d'isolation dans chantier-block.core.ts.
  return addEmployeeToBlockCore(
    { worksiteId, teamId, startDate, endDate, employeeId },
    {
      auth,
      findWorksite: (where) => prisma.worksite.findFirst({ where, select: { id: true, companyId: true } }),
      findEmployee: (where) => prisma.employee.findFirst({ where, select: { id: true } }),
      findAssignments: (where) => prisma.assignment.findMany({ where, select: { id: true, date: true } }),
      createEmployeeAssignment: (data) => prisma.employeeAssignment.create({ data }),
      findConflicts: (where) =>
        prisma.employeeAssignment.findMany({
          where,
          select: {
            date: true,
            assignment: { select: { worksite: { select: { name: true } }, team: { select: { name: true } } } },
          },
          orderBy: { date: "asc" },
        }),
      revalidate: revalidatePath,
    }
  )
}
