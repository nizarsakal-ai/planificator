"use server"

import { revalidatePath } from "next/cache"
import { prisma } from "@/lib/prisma"
import { auth } from "@/auth"
import { createEquipeSchema, updateEquipeSchema } from "@/lib/validations/equipe"

async function requireAdmin() {
  const session = await auth()
  if (!session?.user) throw new Error("Non authentifié")
  if (!["ADMIN", "SUPER_ADMIN"].includes(session.user.role)) throw new Error("Accès refusé")
  if (!session.user.companyId) throw new Error("Entreprise introuvable")
  return session.user
}

// ─── Créer une équipe ────────────────────────────────────────────────────────

export async function createEquipe(formData: FormData) {
  const user = await requireAdmin()

  const memberIds = formData.getAll("memberIds") as string[]

  const raw = {
    name: formData.get("name") as string,
    color: formData.get("color") as string,
    leaderId: formData.get("leaderId") as string,
    memberIds,
  }

  const parsed = createEquipeSchema.safeParse(raw)
  if (!parsed.success) return { error: parsed.error.errors[0].message }

  const { name, color, leaderId, memberIds: members } = parsed.data

  // Vérifier doublon de nom dans la même entreprise
  const existing = await prisma.team.findFirst({
    where: { name, companyId: user.companyId! },
  })
  if (existing) return { error: "Une équipe avec ce nom existe déjà." }

  // Vérifier que le chef d'équipe appartient à l'entreprise
  const leader = await prisma.employee.findFirst({
    where: { id: leaderId, companyId: user.companyId! },
  })
  if (!leader) return { error: "Chef d'équipe introuvable." }

  // Mettre à jour le rôle du chef d'équipe
  await prisma.user.update({
    where: { id: leader.userId },
    data: { role: "TEAM_LEADER" },
  })

  // Créer l'équipe + membres en une transaction
  await prisma.$transaction(async (tx) => {
    const team = await tx.team.create({
      data: {
        name,
        color: color || "#0f3460",
        companyId: user.companyId!,
        leaderId,
      },
    })

    // Ajouter le chef comme membre + les autres membres sélectionnés
    const allMemberIds = Array.from(new Set([leaderId, ...(members ?? [])]))
    await tx.teamMember.createMany({
      data: allMemberIds.map((empId) => ({
        teamId: team.id,
        employeeId: empId,
      })),
      skipDuplicates: true,
    })
  })

  revalidatePath("/equipes")
  return { success: true }
}

// ─── Modifier le chef d'équipe ───────────────────────────────────────────────

export async function updateEquipeLeader(teamId: string, newLeaderId: string) {
  const user = await requireAdmin()

  const team = await prisma.team.findFirst({
    where: { id: teamId, companyId: user.companyId! },
    include: { leader: true },
  })
  if (!team) return { error: "Équipe introuvable." }

  const newLeader = await prisma.employee.findFirst({
    where: { id: newLeaderId, companyId: user.companyId! },
  })
  if (!newLeader) return { error: "Employé introuvable." }

  await prisma.$transaction([
    // Nouveau chef → TEAM_LEADER
    prisma.user.update({
      where: { id: newLeader.userId },
      data: { role: "TEAM_LEADER" },
    }),
    // Ancien chef → EMPLOYEE (si pas chef d'une autre équipe)
    prisma.user.update({
      where: { id: team.leader.userId },
      data: { role: "EMPLOYEE" },
    }),
    // Mettre à jour l'équipe
    prisma.team.update({
      where: { id: teamId },
      data: { leaderId: newLeaderId },
    }),
  ])

  revalidatePath("/equipes")
  return { success: true }
}

// ─── Ajouter un membre ───────────────────────────────────────────────────────

export async function addMembre(teamId: string, employeeId: string) {
  const user = await requireAdmin()

  const team = await prisma.team.findFirst({
    where: { id: teamId, companyId: user.companyId! },
  })
  if (!team) return { error: "Équipe introuvable." }

  const employee = await prisma.employee.findFirst({
    where: { id: employeeId, companyId: user.companyId! },
  })
  if (!employee) return { error: "Employé introuvable." }

  // Si l'employé avait quitté l'équipe, on le réintègre
  const existing = await prisma.teamMember.findFirst({
    where: { teamId, employeeId },
  })

  if (existing) {
    await prisma.teamMember.update({
      where: { id: existing.id },
      data: { leftAt: null, joinedAt: new Date() },
    })
  } else {
    await prisma.teamMember.create({
      data: { teamId, employeeId },
    })
  }

  revalidatePath("/equipes")
  return { success: true }
}

// ─── Retirer un membre ───────────────────────────────────────────────────────

export async function removeMembre(teamId: string, employeeId: string) {
  const user = await requireAdmin()

  const team = await prisma.team.findFirst({
    where: { id: teamId, companyId: user.companyId! },
  })
  if (!team) return { error: "Équipe introuvable." }

  // On ne peut pas retirer le chef d'équipe
  if (team.leaderId === employeeId) {
    return { error: "Impossible de retirer le chef d'équipe. Changez le chef d'abord." }
  }

  await prisma.teamMember.updateMany({
    where: { teamId, employeeId, leftAt: null },
    data: { leftAt: new Date() },
  })

  revalidatePath("/equipes")
  return { success: true }
}

// ─── Archiver une équipe ─────────────────────────────────────────────────────

export async function archiveEquipe(teamId: string) {
  const user = await requireAdmin()

  const team = await prisma.team.findFirst({
    where: { id: teamId, companyId: user.companyId! },
  })
  if (!team) return { error: "Équipe introuvable." }

  await prisma.team.update({
    where: { id: teamId },
    data: { active: false },
  })

  revalidatePath("/equipes")
  return { success: true }
}
