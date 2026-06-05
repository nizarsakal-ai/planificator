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
  section: { marginBottom: 16 },
  sectionTitle: {
    fontSize: 11,
    fontFamily: "Helvetica-Bold",
    color: "#0f3460",
    marginBottom: 8,
    paddingBottom: 4,
    borderBottomWidth: 1,
    borderBottomColor: "#e2e8f0",
  },
  table: { marginTop: 4 },
  tableHeader: {
    flexDirection: "row",
    backgroundColor: "#0f3460",
    padding: 6,
    borderRadius: 4,
    marginBottom: 2,
  },
  tableHeaderCell: { fontSize: 9, fontFamily: "Helvetica-Bold", color: "white", flex: 1 },
  tableRow: {
    flexDirection: "row",
    padding: 6,
    borderBottomWidth: 1,
    borderBottomColor: "#f1f5f9",
  },
  tableRowAlt: { backgroundColor: "#f8fafc" },
  tableCell: { fontSize: 9, color: "#475569", flex: 1 },
  kpiRow: { flexDirection: "row", gap: 8, marginBottom: 16 },
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

function fmt(date: Date) {
  return new Intl.DateTimeFormat("fr-FR", { day: "2-digit", month: "long", year: "numeric" }).format(date)
}
function fmtShort(date: Date) {
  return new Intl.DateTimeFormat("fr-FR", { day: "2-digit", month: "short" }).format(date)
}

const MONTH_NAMES = [
  "Janvier", "Février", "Mars", "Avril", "Mai", "Juin",
  "Juillet", "Août", "Septembre", "Octobre", "Novembre", "Décembre",
]

const WEATHER_LABEL: Record<string, string> = {
  SUNNY: "Ensoleillé",
  CLOUDY: "Nuageux",
  RAINY: "Pluvieux",
  STORMY: "Orageux",
  WINDY: "Venteux",
  SNOW: "Neige",
}

