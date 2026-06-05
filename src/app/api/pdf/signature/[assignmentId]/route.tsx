import { NextRequest, NextResponse } from "next/server"
import { auth } from "@/auth"
import { prisma } from "@/lib/prisma"
import { renderToBuffer, Document, Page, Text, View, StyleSheet, Image as PDFImage } from "@react-pdf/renderer"

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
  employeeRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 6,
    paddingHorizontal: 8,
    borderBottomWidth: 1,
    borderBottomColor: "#f1f5f9",
  },
  employeeBullet: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: "#0f3460",
    marginRight: 8,
  },
  employeeName: {
    fontSize: 10,
    color: "#1e293b",
  },
  signatureBox: {
    backgroundColor: "#f8fafc",
    padding: 12,
    borderRadius: 4,
    borderWidth: 1,
    borderColor: "#e2e8f0",
    alignItems: "flex-start",
  },
  signatureImage: {
    width: 200,
    height: 80,
    objectFit: "contain",
  },
  signatureName: {
    fontSize: 9,
    color: "#64748b",
    marginTop: 6,
  },
  signatureDate: {
    fontSize: 8,
    color: "#94a3b8",
    marginTop: 2,
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
})

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ assignmentId: string }> }
) {
  const session = await auth()
  if (!session?.user || !["ADMIN", "SUPER_ADMIN", "TEAM_LEADER"].includes(session.user.role)) {
    return new NextResponse("Non autorisé", { status: 401 })
  }

  const { assignmentId } = await params
  const companyId = session.user.companyId!

  const assignment = await prisma.assignment.findFirst({
    where: { id: assignmentId, worksite: { companyId } },
    include: {
      worksite: { select: { name: true, address: true, dailyHours: true } },
      team: { select: { name: true } },
      employeeAssignments: {
        include: { employee: { select: { firstName: true, lastName: true } } },
      },
      signature: { include: { signedBy: { select: { firstName: true, lastName: true } } } },
    },
  })

  if (!assignment) return new NextResponse("Affectation introuvable", { status: 404 })
  if (!assignment.signature) return new NextResponse("Aucune signature pour cette affectation", { status: 404 })

  const sig = assignment.signature

  const doc = (
    <Document title={`Feuille de présence — ${assignment.worksite.name}`} author="Planificator">
      <Page size="A4" style={styles.page}>
        {/* En-tête */}
        <View style={styles.header}>
          <Text style={styles.logo}>Planificator</Text>
          <View style={styles.headerRight}>
            <Text style={styles.headerTitle}>Feuille de présence signée</Text>
            <Text style={styles.headerSub}>Générée le {fmt(new Date())}</Text>
          </View>
        </View>

        {/* Informations */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Informations</Text>
          <View style={styles.infoGrid}>
            <View style={styles.infoBox}>
              <Text style={styles.infoLabel}>Chantier</Text>
              <Text style={styles.infoValue}>{assignment.worksite.name}</Text>
            </View>
            <View style={styles.infoBox}>
              <Text style={styles.infoLabel}>Équipe</Text>
              <Text style={styles.infoValue}>{assignment.team.name}</Text>
            </View>
            <View style={styles.infoBox}>
              <Text style={styles.infoLabel}>Date</Text>
              <Text style={styles.infoValue}>{fmtDay(assignment.date)}</Text>
            </View>
            <View style={styles.infoBox}>
              <Text style={styles.infoLabel}>Heures / jour</Text>
              <Text style={styles.infoValue}>{assignment.worksite.dailyHours}h</Text>
            </View>
            {assignment.worksite.address && (
              <View style={styles.infoBox}>
                <Text style={styles.infoLabel}>Adresse</Text>
                <Text style={styles.infoValue}>{assignment.worksite.address}</Text>
              </View>
            )}
          </View>
        </View>

        {/* Employés présents */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Employés présents</Text>
          {assignment.employeeAssignments.length === 0 ? (
            <Text style={{ fontSize: 9, color: "#94a3b8" }}>Aucun employé affecté</Text>
          ) : (
            assignment.employeeAssignments.map((ea) => (
              <View key={ea.employee.firstName + ea.employee.lastName} style={styles.employeeRow}>
                <View style={styles.employeeBullet} />
                <Text style={styles.employeeName}>{ea.employee.firstName} {ea.employee.lastName}</Text>
              </View>
            ))
          )}
        </View>

        {/* Signature du chef d'équipe */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Signature du chef d&apos;équipe</Text>
          <View style={styles.signatureBox}>
            <PDFImage src={sig.signatureUrl} style={styles.signatureImage} />
            <Text style={styles.signatureName}>
              {sig.signedBy.firstName} {sig.signedBy.lastName}
            </Text>
            <Text style={styles.signatureDate}>
              Signé le {fmt(sig.signedAt)}
            </Text>
          </View>
        </View>

        {/* Pied de page */}
        <View style={styles.footer} fixed>
          <Text style={styles.footerText}>Planificator — Feuille de présence</Text>
          <Text style={styles.footerText}>{assignment.worksite.name} · {fmt(assignment.date)}</Text>
        </View>
      </Page>
    </Document>
  )

  const buffer = await renderToBuffer(doc)

  const dateStr = assignment.date.toISOString().split("T")[0]
  const filename = `feuille-presence-${assignment.worksite.name.replace(/\s+/g, "-")}-${dateStr}.pdf`

  return new NextResponse(new Uint8Array(buffer), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  })
}
