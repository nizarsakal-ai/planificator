import type { Metadata } from "next"
import { auth } from "@/auth"
import { redirect } from "next/navigation"
import { prisma } from "@/lib/prisma"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { MapPin, Clock } from "lucide-react"
import { PointageWidget } from "@/components/pointage/PointageWidget"

export const metadata: Metadata = { title: "Pointage" }

function fmt(d: Date | null) {
  if (!d) return "—"
  return new Intl.DateTimeFormat("fr-FR", { hour: "2-digit", minute: "2-digit" }).format(new Date(d))
}

function fmtDate(d: Date) {
  return new Intl.DateTimeFormat("fr-FR", { weekday: "long", day: "2-digit", month: "long" }).format(new Date(d))
}

function duration(a: Date, b: Date) {
  const ms = new Date(b).getTime() - new Date(a).getTime()
  const h  = Math.floor(ms / 3600000)
  const m  = Math.floor((ms % 3600000) / 60000)
  return `${h}h${m.toString().padStart(2, "0")}`
}

export default async function PointagePage() {
  const session = await auth()
  if (!session?.user) redirect("/login")

  const employee = await prisma.employee.findFirst({
    where: { userId: session.user.id, companyId: session.user.companyId! },
  })
  if (!employee) redirect("/dashboard")

  const today = new Date()
  today.setHours(0, 0, 0, 0)

  const [todayTimeclock, history, worksites] = await Promise.all([
    prisma.timeclock.findUnique({
      where: { employeeId_date: { employeeId: employee.id, date: today } },
      include: { worksite: { select: { name: true } } },
    }),
    prisma.timeclock.findMany({
      where: { employeeId: employee.id, date: { lt: today } },
      include: { worksite: { select: { name: true } } },
      orderBy: { date: "desc" },
      take: 10,
    }),
    prisma.worksite.findMany({
      where: {
        companyId: session.user.companyId!,
        status: { in: ["PLANNED", "IN_PROGRESS", "EXTENDED"] },
        assignments: {
          some: {
            date: today,
            team: { members: { some: { employeeId: employee.id, leftAt: null } } },
          },
        },
      },
      select: { id: true, name: true },
    }),
  ])

  return (
    <div className="space-y-6 max-w-xl">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">Pointage</h1>
        <p className="text-sm text-slate-500 mt-1 capitalize">{fmtDate(new Date())}</p>
      </div>

      {/* Widget pointage du jour */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base font-semibold flex items-center gap-2">
            <MapPin className="h-4 w-4 text-[#0f3460]" />
            Aujourd&apos;hui
          </CardTitle>
        </CardHeader>
        <CardContent>
          <PointageWidget today={todayTimeclock} worksites={worksites} />
        </CardContent>
      </Card>

      {/* Historique */}
      {history.length > 0 && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base font-semibold flex items-center gap-2">
              <Clock className="h-4 w-4 text-slate-400" />
              Historique
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <div className="divide-y divide-slate-50">
              {history.map((t) => (
                <div key={t.id} className="flex items-center gap-3 px-4 py-3">
                  <div className="w-10 text-center">
                    <p className="text-xs font-bold text-slate-700">
                      {new Intl.DateTimeFormat("fr-FR", { day: "2-digit" }).format(new Date(t.date))}
                    </p>
                    <p className="text-[10px] text-slate-400 uppercase">
                      {new Intl.DateTimeFormat("fr-FR", { month: "short" }).format(new Date(t.date))}
                    </p>
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-medium text-slate-700">
                      {fmt(t.checkInAt)} → {fmt(t.checkOutAt)}
                    </p>
                    {t.worksite && (
                      <p className="text-[11px] text-slate-400 truncate">{t.worksite.name}</p>
                    )}
                  </div>
                  {t.checkInAt && t.checkOutAt && (
                    <span className="text-xs font-semibold text-slate-600 shrink-0">
                      {duration(t.checkInAt, t.checkOutAt)}
                    </span>
                  )}
                  {t.checkInAt && !t.checkOutAt && (
                    <span className="text-[11px] text-amber-500 font-medium shrink-0">Sans départ</span>
                  )}
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
