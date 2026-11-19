// Lot G Planificator V2 : PDF d'un document généré, construit EXCLUSIVEMENT depuis son instantané figé et sa
// validation stockée (aucune lecture du modèle vivant) : un même document donne toujours le même contenu. Un document
// non émis porte la mention « projet » ou « refusé ». Les PDF existants du logiciel ne sont pas modifiés.
import { Document, Image, Page, StyleSheet, Text, View } from "@react-pdf/renderer"
import type { DocumentSnapshot } from "@/lib/document-studio/studio.core"

const s = StyleSheet.create({
  page: { fontFamily: "Helvetica", fontSize: 10.5, padding: 48, color: "#1e293b", lineHeight: 1.45 },
  header: { flexDirection: "row", justifyContent: "space-between", marginBottom: 22, paddingBottom: 12, borderBottomWidth: 2, borderBottomColor: "#0f3460" },
  brand: { fontSize: 15, fontFamily: "Helvetica-Bold", color: "#0f3460" },
  number: { fontSize: 9, color: "#64748b", textAlign: "right" },
  title: { fontSize: 15, fontFamily: "Helvetica-Bold", color: "#0f3460", marginBottom: 14 },
  heading: { fontSize: 11.5, fontFamily: "Helvetica-Bold", color: "#0f3460", marginTop: 8, marginBottom: 4 },
  para: { marginBottom: 8 },
  stamp: { fontSize: 12, fontFamily: "Helvetica-Bold", color: "#b91c1c", borderWidth: 1, borderColor: "#b91c1c", padding: 6, marginBottom: 12, textAlign: "center" },
  signBox: { marginTop: 22, width: "50%", alignSelf: "flex-end", borderWidth: 1, borderColor: "#cbd5e1", padding: 8 },
  signature: { width: 180, height: 70, objectFit: "contain", marginTop: 4 },
  footer: { position: "absolute", bottom: 24, left: 48, right: 48, fontSize: 7, color: "#94a3b8", textAlign: "center" },
})
const dayFr = (iso: string) => new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(`${iso}T00:00:00Z`))
const instantFr = (d: Date) => new Intl.DateTimeFormat("fr-FR", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "Europe/Paris" }).format(d)

export interface DocumentPdfProps {
  snapshot: DocumentSnapshot; snapshotSha256: string; status: "PENDING_APPROVAL" | "ISSUED" | "REJECTED"
  approval: { signerName: string; approvedAt: Date; signaturePng: Buffer } | null
}
export function GeneratedDocumentPdf({ snapshot: d, snapshotSha256, status, approval }: DocumentPdfProps) {
  const date = new Date(`${d.issuedOn}T00:00:00Z`)
  return (
    <Document title={`${d.title} — ${d.number}`} author={d.company} creator="Planificator" producer="Planificator" creationDate={date} modificationDate={date}>
      <Page size="A4" style={s.page}>
        <View style={s.header}>
          <Text style={s.brand}>{d.company}</Text>
          <View><Text style={s.number}>{d.number}</Text><Text style={s.number}>{dayFr(d.issuedOn)}</Text></View>
        </View>
        {status === "PENDING_APPROVAL" ? <Text style={s.stamp}>PROJET — EN ATTENTE DE VALIDATION</Text> : null}
        {status === "REJECTED" ? <Text style={s.stamp}>DOCUMENT REFUSÉ — SANS VALEUR</Text> : null}
        <Text style={s.title}>{d.title}</Text>
        {d.blocks.map((b, i) => <Text key={i} style={b.kind === "heading" ? s.heading : s.para}>{b.text}</Text>)}
        {approval ? (
          <View style={s.signBox} wrap={false}>
            <Text>Validé par {approval.signerName}, le {instantFr(approval.approvedAt)}</Text>
            <Image style={s.signature} src={approval.signaturePng} />
          </View>
        ) : null}
        <Text style={s.footer} fixed>{d.number} · modèle « {d.template.name} » v{d.template.version} · empreinte {snapshotSha256.slice(0, 16)}</Text>
      </Page>
    </Document>
  )
}
