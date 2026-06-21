import { NextResponse } from "next/server"
import { auth } from "@/auth"
import { prisma } from "@/lib/prisma"

export async function PATCH(req: Request, context: { params: Promise<{ id: string }> }) {
  const session = await auth()
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const { teamId, matricule } = await req.json()
  if (teamId) {
    await prisma.truck.updateMany({
      where: { teamId, companyId: session.user.companyId! },
      data: { teamId: null },
    })
  }
  const truck = await prisma.truck.update({
    where: { id: (await context.params).id },
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
  await prisma.truck.delete({ where: { id: (await context.params).id } })
  return NextResponse.json({ ok: true })
}
