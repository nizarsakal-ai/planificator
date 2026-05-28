import { NextRequest, NextResponse } from "next/server"
import { auth } from "@/auth"
import { prisma } from "@/lib/prisma"
import { renderToBuffer, Document, Page, Text, View, StyleSheet } from "@react-pdf/renderer"

export const runtime = "nodejs"

const statusLabels: Record<string, string> = {
  PLANNED:     "Planifié",
  IN_PROGRESS: "En cours",
  EXTENDED:    "Prolongé",
  COMPLETED:   "Terminé",
  ARCHIVED:    "Archivé",
}

const absenceLabels: Record<string, string> = {
  CONFIRMED: "Confirmé",
  PENDING:   "En attente",
  REFUSED:   "Refusé",
}

function fmt(date: Date) {
  return new Intl.DateTimeFormat("fr-FR", { day: "2-digit", month: "long", year: "numeric" }).format(date)
}

function fmtShort(date: Date) {
  return new Intl.DateTimeFormat("fr-FR", { day: "2-digit", month: "short" }).format(date)
}

const styles = StyleSheet.create({
  page: {
    fontFamily: "Helvetica",
    fontSize: 10,
    padding: 40,
    color: "#1e293b",
  },
  // En-tête
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
  // Sections
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
  // Grille infos
  infoGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
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
  // Badge statut
  badge: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 12,
    alignSelf: "flex-start",
    marginBottom: 12,
  },
  badgeText: {
    fontSize: 9,
    fontFamily: "Helvetica-Bold",
    color: "white",
  },
  // Tableau affectations
  table: {
    marginTop: 4,
  },
  tableHeader: {
    flexDirection: "row",
    backgroundColor: "#0f3460",
    padding: 6,
    borderRadius: 4,
    marginBottom: 2,
  },
  tableHeaderCell: {
    fontSize: 9,
    fontFamily: "Helvetica-Bold",
    color: "white",
    flex: 1,
  },
  tableRow: {
    flexDirection: "row",
    padding: 6,
    borderBottomWidth: 1,
    borderBottomColor: "#f1f5f9",
  },
  tableRowAlt: {
    backgroundColor: "#f8fafc",
  },
  tableCell: {
    fontSize: 9,
    color: "#475569",
    flex: 1,
  },
  // Description
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
  // Pied de page
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

const statusBgColor: Record<string, string> = {
  PLANNED:     "#3b82f6",
  IN_PROGRESS: "#22c55e",
  EXTENDED:    "#f59e0b",
  COMPLETED:   "#6b7280",
  ARCHIVED:    "#374151",
}

const assignmentColor: Record<string, string> = {
  CONFIRMED: "#22c55e",
  PENDING:   "#3b82f6",
  REFUSED:   "#ef4444",
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth()
  if (!session?.user || !["ADMIN", "SUPER_ADMIN"].includes(session.user.role)) {
    return new NextResponse("Non autorisé", { status: 401 })
  }

  const { id } = await params

  const chantier = await prisma.worksite.findFirst({
    where: { id, companyId: session.user.companyId! },
    include: {
      client: true,
      company: { select: { name: true } },
      assignments: {
        include: { team: { select: { name: true } } },
        orderBy: { date: "asc" },
      },
      extensions: { orderBy: { createdAt: "desc" } },
      documents: { orderBy: { uploadedAt: "desc" } },
    },
  })

  if (!chantier) return new NextResponse("Chantier introuvable", { status: 404 })

  const confirmedAssignments = chantier.assignments.filter(a => a.status === "CONFIRMED")
  const pendingAssignments   = chantier.assignments.filter(a => a.status === "PENDING")

  const doc = (
    <Document title={`Rapport — ${chantier.name}`} author="Planificator">
      <Page size="A4" style={styles.page}>
        {/* En-tête */}
        <View style={styles.header}>
          <Text style={styles.logo}>Planificator</Text>
          <View style={styles.headerRight}>
            <Text style={styles.headerTitle}>Rapport de chantier</Text>
            <Text style={styles.headerSub}>{chantier.company.name}</Text>
            <Text style={styles.headerSub}>Généré le {fmt(new Date())}</Text>
          </View>
        </View>

        {/* Nom + statut */}
        <View style={[styles.badge, { backgroundColor: statusBgColor[chantier.status] ?? "#6b7280" }]}>
          <Text style={styles.badgeText}>{statusLabels[chantier.status] ?? chantier.status}</Text>
        </View>
        <Text style={{ fontSize: 18, fontFamily: "Helvetica-Bold", color: "#0f3460", marginBottom: 4 }}>
          {chantier.name}
        </Text>
        <Text style={{ fontSize: 10, color: "#64748b", marginBottom: 16 }}>
          Client : {chantier.client.name}
        </Text>

        {/* Informations générales */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Informations générales</Text>
          <View style={styles.infoGrid}>
            <View style={styles.infoBox}>
              <Text style={styles.infoLabel}>Date de début</Text>
              <Text style={styles.infoValue}>{fmt(chantier.startDate)}</Text>
            </View>
            <View style={styles.infoBox}>
              <Text style={styles.infoLabel}>Date de fin</Text>
              <Text style={styles.infoValue}>{fmt(chantier.endDate)}</Text>
            </View>
            {chantier.address && (
              <View style={styles.infoBox}>
                <Text style={styles.infoLabel}>Adresse</Text>
                <Text style={styles.infoValue}>{chantier.address}</Text>
              </View>
            )}
            <View style={styles.infoBox}>
              <Text style={styles.infoLabel}>Heures / jour</Text>
              <Text style={styles.infoValue}>{chantier.dailyHours}h</Text>
            </View>
            <View style={styles.infoBox}>
              <Text style={styles.infoLabel}>Affectations confirmées</Text>
              <Text style={styles.infoValue}>{confirmedAssignments.length} jour{confirmedAssignments.length > 1 ? "s" : ""}</Text>
            </View>
            <View style={styles.infoBox}>
              <Text style={styles.infoLabel}>Documents</Text>
              <Text style={styles.infoValue}>{chantier.documents.length} fichier{chantier.documents.length > 1 ? "s" : ""}</Text>
            </View>
          </View>
        </View>

        {/* Description */}
        {chantier.description && (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Description des travaux</Text>
            <View style={styles.descBox}>
              <Text style={styles.descText}>{chantier.description}</Text>
            </View>
          </View>
        )}

        {/* Affectations */}
        {chantier.assignments.length > 0 && (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>
              Affectations ({chantier.assignments.length})
            </Text>
            <View style={styles.table}>
              <View style={styles.tableHeader}>
                <Text style={styles.tableHeaderCell}>Date</Text>
                <Text style={styles.tableHeaderCell}>Équipe</Text>
                <Text style={styles.tableHeaderCell}>Statut</Text>
              </View>
              {chantier.assignments.slice(0, 25).map((a, i) => (
                <View key={a.id} style={[styles.tableRow, i % 2 === 1 ? styles.tableRowAlt : {}]}>
                  <Text style={styles.tableCell}>{fmtShort(a.date)}</Text>
                  <Text style={styles.tableCell}>{a.team.name}</Text>
                  <Text style={[styles.tableCell, { color: assignmentColor[a.status] ?? "#64748b", fontFamily: "Helvetica-Bold" }]}>
                    {absenceLabels[a.status] ?? a.status}
                  </Text>
                </View>
              ))}
              {chantier.assignments.length > 25 && (
                <Text style={{ fontSize: 8, color: "#94a3b8", marginTop: 4 }}>
                  + {chantier.assignments.length - 25} affectations supplémentaires...
                </Text>
              )}
            </View>
          </View>
        )}

        {/* Prolongations */}
        {chantier.extensions.length > 0 && (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Prolongations</Text>
            {chantier.extensions.map((ext) => (
              <View key={ext.id} style={{ flexDirection: "row", marginBottom: 4 }}>
                <Text style={{ fontSize: 9, color: "#475569" }}>
                  {fmt(ext.previousEndDate)} → {fmt(ext.newEndDate)}
                  {ext.reason ? ` — ${ext.reason}` : ""}
                </Text>
              </View>
            ))}
          </View>
        )}

        {/* Résumé */}
        <View style={{ backgroundColor: "#0f3460", padding: 12, borderRadius: 6, marginTop: 8 }}>
          <Text style={{ fontSize: 9, fontFamily: "Helvetica-Bold", color: "white", marginBottom: 6 }}>
            Résumé
          </Text>
          <View style={{ flexDirection: "row" }}>
            <Text style={{ fontSize: 9, color: "#93c5fd", marginRight: 16 }}>
              {confirmedAssignments.length} jours confirmes
            </Text>
            <Text style={{ fontSize: 9, color: "#93c5fd", marginRight: 16 }}>
              {pendingAssignments.length} jours en attente
            </Text>
            <Text style={{ fontSize: 9, color: "#93c5fd" }}>
              {chantier.documents.length} document{chantier.documents.length > 1 ? "s" : ""}
            </Text>
          </View>
        </View>

        {/* Pied de page */}
        <View style={styles.footer} fixed>
          <Text style={styles.footerText}>Planificator — {chantier.company.name}</Text>
          <Text style={styles.footerText}>{chantier.name} · {fmt(new Date())}</Text>
        </View>
      </Page>
    </Document>
  )

  try {
    const buffer = await renderToBuffer(doc)
    return new NextResponse(buffer, {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="chantier-${chantier.name.replace(/\s+/g, "-")}.pdf"`,
      },
    })
  } catch (err) {
    console.error("[PDF ERROR]", err)
    return new NextResponse(`Erreur PDF: ${String(err)}`, { status: 500 })
  }
}
