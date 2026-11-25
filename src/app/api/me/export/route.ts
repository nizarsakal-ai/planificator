import { auth } from "@/auth"
import { prisma } from "@/lib/prisma"
import { buildPersonalDataExport, EXPORT_ROW_LIMIT, exportFileName } from "@/lib/account/personal-data-export"

// Lot 2b juridique : « Télécharger mes données ». Uniquement les données du compte connecté (filtre userId/employeeId).
export const dynamic = "force-dynamic"

export async function GET() {
  const session = await auth()
  const userId = session?.user?.id
  if (!userId) return Response.json({ error: "Non authentifié" }, { status: 401 })

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true, name: true, role: true, createdAt: true, lastLoginAt: true },
  })
  if (!user) return Response.json({ error: "Compte introuvable" }, { status: 404 })

  const employees = await prisma.employee.findMany({
    where: { userId },
    select: {
      id: true, firstName: true, lastName: true, phone: true, jobTitle: true, role: true, active: true, hiredAt: true,
      createdAt: true, company: { select: { name: true } },
    },
  })
  const employeeIds = employees.map((e) => e.id)
  const byEmployee = { employeeId: { in: employeeIds } }
  const take = EXPORT_ROW_LIMIT

  const [timeclocks, absences, expenseReports, assignments, hrDocuments, notifications] = await Promise.all([
    prisma.timeclock.findMany({
      where: byEmployee, take, orderBy: { date: "desc" },
      select: { date: true, checkInAt: true, checkInLat: true, checkInLng: true, checkOutAt: true, checkOutLat: true, checkOutLng: true, note: true, worksite: { select: { name: true } } },
    }),
    prisma.absence.findMany({
      where: byEmployee, take, orderBy: { startDate: "desc" },
      select: { type: true, status: true, startDate: true, endDate: true, reason: true, refusalNote: true, createdAt: true },
    }),
    prisma.expenseReport.findMany({
      where: byEmployee, take, orderBy: { date: "desc" },
      select: { date: true, amount: true, category: true, description: true, status: true, rejectionNote: true, receiptUrl: true },
    }),
    prisma.employeeAssignment.findMany({
      where: byEmployee, take, orderBy: { date: "desc" },
      select: { date: true, assignment: { select: { status: true, worksite: { select: { name: true } }, team: { select: { name: true } } } } },
    }),
    prisma.hrDocument.findMany({
      where: { ...byEmployee, status: "PUBLISHED" }, take, orderBy: { createdAt: "desc" },
      select: { category: true, period: true, title: true, publishedAt: true },
    }),
    prisma.notification.findMany({
      where: { userId }, take, orderBy: { createdAt: "desc" },
      select: { title: true, message: true, createdAt: true },
    }),
  ])

  const now = new Date()
  const body = buildPersonalDataExport({ user, employees, timeclocks, absences, expenseReports, assignments, hrDocuments, notifications }, now)
  return new Response(JSON.stringify(body, null, 2), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="${exportFileName(now)}"`,
      "Cache-Control": "no-store",
    },
  })
}
