import { NextRequest, NextResponse } from "next/server"
import { auth } from "@/auth"
import { prisma } from "@/lib/prisma"
import { renderToBuffer, Document, Page, Text, View, StyleSheet } from "@react-pdf/renderer"

// ── Styles ────────────────────────────────────────────────────────────────────
const S = StyleSheet.create({
  page:        { fontFamily: "Helvetica", fontSize: 9, padding: 32, color: "#1e293b" },
  header:      { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 18, paddingBottom: 12, borderBottomWidth: 2, borderBottomColor: "#0f3460" },
  logo:        { fontSize: 18, fontFamily: "Helvetica-Bold", color: "#0f3460" },
  headerRight: { alignItems: "flex-end" },
  headerTitle: { fontSize: 12, fontFamily: "Helvetica-Bold", color: "#0f3460" },
  headerSub:   { fontSize: 8, color: "#94a3b8", marginTop: 2 },

  kpiRow:      { flexDirection: "row", gap: 8, marginBottom: 16 },
  kpiBox:      { flex: 1, backgroundColor: "#f8fafc", padding: 8, borderRadius: 5, borderLeftWidth: 3, borderLeftColor: "#0f3460" },
  kpiLabel:    { fontSize: 7, color: "#94a3b8", marginBottom: 2, textTransform: "uppercase" },
  kpiValue:    { fontSize: 16, fontFamily: "Helvetica-Bold", color: "#0f3460" },
  kpiSub:      { fontSize: 7, color: "#64748b", marginTop: 1 },

  empBlock:    { marginBottom: 12 },
  empHeader:   { flexDirection: "row", justifyContent: "space-between", alignItems: "center", backgroundColor: "#0f3460", padding: "5 10", borderRadius: "4 4 0 0" },
  empName:     { fontSize: 9, fontFamily: "Helvetica-Bold", color: "white" },
  empTotal:    { fontSize: 8, color: "#93c5fd" },

  tableHeader: { flexDirection: "row", backgroundColor: "#f1f5f9", padding: "4 10", borderBottomWidth: 1, borderBottomColor: "#e2e8f0" },
  tableRow:    { flexDirection: "row", padding: "3 10", borderBottomWidth: 1, borderBottomColor: "#f8fafc" },
  tableRowAlt: { backgroundColor: "#fafafa" },
  tableTotal:  { flexDirection: "row", padding: "4 10", backgroundColor: "#eff6ff", borderTopWidth: 1, borderTopColor: "#bfdbfe" },

  colMonth:    { width: "22%", fontSize: 8 },
  colWorked:   { width: "16%", fontSize: 8, textAlign: "center" },
  colHours:    { width: "16%", fontSize: 8, textAlign: "center" },
  colAbsence:  { width: "16%", fontSize: 8, textAlign: "center" },
  colOff:      { width: "16%", fontSize: 8, textAlign: "center" },
  colChantier: { width: "14%", fontSize: 8, textAlign: "center" },

  colHeaderText:  { fontFamily: "Helvetica-Bold", fontSize: 7, color: "#64748b", textTransform: "uppercase" },
  colTotalText:   { fontFamily: "Helvetica-Bold", color: "#1e40af" },
  colWorkedText:  { fontFamily: "Helvetica-Bold", color: "#15803d" },
  colAbsText:     { fontFamily: "Helvetica-Bold", color: "#d97706" },
  colOffText:     { color: "#94a3b8" },

  footer:      { position: "absolute", bottom: 20, left: 32, right: 32, flexDirection: "row", justifyContent: "space-between", borderTopWidth: 1, borderTopColor: "#e2e8f0", paddingTop: 6 },
  footerText:  { fontSize: 7, color: "#94a3b8" },
})

// ── Helpers ───────────────────────────────────────────────────────────────────
const MONTH_NAMES = ["Janvier","Février","Mars","Avril","Mai","Juin","Juillet","Août","Septembre","Octobre","Novembre","Décembre"]

function fmt(d: Date) {
  return new Intl.DateTimeFormat("fr-FR", { day: "2-digit", month: "long", year: "numeric" }).format(d)
}

function fmtShort(d: Date) {
  return new Intl.DateTimeFormat("fr-FR", { day: "2-digit", month: "short", year: "numeric" }).format(d)
}

// Calendar days in [start, end] that fall within [periodStart, periodEnd]
function calendarDaysIntersect(start: Date, end: Date, periodStart: Date, periodEnd: Date): number {
  const from = start > periodStart ? start : periodStart
  const to   = end   < periodEnd   ? end   : periodEnd
  if (from > to) return 0
  return Math.round((to.getTime() - from.getTime()) / 86400000) + 1
}

