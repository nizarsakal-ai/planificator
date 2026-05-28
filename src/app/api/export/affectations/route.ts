import { NextRequest, NextResponse } from "next/server"
import { auth } from "@/auth"
import { prisma } from "@/lib/prisma"
import * as XLSX from "xlsx"

export const runtime = "nodejs"

const STATUS_LABELS: Record<string, string> = {
  CONFIRMED: "Confirmé",
  PENDING:   "En attente",
  REFUSED:   "Refusé",
}

export async function GET(req: NextRequest) {
  const session = await auth()
  if (!session?.user || !["ADMIN", "SUPER_ADMIN"].includes(session.user.role)) {
    return new NextResponse("Non autorisé", { status: 401 })
  }

  const { searchParams } = new URL(req.url)
  const from    = searchParams.get("from")
  const to      = searchParams.get("to")
  const teamId  = searchParams.get("teamId")
  const chantierId = searchParams.get("chantierId")

  const where: Record<string, unknown> = {
    worksite: { companyId: session.user.companyId! },
  }
  if (from || to) {
    where.date = {
      ...(from ? { gte: new Date(from) } : {}),
      ...(to   ? { lte: new Date(to)   } : {}),
    }
  }
  if (teamId)    where.teamId     = teamId
  if (chantierId) where.worksiteId = chantierId

  const assignments = await prisma.assignment.findMany({
    where,
    include: {
      team:     { select: { name: true } },
      worksite: { select: { name: true, address: true, client: { select: { name: true } } } },
    },
    orderBy: { date: "asc" },
  })

  const rows = assignments.map((a) => ({
    "Date":          new Intl.DateTimeFormat("fr-FR").format(a.date),
    "Chantier":      a.worksite.name,
    "Client":        a.worksite.client?.name ?? "",
    "Adresse":       a.worksite.address ?? "",
    "Équipe":        a.team.name,
    "Statut":        STATUS_LABELS[a.status] ?? a.status,
    "Raison refus":  a.refusalReason ?? "",
  }))

  const wb  = XLSX.utils.book_new()
  const ws  = XLSX.utils.json_to_sheet(rows)

  // Largeurs colonnes
  ws["!cols"] = [
    { wch: 12 }, { wch: 28 }, { wch: 22 }, { wch: 35 },
    { wch: 20 }, { wch: 14 }, { wch: 30 },
  ]

  XLSX.utils.book_append_sheet(wb, ws, "Affectations")
  const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" })

  const dateStr = new Date().toISOString().split("T")[0]

  return new NextResponse(new Uint8Array(buf), {
    headers: {
      "Content-Type":        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="affectations-${dateStr}.xlsx"`,
    },
  })
}
