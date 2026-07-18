import { NextResponse } from "next/server"
import { auth } from "@/auth"
import { prisma } from "@/lib/prisma"

export async function GET() {
  const session = await auth()
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const trucks = await prisma.truck.findMany({
    where: { companyId: session.user.companyId! },
    orderBy: { matricule: "asc" },
  })
  return NextResponse.json(trucks)
}

export async function POST(req: Request) {
  const session = await auth()
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  if (!["ADMIN", "SUPER_ADMIN", "TEAM_LEADER"].includes(session.user.role))
    return NextResponse.json({ error: "Accès refusé" }, { status: 403 })
  const { matricule, marque } = await req.json()
  if (!matricule) return NextResponse.json({ error: "Matricule requis" }, { status: 400 })
  try {
    const truck = await prisma.truck.create({
      data: {
        matricule: matricule.toUpperCase(),
        marque: marque?.trim() || null,
        companyId: session.user.companyId!,
      },
    })
    return NextResponse.json(truck)
  } catch {
    return NextResponse.json({ error: "Matricule deja existant" }, { status: 400 })
  }
}
