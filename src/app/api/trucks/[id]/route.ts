import { NextResponse } from "next/server"
import { auth } from "@/auth"
import { prisma } from "@/lib/prisma"

export async function PATCH(req: Request, context: { params: Promise<{ id: string }> }) {
  const session = await auth()
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const id = (await context.params).id
  const existing = await prisma.truck.findFirst({
    where: { id, companyId: session.user.companyId! },
  })
  if (!existing) return NextResponse.json({ error: "Camion introuvable" }, { status: 404 })
  const { teamId, matricule } = await req.json()
  if (teamId) {
    await prisma.truck.updateMany({
      where: { teamId, companyId: session.user.companyId! },
      data: { teamId: null },
    })
  }
  const truck = await prisma.truck.update({
    where: { id },
    data: {
      ...(matricule !== undefined && { matricule: matricule.toUpperCase() }),
      ...(teamId !== undefined && { teamId: teamId || null }),
    },
  })
  return NextResponse.json(truck)
}

export async function DELETE(_req: Request, context: { params: Promise<{ id: string }> }) {
  const session = await auth()
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const id = (await context.params).id
  const { count } = await prisma.truck.deleteMany({
    where: { id, companyId: session.user.companyId! },
  })
  if (count === 0) return NextResponse.json({ error: "Camion introuvable" }, { status: 404 })
  return NextResponse.json({ ok: true })
}