export async function GET(req: NextRequest) {
  const session = await auth()
  if (!session?.user || !["ADMIN", "SUPER_ADMIN"].includes(session.user.role)) {
    return new NextResponse("Non autorisé", { status: 401 })
  }

  const sp = req.nextUrl.searchParams
  const now = new Date()
  const month = parseInt(sp.get("month") ?? String(now.getMonth() + 1))
  const year  = parseInt(sp.get("year")  ?? String(now.getFullYear()))

  const startOfMonth = new Date(year, month - 1, 1)
  const endOfMonth   = new Date(year, month, 0, 23, 59, 59)
  const companyId    = session.user.companyId!

  const [company, assignments, dailyReports, worksites] = await Promise.all([
    prisma.company.findUnique({ where: { id: companyId }, select: { name: true } }),
    prisma.assignment.findMany({
      where: { worksite: { companyId }, date: { gte: startOfMonth, lte: endOfMonth } },
      include: {
        worksite: { select: { name: true } },
        team: { select: { name: true, color: true } },
      },
      orderBy: { date: "asc" },
    }),
    prisma.dailyReport.findMany({
      where: { worksite: { companyId }, date: { gte: startOfMonth, lte: endOfMonth } },
      include: {
        worksite: { select: { name: true } },
        team: { select: { name: true } },
      },
      orderBy: { date: "asc" },
    }),
    prisma.worksite.findMany({
      where: { companyId, status: { in: ["IN_PROGRESS", "EXTENDED", "PLANNED"] } },
      select: { name: true, status: true, startDate: true, endDate: true },
      orderBy: { startDate: "asc" },
    }),
  ])

  const confirmed = assignments.filter((a) => a.status === "CONFIRMED")
  const totalHours = dailyReports.reduce((sum, r) => sum + r.hoursWorked, 0)
  const monthLabel = `${MONTH_NAMES[month - 1]} ${year}`

  // Stats par équipe
  const byTeam: Record<string, { name: string; days: number; hours: number }> = {}
  for (const a of confirmed) {
    if (!byTeam[a.team.name]) byTeam[a.team.name] = { name: a.team.name, days: 0, hours: 0 }
    byTeam[a.team.name].days++
  }
  for (const r of dailyReports) {
    if (!byTeam[r.team.name]) byTeam[r.team.name] = { name: r.team.name, days: 0, hours: 0 }
    byTeam[r.team.name].hours += r.hoursWorked
  }
  const teamStats = Object.values(byTeam).sort((a, b) => b.hours - a.hours)

  const doc = (
    <Document title={`Récapitulatif ${monthLabel}`} author="Planificator">
      <Page size="A4" style={styles.page}>
        {/* Header */}
        <View style={styles.header}>
          <Text style={styles.logo}>Planificator</Text>
          <View style={styles.headerRight}>
            <Text style={styles.headerTitle}>Récapitulatif mensuel</Text>
            <Text style={styles.headerSub}>{company?.name}</Text>
            <Text style={styles.headerSub}>{monthLabel} · Généré le {fmt(new Date())}</Text>
          </View>
        </View>

        {/* KPIs */}
        <View style={styles.kpiRow}>
          <View style={styles.kpiBox}>
            <Text style={styles.kpiLabel}>Affectations</Text>
            <Text style={styles.kpiValue}>{assignments.length}</Text>
          </View>
          <View style={styles.kpiBox}>
            <Text style={styles.kpiLabel}>Confirmées</Text>
            <Text style={styles.kpiValue}>{confirmed.length}</Text>
          </View>
          <View style={styles.kpiBox}>
            <Text style={styles.kpiLabel}>Heures totales</Text>
            <Text style={styles.kpiValue}>{totalHours.toFixed(0)}h</Text>
          </View>
          <View style={styles.kpiBox}>
            <Text style={styles.kpiLabel}>Rapports</Text>
            <Text style={styles.kpiValue}>{dailyReports.length}</Text>
          </View>
        </View>

        {/* Stats par équipe */}
        {teamStats.length > 0 && (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Performance par équipe</Text>
            <View style={styles.table}>
              <View style={styles.tableHeader}>
                <Text style={[styles.tableHeaderCell, { flex: 2 }]}>Équipe</Text>
                <Text style={styles.tableHeaderCell}>Jours</Text>
                <Text style={styles.tableHeaderCell}>Heures</Text>
              </View>
              {teamStats.map((t, i) => (
                <View key={t.name} style={[styles.tableRow, i % 2 === 1 ? styles.tableRowAlt : {}]}>
                  <Text style={[styles.tableCell, { flex: 2 }]}>{t.name}</Text>
                  <Text style={styles.tableCell}>{t.days}j</Text>
                  <Text style={styles.tableCell}>{t.hours.toFixed(0)}h</Text>
                </View>
              ))}
            </View>
          </View>
        )}

        {/* Rapports journaliers */}
        {dailyReports.length > 0 && (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Rapports journaliers ({dailyReports.length})</Text>
            <View style={styles.table}>
              <View style={styles.tableHeader}>
                <Text style={styles.tableHeaderCell}>Date</Text>
                <Text style={[styles.tableHeaderCell, { flex: 2 }]}>Chantier</Text>
                <Text style={styles.tableHeaderCell}>Équipe</Text>
                <Text style={styles.tableHeaderCell}>Météo</Text>
                <Text style={styles.tableHeaderCell}>Heures</Text>
              </View>
              {dailyReports.slice(0, 30).map((r, i) => (
                <View key={r.id} style={[styles.tableRow, i % 2 === 1 ? styles.tableRowAlt : {}]}>
                  <Text style={styles.tableCell}>{fmtShort(r.date)}</Text>
                  <Text style={[styles.tableCell, { flex: 2 }]}>{r.worksite.name}</Text>
                  <Text style={styles.tableCell}>{r.team.name}</Text>
                  <Text style={styles.tableCell}>{WEATHER_LABEL[r.weather] ?? r.weather}</Text>
                  <Text style={styles.tableCell}>{r.hoursWorked}h</Text>
                </View>
              ))}
              {dailyReports.length > 30 && (
                <Text style={{ fontSize: 8, color: "#94a3b8", marginTop: 4 }}>
                  + {dailyReports.length - 30} rapports supplémentaires...
                </Text>
              )}
            </View>
          </View>
        )}

        {/* Chantiers actifs */}
        {worksites.length > 0 && (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Chantiers en cours / planifiés</Text>
            <View style={styles.table}>
              <View style={styles.tableHeader}>
                <Text style={[styles.tableHeaderCell, { flex: 3 }]}>Chantier</Text>
                <Text style={styles.tableHeaderCell}>Statut</Text>
                <Text style={styles.tableHeaderCell}>Fin prévue</Text>
              </View>
              {worksites.map((w, i) => (
                <View key={w.name + i} style={[styles.tableRow, i % 2 === 1 ? styles.tableRowAlt : {}]}>
                  <Text style={[styles.tableCell, { flex: 3 }]}>{w.name}</Text>
                  <Text style={styles.tableCell}>
                    {w.status === "IN_PROGRESS" ? "En cours" : w.status === "EXTENDED" ? "Prolongé" : "Planifié"}
                  </Text>
                  <Text style={styles.tableCell}>{fmtShort(w.endDate)}</Text>
                </View>
              ))}
            </View>
          </View>
        )}

        {/* Footer */}
        <View style={styles.footer} fixed>
          <Text style={styles.footerText}>Planificator — {company?.name}</Text>
          <Text style={styles.footerText}>Récapitulatif {monthLabel}</Text>
        </View>
      </Page>
    </Document>
  )

  const buffer = await renderToBuffer(doc)

  return new NextResponse(new Uint8Array(buffer), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="recap-${monthLabel.toLowerCase().replace(" ", "-")}.pdf"`,
    },
  })
}
