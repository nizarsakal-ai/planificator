import { NextResponse } from "next/server"
import { auth } from "@/auth"
import { prisma } from "@/lib/prisma"

export async function PATCH(req: Request, context: { params: Promise<{ id: string }> }) {
  const session = await auth()
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  if (!["ADMIN", "SUPER_ADMIN", "TEAM_LEADER"].includes(session.user.role))
    return NextResponse.json({ error: "Accès refusé" }, { status: 403 })
  const companyId = session.user.companyId!
  const id = (await context.params).id
  const existing = await prisma.truck.findFirst({
    where: { id, companyId },
  })
  if (!existing) return NextResponse.json({ error: "Camion introuvable" }, { status: 404 })
  const { teamId, matricule, marque, chauffeurId } = await req.json()
  if (teamId) {
    const team = await prisma.team.findFirst({
      where: { id: teamId, companyId },
      select: { id: true },
    })
    if (!team) return NextResponse.json({ error: "Équipe introuvable" }, { status: 404 })
  }
  if (chauffeurId) {
    const employee = await prisma.employee.findFirst({
      where: { id: chauffeurId, companyId },
      select: { id: true },
    })
    if (!employee) return NextResponse.json({ error: "Chauffeur introuvable" }, { status: 404 })
  }

  // Nouvelles valeurs effectives après mise à jour
  const nextChauffeurId =
    chauffeurId !== undefined ? chauffeurId || null : existing.chauffeurId
  const nextTeamId = teamId !== undefined ? teamId || null : existing.teamId
  const affectationChanged =
    nextChauffeurId !== existing.chauffeurId || nextTeamId !== existing.teamId

  try {
    const now = new Date()
    const truck = await prisma.$transaction(async (tx) => {
      // Si le camion est réaffecté à une équipe déjà équipée, libérer
      // l'autre camion et clore son historique.
      if (teamId) {
        const displaced = await tx.truck.findFirst({
          where: { teamId, companyId, id: { not: id } },
          select: { id: true, chauffeurId: true },
        })
        if (displaced) {
          await tx.truck.update({ where: { id: displaced.id }, data: { teamId: null } })
          await tx.truckAssignment.updateMany({
            where: { truckId: displaced.id, endedAt: null },
            data: { endedAt: now },
          })
          await tx.truckAssignment.create({
            data: {
              truckId: displaced.id,
              chauffeurId: displaced.chauffeurId,
              teamId: null,
              companyId,
              startedAt: now,
            },
          })
        }
      }

      const updated = await tx.truck.update({
        where: { id },
        data: {
          ...(matricule !== undefined && { matricule: String(matricule).toUpperCase() }),
          ...(marque !== undefined && { marque: marque?.trim() || null }),
          ...(chauffeurId !== undefined && { chauffeurId: chauffeurId || null }),
          ...(teamId !== undefined && { teamId: teamId || null }),
        },
      })

      // Journal : clore la période en cours et en ouvrir une nouvelle
      // reflétant l'état (chauffeur + équipe) après modification.
      if (affectationChanged) {
        await tx.truckAssignment.updateMany({
          where: { truckId: id, endedAt: null },
          data: { endedAt: now },
        })
        await tx.truckAssignment.create({
          data: {
            truckId: id,
            chauffeurId: nextChauffeurId,
            teamId: nextTeamId,
            companyId,
            startedAt: now,
          },
        })
      }

      return updated
    })
    return NextResponse.json(truck)
  } catch {
    return NextResponse.json({ error: "Matricule déjà existant" }, { status: 400 })
  }
}

export async function DELETE(_req: Request, context: { params: Promise<{ id: string }> }) {
  const session = await auth()
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  if (!["ADMIN", "SUPER_ADMIN"].includes(session.user.role))
    return NextResponse.json({ error: "Accès refusé" }, { status: 403 })
  const id = (await context.params).id
  const { count } = await prisma.truck.deleteMany({
    where: { id, companyId: session.user.companyId! },
  })
  if (count === 0) return NextResponse.json({ error: "Camion introuvable" }, { status: 404 })
  return NextResponse.json({ ok: true })
}