// ── Route handler ─────────────────────────────────────────────────────────────
export async function GET(req: NextRequest) {
  const session = await auth()
  if (!session?.user || !["ADMIN", "SUPER_ADMIN"].includes(session.user.role)) {
    return new NextResponse("Non autorisé", { status: 401 })
  }

  const sp = req.nextUrl.searchParams
  const companyId = session.user.companyId!

  // Période : défaut = 300 derniers jours
  const toDate   = sp.get("to")   ? new Date(sp.get("to")!)   : new Date()
  const fromDate = sp.get("from") ? new Date(sp.get("from")!) : new Date(toDate.getTime() - 30 * 86400000)
  toDate.setHours(23, 59, 59)
  fromDate.setHours(0, 0, 0, 0)

  const [company, employees, assignments, absences] = await Promise.all([
    prisma.company.findUnique({ where: { id: companyId }, select: { name: true, settings: { select: { defaultDailyHours: true } } } }),
    prisma.employee.findMany({
      where: { companyId, active: true },
      select: { id: true, firstName: true, lastName: true },
      orderBy: [{ lastName: "asc" }, { firstName: "asc" }],
    }),
    prisma.employeeAssignment.findMany({
      where: {
        assignment: {
          worksite: { companyId },
          date: { gte: fromDate, lte: toDate },
        },
      },
      include: {
        employee: { select: { id: true } },
        assignment: {
          select: {
            date: true,
            worksite: { select: { dailyHours: true } },
          },
        },
      },
    }),
    prisma.absence.findMany({
      where: {
        companyId,
        status: "APPROVED",
        startDate: { lte: toDate },
        endDate:   { gte: fromDate },
      },
      include: { employee: { select: { id: true } } },
    }),
  ])

  // ── Construire les données par employé + par mois ─────────────────────────
  type MonthData = {
    year: number; month: number
    worked: number; hours: number; absences: number; calDays: number
  }
  type EmpData = {
    id: string; firstName: string; lastName: string
    months: MonthData[]
    totalWorked: number; totalHours: number; totalAbsences: number; totalCalDays: number
  }

  const defaultDailyHours = company?.settings?.defaultDailyHours ?? 10

  // Enumerate all (year, month) pairs in the period
  const monthKeys: { year: number; month: number; start: Date; end: Date }[] = []
  {
    let cur = new Date(fromDate.getFullYear(), fromDate.getMonth(), 1)
    while (cur <= toDate) {
      const y = cur.getFullYear(); const m = cur.getMonth()
      const mStart = new Date(y, m, 1)
      const mEnd   = new Date(y, m + 1, 0, 23, 59, 59)
      const clampStart = mStart < fromDate ? fromDate : mStart
      const clampEnd   = mEnd   > toDate   ? toDate   : mEnd
      monthKeys.push({ year: y, month: m, start: clampStart, end: clampEnd })
      cur = new Date(y, m + 1, 1)
    }
  }

  const empMap: Record<string, EmpData> = {}
  for (const emp of employees) {
    empMap[emp.id] = {
      id: emp.id, firstName: emp.firstName, lastName: emp.lastName,
      months: monthKeys.map(mk => ({
        year: mk.year, month: mk.month, worked: 0, hours: 0, absences: 0,
        calDays: Math.round((mk.end.getTime() - mk.start.getTime()) / 86400000) + 1,
      })),
      totalWorked: 0, totalHours: 0, totalAbsences: 0, totalCalDays: 0,
    }
  }

  // Jours travaillés
  for (const a of assignments) {
    const e = empMap[a.employee.id]
    if (!e) continue
    const d = a.assignment.date
    const mi = monthKeys.findIndex(mk => mk.year === d.getFullYear() && mk.month === d.getMonth())
    if (mi === -1) continue
    const h = a.assignment.worksite.dailyHours ?? defaultDailyHours
    e.months[mi].worked++
    e.months[mi].hours += h
  }

  // Absences
  for (const abs of absences) {
    const e = empMap[abs.employee.id]
    if (!e) continue
    for (let mi = 0; mi < monthKeys.length; mi++) {
      const mk = monthKeys[mi]
      const days = calendarDaysIntersect(abs.startDate, abs.endDate, mk.start, mk.end)
      if (days > 0) e.months[mi].absences += days
    }
  }

  // Totaux
  for (const e of Object.values(empMap)) {
    for (const m of e.months) {
      e.totalWorked    += m.worked
      e.totalHours     += m.hours
      e.totalAbsences  += m.absences
      e.totalCalDays   += m.calDays
    }
  }

  const empList = Object.values(empMap)
  const grandWorked   = empList.reduce((s, e) => s + e.totalWorked, 0)
  const grandHours    = empList.reduce((s, e) => s + e.totalHours, 0)
  const grandAbsences = empList.reduce((s, e) => s + e.totalAbsences, 0)

  const periodLabel = `${fmtShort(fromDate)} → ${fmtShort(toDate)}`

  // ── Render PDF ────────────────────────────────────────────────────────────
  const doc = (
    <Document title={`Présence employés — ${periodLabel}`} author="Planificator">
      <Page size="A4" orientation="landscape" style={S.page}>
        {/* Header */}
        <View style={S.header}>
          <Text style={S.logo}>Planificator</Text>
          <View style={S.headerRight}>
            <Text style={S.headerTitle}>Rapport de présence — Jours travaillés / non travaillés</Text>
            <Text style={S.headerSub}>{company?.name ?? "Planificator"}</Text>
            <Text style={S.headerSub}>Période : {periodLabel} · Généré le {fmt(new Date())}</Text>
          </View>
        </View>

        {/* KPIs */}
        <View style={S.kpiRow}>
          <View style={S.kpiBox}>
            <Text style={S.kpiLabel}>Employés</Text>
            <Text style={S.kpiValue}>{empList.length}</Text>
          </View>
          <View style={S.kpiBox}>
            <Text style={S.kpiLabel}>Jours travaillés (total)</Text>
            <Text style={[S.kpiValue, { color: "#15803d" }]}>{grandWorked}</Text>
            <Text style={S.kpiSub}>{grandHours}h au total</Text>
          </View>
          <View style={S.kpiBox}>
            <Text style={S.kpiLabel}>Jours absence (total)</Text>
            <Text style={[S.kpiValue, { color: "#d97706" }]}>{grandAbsences}</Text>
          </View>
          <View style={S.kpiBox}>
            <Text style={S.kpiLabel}>Période</Text>
            <Text style={[S.kpiValue, { fontSize: 11 }]}>{monthKeys.length} mois</Text>
            <Text style={S.kpiSub}>{Math.round((toDate.getTime() - fromDate.getTime()) / 86400000)} jours calendaires</Text>
          </View>
        </View>

        {/* Un bloc par employé */}
        {empList.map((emp) => (
          <View key={emp.id} style={S.empBlock} wrap={false}>
            {/* En-tête employé */}
            <View style={S.empHeader}>
              <Text style={S.empName}>{emp.lastName.toUpperCase()} {emp.firstName}</Text>
              <Text style={S.empTotal}>
                {emp.totalWorked}j travaillés · {emp.totalHours}h · {emp.totalAbsences}j absence · {emp.totalCalDays - emp.totalWorked - emp.totalAbsences}j non affectés
              </Text>
            </View>

            {/* En-têtes colonnes */}
            <View style={S.tableHeader}>
              <Text style={[S.colMonth,    S.colHeaderText]}>Mois</Text>
              <Text style={[S.colWorked,   S.colHeaderText]}>Travaillés</Text>
              <Text style={[S.colHours,    S.colHeaderText]}>Heures</Text>
              <Text style={[S.colAbsence,  S.colHeaderText]}>Absences</Text>
              <Text style={[S.colOff,      S.colHeaderText]}>Non affectés</Text>
              <Text style={[S.colChantier, S.colHeaderText]}>Jrs calendaires</Text>
            </View>

            {/* Lignes par mois */}
            {emp.months.map((m, i) => {
              const nonAffecte = m.calDays - m.worked - m.absences
              return (
                <View key={`${m.year}-${m.month}`} style={[S.tableRow, i % 2 === 1 ? S.tableRowAlt : {}]}>
                  <Text style={S.colMonth}>{MONTH_NAMES[m.month]} {m.year}</Text>
                  <Text style={[S.colWorked,  S.colWorkedText]}>{m.worked}j</Text>
                  <Text style={[S.colHours,   S.colWorkedText]}>{m.hours}h</Text>
                  <Text style={[S.colAbsence, m.absences > 0 ? S.colAbsText : S.colOffText]}>{m.absences > 0 ? `${m.absences}j` : "—"}</Text>
                  <Text style={[S.colOff,     S.colOffText]}>{nonAffecte}j</Text>
                  <Text style={[S.colChantier,{ color: "#94a3b8" }]}>{m.calDays}j</Text>
                </View>
              )
            })}

            {/* Ligne totaux */}
            <View style={S.tableTotal}>
              <Text style={[S.colMonth,    S.colTotalText]}>TOTAL</Text>
              <Text style={[S.colWorked,   S.colTotalText]}>{emp.totalWorked}j</Text>
              <Text style={[S.colHours,    S.colTotalText]}>{emp.totalHours}h</Text>
              <Text style={[S.colAbsence,  S.colTotalText]}>{emp.totalAbsences}j</Text>
              <Text style={[S.colOff,      S.colTotalText]}>{emp.totalCalDays - emp.totalWorked - emp.totalAbsences}j</Text>
              <Text style={[S.colChantier, S.colTotalText]}>{emp.totalCalDays}j</Text>
            </View>
          </View>
        ))}

        {/* Footer */}
        <View style={S.footer} fixed>
          <Text style={S.footerText}>Planificator · {company?.name ?? ""}</Text>
          <Text style={S.footerText} render={({ pageNumber, totalPages }) => `Page ${pageNumber} / ${totalPages}`} />
          <Text style={S.footerText}>Période : {periodLabel}</Text>
        </View>
      </Page>
    </Document>
  )

  const buffer = await renderToBuffer(doc)
  const filename = `presence_${fromDate.toISOString().split("T")[0]}_${toDate.toISOString().split("T")[0]}.pdf`

  return new NextResponse(new Uint8Array(buffer), {
    headers: {
      "Content-Type":        "application/pdf",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  })
}
