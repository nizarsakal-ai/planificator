import { NextRequest, NextResponse } from "next/server"
import { auth } from "@/auth"
import { prisma } from "@/lib/prisma"
import { renderToBuffer, Document, Page, Text, View, StyleSheet } from "@react-pdf/renderer"

const WEATHER_LABELS: Record<string, string> = {
  SUNNY:  "Ensoleillé",
  CLOUDY: "Nuageux",
  RAINY:  "Pluvieux",
  STORMY: "Orageux",
  WINDY:  "Venteux",
  SNOW:   "Neige",
}

const WEATHER_EMOJI: Record<string, string> = {
  SUNNY:  "Ensoleille",
  CLOUDY: "Nuageux",
  RAINY:  "Pluvieux",
  STORMY: "Orageux",
  WINDY:  "Venteux",
  SNOW:   "Neige",
}

function fmt(date: Date) {
  return new Intl.DateTimeFormat("fr-FR", { day: "2-digit", month: "long", year: "numeric" }).format(date)
}

function fmtDay(date: Date) {
  return new Intl.DateTimeFormat("fr-FR", { weekday: "long", day: "2-digit", month: "long", year: "numeric" }).format(date)
}

const styles = StyleSheet.create({
  page: {
    fontFamily: "Helvetica",
    fontSize: 10,
    padding: 40,
    color: "#1e293b",
  },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
    marginBottom: 24,
    paddingBottom: 16,
    borderBottomWidth: 2,
    borderBottomColor: "#0f3460",
  },
  logo: {
    fontSize: 20,
    fontFamily: "Helvetica-Bold",
    color: "#0f3460",
  },
  headerRight: {
    alignItems: "flex-end",
  },
  headerTitle: {
    fontSize: 14,
    fontFamily: "Helvetica-Bold",
    color: "#0f3460",
  },
  headerSub: {
    fontSize: 9,
    color: "#94a3b8",
    marginTop: 2,
  },
  section: {
    marginBottom: 16,
  },
  sectionTitle: {
    fontSize: 11,
    fontFamily: "Helvetica-Bold",
    color: "#0f3460",
    marginBottom: 8,
    paddingBottom: 4,
    borderBottomWidth: 1,
    borderBottomColor: "#e2e8f0",
  },
  infoGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  infoBox: {
    width: "48%",
    backgroundColor: "#f8fafc",
    padding: 8,
    borderRadius: 4,
    marginBottom: 4,
  },
  infoLabel: {
    fontSize: 8,
    color: "#94a3b8",
    marginBottom: 2,
    textTransform: "uppercase",
  },
  infoValue: {
    fontSize: 10,
    fontFamily: "Helvetica-Bold",
    color: "#1e293b",
  },
  descBox: {
    backgroundColor: "#f8fafc",
    padding: 10,
    borderRadius: 4,
    borderLeftWidth: 3,
    borderLeftColor: "#0f3460",
  },
  descText: {
    fontSize: 9,
    color: "#475569",
    lineHeight: 1.5,
  },
  issuesBox: {
    backgroundColor: "#fff7ed",
    padding: 10,
    borderRadius: 4,
    borderLeftWidth: 3,
    borderLeftColor: "#f59e0b",
  },
  issuesText: {
    fontSize: 9,
    color: "#92400e",
    lineHeight: 1.5,
  },
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
  footerText: {
    fontSize: 8,
    color: "#94a3b8",
  },
  dateHeading: {
    fontSize: 16,
    fontFamily: "Helvetica-Bold",
    color: "#0f3460",
    marginBottom: 4,
    textTransform: "capitalize",
  },
})

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth()
  if (!session?.user || !["ADMIN", "SUPER_ADMIN"].includes(session.user.role)) {
    return new NextResponse("Non autorisé", { status: 401 })
  }

  const { id } = await params

  const report = await prisma.dailyReport.findFirst({
    where: {
      id,
      worksite: { companyId: session.user.companyId! },
    },
    include: {
      worksite: { select: { name: true, address: true, company: { select: { name: true } } } },
      team:     { select: { name: true } },
      createdBy: { select: { firstName: true, lastName: true } },
    },
  })

  if (!report) return new NextResponse("Rapport introuvable", { status: 404 })

  const weatherLabel = WEATHER_LABELS[report.weather] ?? report.weather

  const doc = (
    <Document title={`Rapport journalier — ${report.worksite.name}`} author="Planificator">
      <Page size="A4" style={styles.page}>
        {/* En-tête */}
        <View style={styles.header}>
          <Text style={styles.logo}>Planificator</Text>
          <View style={styles.headerRight}>
            <Text style={styles.headerTitle}>Rapport journalier</Text>
            <Text style={styles.headerSub}>{report.worksite.company.name}</Text>
            <Text style={styles.headerSub}>Généré le {fmt(new Date())}</Text>
          </View>
        </View>

        {/* Date */}
        <Text style={styles.dateHeading}>{fmtDay(report.date)}</Text>
        <Text style={{ fontSize: 10, color: "#64748b", marginBottom: 20 }}>
          {report.worksite.name}
        </Text>

        {/* Informations */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Informations</Text>
          <View style={styles.infoGrid}>
            <View style={styles.infoBox}>
              <Text style={styles.infoLabel}>Chantier</Text>
              <Text style={styles.infoValue}>{report.worksite.name}</Text>
            </View>
            <View style={styles.infoBox}>
              <Text style={styles.infoLabel}>Équipe</Text>
              <Text style={styles.infoValue}>{report.team.name}</Text>
            </View>
            <View style={styles.infoBox}>
              <Text style={styles.infoLabel}>Chef d&apos;équipe</Text>
              <Text style={styles.infoValue}>{report.createdBy.firstName} {report.createdBy.lastName}</Text>
            </View>
            <View style={styles.infoBox}>
              <Text style={styles.infoLabel}>Météo</Text>
              <Text style={styles.infoValue}>{weatherLabel}</Text>
            </View>
            <View style={styles.infoBox}>
              <Text style={styles.infoLabel}>Heures travaillées</Text>
              <Text style={styles.infoValue}>{report.hoursWorked}h</Text>
            </View>
            {report.worksite.address && (
              <View style={styles.infoBox}>
                <Text style={styles.infoLabel}>Adresse</Text>
                <Text style={styles.infoValue}>{report.worksite.address}</Text>
              </View>
            )}
          </View>
        </View>

        {/* Travaux effectués */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Travaux effectués</Text>
          <View style={styles.descBox}>
            <Text style={styles.descText}>{report.description}</Text>
          </View>
        </View>

        {/* Problèmes rencontrés */}
        {report.issues && (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Problèmes rencontrés</Text>
            <View style={styles.issuesBox}>
              <Text style={styles.issuesText}>{report.issues}</Text>
            </View>
          </View>
        )}

        {/* Pied de page */}
        <View style={styles.footer} fixed>
          <Text style={styles.footerText}>Planificator — {report.worksite.company.name}</Text>
          <Text style={styles.footerText}>{report.worksite.name} · {fmt(report.date)}</Text>
        </View>
      </Page>
    </Document>
  )

  const buffer = await renderToBuffer(doc)

  const filename = `rapport-${report.worksite.name.replace(/\s+/g, "-")}-${report.date.toISOString().split("T")[0]}.pdf`

  return new NextResponse(new Uint8Array(buffer), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  })
}
