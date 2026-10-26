// Gabarit PDF commun (devis, facture, acompte, avoir) — @react-pdf/renderer, déjà utilisé par le dépôt.
import { Document, Page, StyleSheet, Text, View } from "@react-pdf/renderer"
import type { DocumentPdfData } from "./document-data"

const s = StyleSheet.create({
  page: { fontFamily: "Helvetica", fontSize: 9, padding: 36, color: "#1e293b" },
  header: { flexDirection: "row", justifyContent: "space-between", borderBottomWidth: 2, borderBottomColor: "#0f3460", paddingBottom: 10, marginBottom: 14 },
  title: { fontSize: 18, fontFamily: "Helvetica-Bold", color: "#0f3460" },
  bold: { fontFamily: "Helvetica-Bold" },
  parties: { flexDirection: "row", justifyContent: "space-between", marginBottom: 14 },
  party: { width: "48%" },
  box: { borderWidth: 1, borderColor: "#e2e8f0", padding: 8, borderRadius: 4 },
  row: { flexDirection: "row", borderBottomWidth: 1, borderBottomColor: "#e2e8f0", paddingVertical: 4 },
  head: { backgroundColor: "#f1f5f9", fontFamily: "Helvetica-Bold" },
  cDes: { width: "40%" }, cUnit: { width: "8%" }, cQty: { width: "9%", textAlign: "right" }, cPu: { width: "13%", textAlign: "right" }, cRem: { width: "8%", textAlign: "right" }, cTva: { width: "8%", textAlign: "right" }, cHt: { width: "14%", textAlign: "right" },
  totals: { marginTop: 10, alignSelf: "flex-end", width: "48%" },
  tRow: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 2 },
  tTotal: { borderTopWidth: 1, borderTopColor: "#0f3460", marginTop: 4, paddingTop: 4, fontSize: 11, fontFamily: "Helvetica-Bold" },
  mention: { fontSize: 7.5, color: "#475569", marginTop: 3 },
  footer: { position: "absolute", bottom: 20, left: 36, right: 36, fontSize: 7, color: "#94a3b8", textAlign: "center" },
  small: { fontSize: 8, color: "#475569" },
})

export function DocumentPdf({ data }: { data: DocumentPdfData }) {
  return (
    <Document title={`${data.title} ${data.number}`}>
      <Page size="A4" style={s.page}>
        <View style={s.header}>
          <View><Text style={s.title}>{data.title}</Text><Text style={[s.bold, { fontSize: 11 }]}>{data.number}</Text></View>
          <View style={{ alignItems: "flex-end" }}>{data.meta.map((m) => <Text key={m.label}><Text style={s.bold}>{m.label} : </Text>{m.value}</Text>)}</View>
        </View>
        <View style={s.parties}>
          <View style={[s.party, s.box]}><Text style={s.bold}>{data.seller.name}</Text>{data.seller.lines.map((l, i) => <Text key={i} style={s.small}>{l}</Text>)}</View>
          <View style={[s.party, s.box]}><Text style={[s.small, { marginBottom: 2 }]}>Client</Text><Text style={s.bold}>{data.buyer.name}</Text>{data.buyer.lines.map((l, i) => <Text key={i} style={s.small}>{l}</Text>)}</View>
        </View>
        {data.subject && <Text style={{ marginBottom: 8 }}><Text style={s.bold}>Objet : </Text>{data.subject}</Text>}
        <View style={[s.row, s.head]}>
          <Text style={s.cDes}>Désignation</Text><Text style={s.cUnit}>Unité</Text><Text style={s.cQty}>Qté</Text><Text style={s.cPu}>PU HT</Text><Text style={s.cRem}>Remise</Text><Text style={s.cTva}>TVA</Text><Text style={s.cHt}>Total HT</Text>
        </View>
        {data.lines.map((l, i) => (
          <View key={i} style={s.row} wrap={false}>
            <View style={s.cDes}><Text>{l.designation}</Text>{l.description && <Text style={s.small}>{l.description}</Text>}</View>
            <Text style={s.cUnit}>{l.unit}</Text><Text style={s.cQty}>{l.quantity}</Text><Text style={s.cPu}>{l.unitPrice}</Text><Text style={s.cRem}>{l.discount}</Text><Text style={s.cTva}>{l.vatRate}</Text><Text style={s.cHt}>{l.lineHT}</Text>
          </View>
        ))}
        <View style={s.totals}>
          <View style={s.tRow}><Text>Sous-total HT</Text><Text>{data.totals.subtotal}</Text></View>
          {data.totals.globalDiscount && <View style={s.tRow}><Text>{data.totals.globalDiscountLabel}</Text><Text>{data.totals.globalDiscount}</Text></View>}
          <View style={[s.tRow, s.bold]}><Text>Total HT</Text><Text>{data.totals.totalHT}</Text></View>
          {data.totals.vat.map((v) => <View key={v.label} style={s.tRow}><Text>{v.label} (base {v.base})</Text><Text>{v.amount}</Text></View>)}
          <View style={s.tRow}><Text>Total TVA</Text><Text>{data.totals.totalVAT}</Text></View>
          <View style={[s.tRow, s.tTotal]}><Text>Total TTC</Text><Text>{data.totals.totalTTC}</Text></View>
        </View>
        {data.extraBlocks?.map((b) => (
          <View key={b.title} style={[s.box, { marginTop: 10 }]}><Text style={s.bold}>{b.title}</Text>{b.rows.map((r, i) => <Text key={i} style={s.small}>{r}</Text>)}</View>
        ))}
        {data.settlement && (
          <View style={[s.box, { marginTop: 10, borderStyle: "dashed" }]}><Text style={s.bold}>{data.settlement.title}</Text>{data.settlement.rows.map((r, i) => <Text key={i} style={s.small}>{r}</Text>)}</View>
        )}
        {data.notes && <View style={{ marginTop: 10 }}><Text style={s.bold}>Notes</Text><Text style={s.small}>{data.notes}</Text></View>}
        <View style={{ marginTop: 12 }}>{data.mentions.map((m, i) => <Text key={i} style={s.mention}>{m}</Text>)}</View>
        {data.signature !== undefined && (
          <View style={[s.box, { marginTop: 14, width: "48%", alignSelf: "flex-end", minHeight: 60 }]}>
            <Text style={s.bold}>Bon pour accord</Text>
            {data.signature ? <Text style={s.small}>Signé en ligne par {data.signature.name} le {data.signature.date}</Text> : <Text style={s.small}>Date, nom et signature du client</Text>}
          </View>
        )}
        {data.footer && <Text style={s.footer} fixed>{data.footer}</Text>}
      </Page>
    </Document>
  )
}
