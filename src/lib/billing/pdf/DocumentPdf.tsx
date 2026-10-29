// Gabarit PDF commun (devis, facture, acompte, avoir) — @react-pdf/renderer, déjà utilisé par le dépôt.
// Refonte du 29/10/2026 (mission devis / identité / présentation) : A4 sobre, marges régulières, hiérarchie claire,
// colonnes numériques alignées à droite, descriptions multilignes, séparations fines, en-tête de tableau répété sur
// chaque page (`fixed`), pied de page fixe avec identité juridique de l'émetteur et pagination, logo de l'entreprise
// émettrice si un logo géré est enregistré. Tout texte passe par `pdfSafe` (polices standard : voir pdf-text.ts).
import { Document, Image, Page, StyleSheet, Text, View } from "@react-pdf/renderer"
import type { DocumentPdfData } from "./document-data"
import { pdfSafe } from "./pdf-text"

const INK = "#1e293b"
const MUTED = "#64748b"
const RULE = "#e2e8f0"
const ACCENT = "#0f3460"

const s = StyleSheet.create({
  // Pas de `lineHeight` sur la page : @react-pdf 4.5 ne rend plus l'élément `fixed` en position absolue (pied de page)
  // lorsqu'un lineHeight est hérité de la Page (vérifié par rendu réel le 29/10/2026).
  page: { fontFamily: "Helvetica", fontSize: 9, color: INK, paddingTop: 40, paddingHorizontal: 44, paddingBottom: 78 },
  header: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 18 },
  logo: { maxWidth: 150, maxHeight: 52, objectFit: "contain", objectPosition: "left top" },
  sellerName: { fontFamily: "Helvetica-Bold", fontSize: 12, color: ACCENT },
  titleBlock: { alignItems: "flex-end" },
  title: { fontFamily: "Helvetica-Bold", fontSize: 18, color: ACCENT, letterSpacing: 0.5 },
  number: { fontFamily: "Helvetica-Bold", fontSize: 11, marginTop: 2 },
  metaTable: { marginTop: 6 },
  metaRow: { flexDirection: "row", justifyContent: "flex-end" },
  metaLabel: { color: MUTED, marginRight: 4 },
  parties: { flexDirection: "row", justifyContent: "space-between", marginBottom: 16 },
  party: { width: "47%" },
  partyLabel: { fontSize: 7.5, color: MUTED, textTransform: "uppercase", letterSpacing: 0.6, marginBottom: 3 },
  partyName: { fontFamily: "Helvetica-Bold", fontSize: 10, marginBottom: 2 },
  partyLine: { color: INK },
  subject: { marginBottom: 10 },
  bold: { fontFamily: "Helvetica-Bold" },
  table: { marginTop: 4 },
  row: { flexDirection: "row", alignItems: "flex-start", borderBottomWidth: 0.5, borderBottomColor: RULE, paddingVertical: 4 },
  head: { borderBottomWidth: 1, borderBottomColor: ACCENT, backgroundColor: "#f8fafc", paddingVertical: 5 },
  headText: { fontFamily: "Helvetica-Bold", fontSize: 8, color: ACCENT },
  cDes: { width: "42%", paddingRight: 6 },
  cUnit: { width: "7%" },
  cQty: { width: "8%", textAlign: "right" },
  cPu: { width: "13%", textAlign: "right" },
  cRem: { width: "8%", textAlign: "right" },
  cTva: { width: "8%", textAlign: "right" },
  cHt: { width: "14%", textAlign: "right" },
  description: { fontSize: 8, color: MUTED, marginTop: 1 },
  totals: { marginTop: 12, alignSelf: "flex-end", width: "46%" },
  tRow: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 2.5, borderBottomWidth: 0.5, borderBottomColor: RULE },
  tMuted: { color: MUTED },
  tTotal: { borderTopWidth: 1.2, borderTopColor: ACCENT, borderBottomWidth: 0, marginTop: 3, paddingTop: 5, fontSize: 11.5, fontFamily: "Helvetica-Bold" },
  section: { marginTop: 14 },
  sectionTitle: { fontFamily: "Helvetica-Bold", fontSize: 8, color: ACCENT, textTransform: "uppercase", letterSpacing: 0.6, marginBottom: 3 },
  mention: { fontSize: 8, color: "#334155", marginBottom: 2 },
  warning: { fontSize: 8, color: "#b45309", marginBottom: 2 },
  box: { borderWidth: 0.6, borderColor: RULE, borderRadius: 3, padding: 8 },
  signature: { marginTop: 16, width: "47%", alignSelf: "flex-end", minHeight: 70 },
  small: { fontSize: 8, color: MUTED },
  footer: { position: "absolute", bottom: 26, left: 44, right: 44, borderTopWidth: 0.5, borderTopColor: RULE, paddingTop: 5 },
  footerText: { fontSize: 7, color: MUTED, textAlign: "center" },
  footerPage: { fontSize: 7, color: MUTED, textAlign: "right", marginTop: 2 },
})

