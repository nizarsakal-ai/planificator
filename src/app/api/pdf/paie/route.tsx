import { NextRequest, NextResponse } from "next/server"
import { auth } from "@/auth"
import { prisma } from "@/lib/prisma"
import { renderToBuffer, Document, Page, Text, View, StyleSheet } from "@react-pdf/renderer"

const styles = StyleSheet.create({
  page: { fontFamily: "Helvetica", fontSize: 10, padding: 40, color: "#1e293b" },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
    marginBottom: 24,
    paddingBottom: 16,
    borderBottomWidth: 2,
    borderBottomColor: "#0f3460",
  },
  logo: { fontSize: 20, fontFamily: "Helvetica-Bold", color: "#0f3460" },
  headerRight: { alignItems: "flex-end" },
  headerTitle: { fontSize: 14, fontFamily: "Helvetica-Bold", color: "#0f3460" },
  headerSub: { fontSize: 9, color: "#94a3b8", marginTop: 2 },
  kpiRow: { flexDirection: "row", gap: 8, marginBottom: 20 },
  kpiBox: {
    flex: 1,
    backgroundColor: "#f8fafc",
    padding: 10,
    borderRadius: 6,
    borderLeftWidth: 3,
    borderLeftColor: "#0f3460",
  },
  kpiLabel: { fontSize: 8, color: "#94a3b8", marginBottom: 3, textTransform: "uppercase" },
  kpiValue: { fontSize: 18, fontFamily: "Helvetica-Bold", color: "#0f3460" },
  empCard: {
    marginBottom: 10,
    borderWidth: 1,
    borderColor: "#e2e8f0",
    borderRadius: 6,
    overflow: "hidden",
  },
  empHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    backgroundColor: "#0f3460",
    padding: "8 12",
  },
  empName: { fontSize: 10, fontFamily: "Helvetica-Bold", color: "white" },
  empBadge: {
    backgroundColor: "white",
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 10,
  },
  empBadgeText: { fontSize: 9, fontFamily: "Helvetica-Bold", color: "#0f3460" },
  empBody: { padding: "6 12 8 12" },
  chantierRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingVertical: 4,
    borderBottomWidth: 1,
    borderBottomColor: "#f1f5f9",
  },
  chantierName: { fontSize: 9, color: "#475569", flex: 1 },
  chantierDays: { fontSize: 9, fontFamily: "Helvetica-Bold", color: "#0f3460" },
  footer: {
    position: "absolute",
    bottom: 24,
    left: 40,
    right: 40,
    flexDirection: "row",
    justifyContent: "space-between",
    borderTopWidth: 1,
    borderTopColor: "#e2e8f0",
    paddingTop: 8,
  },
  footerText: { fontSize: 8, color: "#94a3b8" },
})

const MONTH_NAMES = [
  "Janvier", "Février", "Mars", "Avril", "Mai", "Juin",
  "Juillet", "Août", "Septembre", "Octobre", "Novembre", "Décembre",
]

function fmt(date: Date) {
  return new Intl.DateTimeFormat("fr-FR", { day: "2-digit", month: "long", year: "numeric" }).format(date)
}

export async function GET(req: NextRequest) {
  const session = await auth()
  if (!session?.user || !["ADMIN", "SUPER_ADMIN"].includes(session.user.role)) {
    return new NextResponse("Non autorisé", { status: 401 })
  }

  const sp = req.nextUrl.searchParams
  const now = new Date()
  const mois = sp.get("mois") ?? `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`
  const [yearStr, monthStr] = mois.split("-")
  const year  = parseInt(yearStr)
  const month = parseInt(monthStr)

  const startOfMonth = new Date(year, month - 1, 1)
  const endOfMonth   = new Date(year, month, 0, 23, 59, 59)
  const companyId    = session.user.companyId!
  const monthLabel   = `${MONTH_NAMES[month - 1]} ${year}`

  const [company, rows] = await Promise.all([
    prisma.company.findUnique({ where: { id: companyId }, select: { name: true } }),
    prisma.employeeAssignment.findMany({
      where: {
        assignment: {
          worksite: { companyId },
          date: { gte: startOfMonth, lte: endOfMonth },
        },
      },
      include: {
        employee: { select: { id: true, firstName: true, lastName: true } },
        assignment: {
          select: {
            worksite: { select: { id: true, name: true } },
          },
        },
      },
    }),
  ])

  // Grouper par employé → chantier
  type ChantierSummary = { id: string; name: string; days: number }
  type EmployeeSummary = {
    id: string; firstName: string; lastName: string
    totalDays: number; chantiers: ChantierSummary[]
  }
  const byEmployee: Record<string, EmployeeSummary> = {}

  for (const row of rows) {
    const emp = row.employee
    const ws  = row.assignment.worksite
    if (!byEmployee[emp.id]) {
      byEmployee[emp.id] = { id: emp.id, firstName: emp.firstName, lastName: emp.lastName, totalDays: 0, chantiers: [] }
    }
    const e = byEmployee[emp.id]
    e.totalDays++
    let ch = e.chantiers.find((c) => c.id === ws.id)
    if (!ch) { ch = { id: ws.id, name: ws.name, days: 0 }; e.chantiers.push(ch) }
    ch.days++
  }

  const employees = Object.values(byEmployee).sort((a, b) => a.lastName.localeCompare(b.lastName))
  const totalJours = employees.reduce((s, e) => s + e.totalDays, 0)

  const doc = (
    <Document title={`Rapport paie ${monthLabel}`} author="Planificator">
      <Page size="A4" style={styles.page}>
        {/* Header */}
        <View style={styles.header}>
          <Text style={styles.logo}>Planificator</Text>
          <View style={styles.headerRight}>
            <Text style={styles.headerTitle}>Rapport de paie mensuel</Text>
            <Text style={styles.headerSub}>{company?.name}</Text>
            <Text style={styles.headerSub}>{monthLabel} · Généré le {fmt(new Date())}</Text>
          </View>
        </View>

        {/* KPIs */}
        <View style={styles.kpiRow}>
          <View style={styles.kpiBox}>
            <Text style={styles.kpiLabel}>Ouvriers</Text>
            <Text style={styles.kpiValue}>{employees.length}</Text>
          </View>
          <View style={styles.kpiBox}>
            <Text style={styles.kpiLabel}>Jours-homme</Text>
            <Text style={styles.kpiValue}>{totalJours}</Text>
          </View>
        </View>

        {/* Un bloc par employé */}
        {employees.map((emp) => (
          <View key={emp.id} style={styles.empCard} wrap={false}>
            <View style={styles.empHeader}>
              <Text style={styles.empName}>{emp.firstName} {emp.lastName}</Text>
              <View style={styles.empBadge}>
                <Text style={styles.empBadgeText}>{emp.totalDays} jour{emp.totalDays > 1 ? "s" : ""}</Text>
              </View>
            </View>
            <View style={styles.empBody}>
              {emp.chantiers.map((ch) => (
                <View key={ch.id} style={styles.chantierRow}>
                  <Text style={styles.chantierName}>{ch.name}</Text>
                  <Text style={styles.chantierDays}>{ch.days}j</Text>
                </View>
              ))}
            </View>
          </View>
        ))}

        {/* Footer */}
        <View style={styles.footer} fixed>
          <Text style={styles.footerText}>Planificator — {company?.name}</Text>
          <Text style={styles.footerText}>Rapport de paie — {monthLabel}</Text>
        </View>
      </Page>
    </Document>
  )

  const buffer = await renderToBuffer(doc)

  return new NextResponse(new Uint8Array(buffer), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="paie-${mois}.pdf"`,
    },
  })
}
