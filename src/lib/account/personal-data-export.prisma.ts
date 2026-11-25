import type { PrismaClient } from "@prisma/client"
import { EXPORT_ROW_LIMIT, type PersonalDataSource } from "@/lib/account/personal-data-export"

// Lot 2b juridique : lecture des données du SEUL compte demandé (filtre userId, puis ses fiches employé). Séparé de la
// route pour être testé sur une base jetable (cloisonnement entre comptes et entre sociétés).

export async function collectPersonalData(db: PrismaClient, userId: string): Promise<PersonalDataSource | null> {
  const user = await db.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true, name: true, role: true, createdAt: true, lastLoginAt: true },
  })
  if (!user) return null

  const employees = await db.employee.findMany({
    where: { userId },
    select: {
      id: true, firstName: true, lastName: true, phone: true, jobTitle: true, role: true, active: true, hiredAt: true,
      createdAt: true, company: { select: { name: true } },
    },
  })
  const byEmployee = { employeeId: { in: employees.map((e) => e.id) } }
  const take = EXPORT_ROW_LIMIT

  const [timeclocks, absences, expenseReports, assignments, hrDocuments, notifications] = await Promise.all([
    db.timeclock.findMany({
      where: byEmployee, take, orderBy: { date: "desc" },
      select: { date: true, checkInAt: true, checkInLat: true, checkInLng: true, checkOutAt: true, checkOutLat: true, checkOutLng: true, note: true, worksite: { select: { name: true } } },
    }),
    db.absence.findMany({
      where: byEmployee, take, orderBy: { startDate: "desc" },
      select: { type: true, status: true, startDate: true, endDate: true, reason: true, refusalNote: true, createdAt: true },
    }),
    db.expenseReport.findMany({
      where: byEmployee, take, orderBy: { date: "desc" },
      select: { date: true, amount: true, category: true, description: true, status: true, rejectionNote: true, receiptUrl: true },
    }),
    db.employeeAssignment.findMany({
      where: byEmployee, take, orderBy: { date: "desc" },
      select: { date: true, assignment: { select: { status: true, worksite: { select: { name: true } }, team: { select: { name: true } } } } },
    }),
    db.hrDocument.findMany({
      where: { ...byEmployee, status: "PUBLISHED" }, take, orderBy: { createdAt: "desc" },
      select: { category: true, period: true, title: true, publishedAt: true },
    }),
    // Titre et date seulement : le corps d'une notification peut citer d'autres personnes.
    db.notification.findMany({ where: { userId }, take, orderBy: { createdAt: "desc" }, select: { title: true, createdAt: true } }),
  ])

  return { user, employees, timeclocks, absences, expenseReports, assignments, hrDocuments, notifications }
}