const t = (v: string | null | undefined) => pdfSafe(v ?? "")

export function DocumentPdf({ data }: { data: DocumentPdfData }) {
  const logo = data.logoDataUrl ?? null
  return (
    <Document title={t(`${data.title} ${data.number}`)} author={t(data.seller.name)} creator="Planificator">
      <Page size="A4" style={s.page}>
        {/* En-tête : identité émettrice (logo ou dénomination) à gauche, type / numéro / métadonnées à droite */}
        <View style={s.header}>
          <View style={{ width: "48%" }}>
            {logo ? <Image src={logo} style={s.logo} /> : <Text style={s.sellerName}>{t(data.seller.name)}</Text>}
          </View>
          <View style={s.titleBlock}>
            <Text style={s.title}>{t(data.title)}</Text>
            <Text style={s.number}>{t(data.number)}</Text>
            <View style={s.metaTable}>
              {data.meta.map((m) => (
                <View key={m.label} style={s.metaRow}><Text style={s.metaLabel}>{t(m.label)} :</Text><Text>{t(m.value)}</Text></View>
              ))}
            </View>
          </View>
        </View>

        {/* Parties */}
        <View style={s.parties}>
          <View style={s.party}>
            <Text style={s.partyLabel}>Émetteur</Text>
            <Text style={s.partyName}>{t(data.seller.name)}</Text>
            {data.seller.lines.map((l, i) => <Text key={i} style={s.partyLine}>{t(l)}</Text>)}
          </View>
          <View style={s.party}>
            <Text style={s.partyLabel}>Client</Text>
            <Text style={s.partyName}>{t(data.buyer.name)}</Text>
            {data.buyer.lines.map((l, i) => <Text key={i} style={s.partyLine}>{t(l)}</Text>)}
          </View>
        </View>

        {data.subject && <Text style={s.subject}><Text style={s.bold}>Objet : </Text>{t(data.subject)}</Text>}

        {/* Tableau des lignes : en-tête répété sur chaque page, lignes insécables */}
        <View style={s.table}>
          <View style={[s.row, s.head]} fixed>
            <Text style={[s.cDes, s.headText]}>Désignation</Text>
            <Text style={[s.cUnit, s.headText]}>Unité</Text>
            <Text style={[s.cQty, s.headText]}>Qté</Text>
            <Text style={[s.cPu, s.headText]}>PU HT</Text>
            <Text style={[s.cRem, s.headText]}>Remise</Text>
            <Text style={[s.cTva, s.headText]}>TVA</Text>
            <Text style={[s.cHt, s.headText]}>Total HT</Text>
          </View>
          {data.lines.map((l, i) => (
            <View key={i} style={s.row} wrap={false} minPresenceAhead={30}>
              <View style={s.cDes}>
                <Text>{t(l.designation)}</Text>
                {l.description ? <Text style={s.description}>{t(l.description)}</Text> : null}
              </View>
              <Text style={s.cUnit}>{t(l.unit)}</Text>
              <Text style={s.cQty}>{t(l.quantity)}</Text>
              <Text style={s.cPu}>{t(l.unitPrice)}</Text>
              <Text style={s.cRem}>{t(l.discount)}</Text>
              <Text style={s.cTva}>{t(l.vatRate)}</Text>
              <Text style={s.cHt}>{t(l.lineHT)}</Text>
            </View>
          ))}
        </View>

        {/* Totaux */}
        <View style={s.totals} wrap={false}>
          <View style={s.tRow}><Text style={s.tMuted}>Sous-total HT</Text><Text>{t(data.totals.subtotal)}</Text></View>
          {data.totals.globalDiscount && <View style={s.tRow}><Text style={s.tMuted}>{t(data.totals.globalDiscountLabel)}</Text><Text>{t(data.totals.globalDiscount)}</Text></View>}
          <View style={[s.tRow, s.bold]}><Text>Total HT</Text><Text>{t(data.totals.totalHT)}</Text></View>
          {data.totals.vat.map((v) => <View key={v.label} style={s.tRow}><Text style={s.tMuted}>{t(v.label)} (base {t(v.base)})</Text><Text>{t(v.amount)}</Text></View>)}
          <View style={s.tRow}><Text style={s.tMuted}>Total TVA</Text><Text>{t(data.totals.totalVAT)}</Text></View>
          <View style={[s.tRow, s.tTotal]}><Text>Total TTC</Text><Text>{t(data.totals.totalTTC)}</Text></View>
        </View>

        {data.extraBlocks?.map((b) => (
          <View key={b.title} style={[s.box, s.section]} wrap={false}><Text style={s.bold}>{t(b.title)}</Text>{b.rows.map((r, i) => <Text key={i} style={s.small}>{t(r)}</Text>)}</View>
        ))}
        {data.settlement && (
          <View style={[s.box, s.section, { borderStyle: "dashed" }]} wrap={false}><Text style={s.bold}>{t(data.settlement.title)}</Text>{data.settlement.rows.map((r, i) => <Text key={i} style={s.small}>{t(r)}</Text>)}</View>
        )}
        {data.notes && <View style={s.section}><Text style={s.sectionTitle}>Notes</Text><Text style={s.mention}>{t(data.notes)}</Text></View>}

        {/* Conditions et mentions : lisibles, groupées */}
        {data.mentions.length > 0 && (
          <View style={s.section}>
            <Text style={s.sectionTitle}>{t(data.mentionsTitle ?? "Conditions et mentions")}</Text>
            {data.mentions.map((m, i) => <Text key={i} style={s.mention}>{t(m)}</Text>)}
          </View>
        )}
        {data.draftWarnings && data.draftWarnings.length > 0 && (
          <View style={s.section}>
            <Text style={s.sectionTitle}>Brouillon — à compléter avant émission</Text>
            {data.draftWarnings.map((w, i) => <Text key={i} style={s.warning}>{t(w)}</Text>)}
          </View>
        )}

        {data.signature !== undefined && (
          <View style={[s.box, s.signature]} wrap={false}>
            <Text style={s.bold}>Bon pour accord</Text>
            {data.signature ? <Text style={s.small}>Signé en ligne par {t(data.signature.name)} le {t(data.signature.date)}</Text> : <Text style={s.small}>Date, nom et signature du client</Text>}
          </View>
        )}

        {/* Pied de page fixe : identité juridique exacte de l'émetteur, pied personnalisé, pagination */}
        <View style={s.footer} fixed>
          {data.legalFooter ? <Text style={s.footerText}>{t(data.legalFooter)}</Text> : null}
          {data.footer ? <Text style={s.footerText}>{t(data.footer)}</Text> : null}
          <Text style={s.footerPage} render={({ pageNumber, totalPages }) => `${t(data.number)} — page ${pageNumber} / ${totalPages}`} />
        </View>
      </Page>
    </Document>
  )
}
