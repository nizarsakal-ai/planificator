// Lot D Planificator V2 : PDF du procès-verbal de réception, construit EXCLUSIVEMENT depuis l'instantané figé et la
// signature stockée (aucune lecture de données vivantes) : un même procès-verbal donne toujours le même contenu. Les
// métadonnées du document (date de création, producteur) sont fixées depuis l'instantané pour la reproductibilité.
import { Document, Image, Page, StyleSheet, Text, View } from "@react-pdf/renderer"
import { DECISION_LABEL, SEVERITY_LABEL, type ReportSnapshot } from "@/lib/reserves/reserves.core"

const s = StyleSheet.create({
  page: { fontFamily: "Helvetica", fontSize: 10, padding: 40, color: "#1e293b" },
  header: { flexDirection: "row", justifyContent: "space-between", marginBottom: 18, paddingBottom: 12, borderBottomWidth: 2, borderBottomColor: "#0f3460" },
  brand: { fontSize: 16, fontFamily: "Helvetica-Bold", color: "#0f3460" },
  title: { fontSize: 13, fontFamily: "Helvetica-Bold", color: "#0f3460", textAlign: "right" },
  sub: { fontSize: 9, color: "#64748b", marginTop: 2, textAlign: "right" },
  section: { marginBottom: 14 },
  h: { fontSize: 11, fontFamily: "Helvetica-Bold", color: "#0f3460", marginBottom: 6, paddingBottom: 3, borderBottomWidth: 1, borderBottomColor: "#e2e8f0" },
  line: { marginBottom: 3 },
  decision: { fontSize: 12, fontFamily: "Helvetica-Bold", marginBottom: 6 },
  row: { flexDirection: "row", borderBottomWidth: 1, borderBottomColor: "#e2e8f0", paddingVertical: 4 },
  c1: { width: "16%" }, c2: { width: "34%" }, c3: { width: "22%" }, c4: { width: "12%" }, c5: { width: "16%" },
  bold: { fontFamily: "Helvetica-Bold" },
  signs: { flexDirection: "row", justifyContent: "space-between", marginTop: 18 },
  signBox: { width: "47%", borderWidth: 1, borderColor: "#cbd5e1", padding: 8, minHeight: 90 },
  signature: { width: 180, height: 70, objectFit: "contain", marginTop: 4 },
  footer: { position: "absolute", bottom: 24, left: 40, right: 40, fontSize: 7, color: "#94a3b8", textAlign: "center" },
  notice: { fontSize: 8, color: "#64748b", marginTop: 8 },
})
const dayFr = (iso: string) => new Intl.DateTimeFormat("fr-FR", { day: "2-digit", month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(`${iso}T00:00:00Z`))
const instantFr = (iso: string) => new Intl.DateTimeFormat("fr-FR", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "Europe/Paris" }).format(new Date(iso))

export function ReceptionReportDocument({ snapshot: p, signaturePng, snapshotSha256 }: { snapshot: ReportSnapshot; signaturePng: Buffer; snapshotSha256: string }) {
  return (
    <Document title={`Procès-verbal ${p.number}`} author={p.company.name} creator="Planificator" producer="Planificator" creationDate={new Date(p.signedAt)} modificationDate={new Date(p.signedAt)}>
      <Page size="A4" style={s.page}>
        <View style={s.header}>
          <Text style={s.brand}>{p.company.name}</Text>
          <View><Text style={s.title}>Procès-verbal de réception</Text><Text style={s.sub}>{p.number} · réception du {dayFr(p.receptionDate)}</Text></View>
        </View>
        <View style={s.section}>
          <Text style={s.h}>Ouvrage</Text>
          <Text style={s.line}>Chantier : {p.worksite.name}</Text>
          {p.worksite.address ? <Text style={s.line}>Adresse : {p.worksite.address}</Text> : null}
          <Text style={s.line}>Maître d&apos;ouvrage : {p.worksite.client}</Text>
          {p.attendees ? <Text style={s.line}>Présents : {p.attendees}</Text> : null}
        </View>
        <View style={s.section}>
          <Text style={s.h}>Décision</Text>
          <Text style={s.decision}>{DECISION_LABEL[p.decision]}</Text>
          {p.remarks ? <Text style={s.line}>Observations : {p.remarks}</Text> : null}
        </View>
        <View style={s.section}>
          <Text style={s.h}>Réserves ({p.reserves.length})</Text>
          {p.reserves.length === 0 ? <Text>Aucune réserve.</Text> : (
            <View>
              <View style={[s.row, s.bold]}><Text style={s.c1}>N°</Text><Text style={s.c2}>Réserve</Text><Text style={s.c3}>Localisation</Text><Text style={s.c4}>Gravité</Text><Text style={s.c5}>Échéance</Text></View>
              {p.reserves.map((r) => (
                // Revue préliminaire D : pas de wrap={false} sur une réserve. Une description de 4 000 caractères peut dépasser
                // une page : la ligne se poursuit alors sur la page suivante au lieu d'être coupée ou rognée.
                <View key={r.number} style={s.row}>
                  <Text style={s.c1}>{r.number}</Text>
                  <Text style={s.c2}>{r.title}{r.description ? `\n${r.description}` : ""}{r.assignee ? `\nResponsable : ${r.assignee}` : ""}</Text>
                  <Text style={s.c3}>{r.location}</Text>
                  <Text style={s.c4}>{SEVERITY_LABEL[r.severity]}</Text>
                  <Text style={s.c5}>{r.dueDate ? dayFr(r.dueDate) : "—"}</Text>
                </View>
              ))}
            </View>
          )}
        </View>
        <View style={s.signs} wrap={false}>
          <View style={s.signBox}><Text style={s.bold}>Pour le maître d&apos;ouvrage</Text><Text>{p.clientSignerName}</Text>
            {/* eslint-disable-next-line jsx-a11y/alt-text -- composant PDF, pas une image HTML */}
            <Image style={s.signature} src={{ data: signaturePng, format: "png" }} />
          </View>
          <View style={s.signBox}><Text style={s.bold}>Pour l&apos;entreprise</Text><Text>{p.companySignerName}</Text></View>
        </View>
        <Text style={s.notice}>Signature : tracé manuscrit conservé avec son empreinte. Ce n&apos;est pas une signature électronique qualifiée.</Text>
        <Text style={s.footer} fixed>Signé le {instantFr(p.signedAt)} · empreinte de l&apos;instantané SHA-256 {snapshotSha256} · signature SHA-256 {p.signatureSha256}</Text>
        <Text style={[s.footer, { bottom: 12 }]} fixed render={({ pageNumber, totalPages }) => `Page ${pageNumber} / ${totalPages}`} />
      </Page>
    </Document>
  )
}
