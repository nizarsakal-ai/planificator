// Lot G Planificator V2 : PDF d'un document généré, construit depuis son instantané figé et sa validation stockée (aucune
// lecture du modèle vivant) : un même document donne toujours le même contenu. Un document non émis porte la mention
// « projet » ou « refusé ». Les PDF existants du logiciel ne sont pas modifiés.
// Lot G2 : sous-titres, gras, listes, tableaux (en-tête sur fond teinté, lignes insécables), sauts de page ; pied de page
// avec les coordonnées de l'émetteur figées dans l'instantané et la pagination ; logo géré de l'entreprise en en-tête.
// Le logo est celui FIGÉ dans l'instantané à la génération (revue Codex du 23/11/2026) : il fait partie du contenu empreint,
// le PDF ne relit jamais le logo courant de la société. Tout texte passe par `pdfSafe` (polices standard).
// Correction G2 : le pied de page du lot G ne s'imprimait pas (interligne déclaré sur la page, voir le style `page`).
import { Document, Image, Page, StyleSheet, Text, View } from "@react-pdf/renderer"
import type { Block, DocumentSnapshot, Run } from "@/lib/document-studio/studio.format"
import { pdfSafe } from "@/lib/billing/pdf/pdf-text"

const NAVY = "#0f3460"
const s = StyleSheet.create({
  // Pas de `lineHeight` sur la page : @react-pdf 4.5 ne rend plus l'élément `fixed` en position absolue (pied de page) quand
  // la page en porte un (constat déjà fait pour les devis et factures). L'interligne est porté par les styles de texte.
  page: { fontFamily: "Helvetica", fontSize: 10.5, paddingTop: 48, paddingHorizontal: 48, paddingBottom: 64, color: "#1e293b" },
  header: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 22, paddingBottom: 12, borderBottomWidth: 2, borderBottomColor: NAVY },
  brand: { fontSize: 15, fontFamily: "Helvetica-Bold", color: NAVY },
  logo: { maxWidth: 150, maxHeight: 52, objectFit: "contain", objectPosition: "left top" },
  number: { fontSize: 9, color: "#64748b", textAlign: "right" },
  title: { fontSize: 15, fontFamily: "Helvetica-Bold", color: NAVY, marginBottom: 14 },
  heading: { fontSize: 11.5, fontFamily: "Helvetica-Bold", color: NAVY, marginTop: 8, marginBottom: 4 },
  subheading: { fontSize: 10.5, fontFamily: "Helvetica-Bold", color: "#334155", marginTop: 4, marginBottom: 3 },
  para: { marginBottom: 5, lineHeight: 1.4 },
  bold: { fontFamily: "Helvetica-Bold" },
  list: { marginBottom: 8 },
  item: { flexDirection: "row" },
  marker: { width: 22, lineHeight: 1.4 },
  itemText: { flex: 1, lineHeight: 1.4 },
  table: { marginBottom: 10, borderWidth: 1, borderColor: "#cbd5e1" },
  row: { flexDirection: "row", borderTopWidth: 1, borderTopColor: "#e2e8f0" },
  headRow: { flexDirection: "row", backgroundColor: "#eef2f7" },
  cell: { flex: 1, paddingVertical: 4, paddingHorizontal: 6, fontSize: 9.5 },
  stamp: { fontSize: 12, fontFamily: "Helvetica-Bold", color: "#b91c1c", borderWidth: 1, borderColor: "#b91c1c", padding: 6, marginBottom: 12, textAlign: "center" },
  signBox: { marginTop: 22, width: "50%", alignSelf: "flex-end", borderWidth: 1, borderColor: "#cbd5e1", padding: 8 },
  signature: { width: 180, height: 70, objectFit: "contain", marginTop: 4 },
  footer: { position: "absolute", bottom: 22, left: 48, right: 48, borderTopWidth: 0.5, borderTopColor: "#cbd5e1", paddingTop: 5 },
  footerText: { fontSize: 7, color: "#94a3b8", textAlign: "center" },
})
const dayFr = (iso: string) => new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(`${iso}T00:00:00Z`))
const instantFr = (d: Date) => new Intl.DateTimeFormat("fr-FR", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "Europe/Paris" }).format(d)
const t = (v: string | null | undefined) => pdfSafe(v ?? "")

/** Ligne de coordonnées de l'émetteur (pied de page) : uniquement les données figées présentes ; `null` s'il n'y en a pas. */
export function issuerLine(d: Pick<DocumentSnapshot, "company" | "issuer">): string | null {
  const i = d.issuer
  if (!i) return null
  const parts = [d.company, i.address, i.siret ? `SIRET ${i.siret}` : null, i.phone, i.email].filter((p): p is string => !!p)
  return parts.length > 1 ? parts.join(" — ") : null
}

function Runs({ text, runs }: { text: string; runs?: Run[] }) {
  if (!runs) return <>{t(text)}</>
  return <>{runs.map((r, i) => (r.bold ? <Text key={i} style={s.bold}>{t(r.text)}</Text> : <Text key={i}>{t(r.text)}</Text>))}</>
}

function BlockView({ b }: { b: Block }) {
  if (b.kind === "pagebreak") return <View break />
  if (b.kind === "heading") return <Text style={s.heading} minPresenceAhead={30}>{t(b.text)}</Text>
  if (b.kind === "subheading") return <Text style={s.subheading} minPresenceAhead={30}>{t(b.text)}</Text>
  if (b.kind === "list" && b.items) {
    return (
      <View style={s.list}>
        {b.items.map((it, i) => (
          <View key={i} style={s.item} wrap={false}>
            <Text style={s.marker}>{t(it.marker ?? "•")}</Text>
            <Text style={s.itemText}><Runs text={it.text} runs={it.runs} /></Text>
          </View>
        ))}
      </View>
    )
  }
  if (b.kind === "table" && b.rows) {
    return (
      <View style={s.table}>
        {b.rows.map((r, i) => (
          <View key={i} style={i === 0 ? s.headRow : s.row} wrap={false}>
            {r.map((c, j) => <Text key={j} style={i === 0 ? [s.cell, s.bold] : s.cell}>{t(c)}</Text>)}
          </View>
        ))}
      </View>
    )
  }
  return <Text style={s.para}><Runs text={b.text} runs={b.runs} /></Text>
}

export interface DocumentPdfProps {
  snapshot: DocumentSnapshot; snapshotSha256: string; status: "PENDING_APPROVAL" | "ISSUED" | "REJECTED"
  approval: { signerName: string; approvedAt: Date; signaturePng: Buffer } | null
  /** Logo géré de l'entreprise (data URL PNG) ; absent : dénomination en texte. */
}
export function GeneratedDocumentPdf({ snapshot: d, snapshotSha256, status, approval }: DocumentPdfProps) {
  const date = new Date(`${d.issuedOn}T00:00:00Z`)
  const issuer = issuerLine(d)
  const trace = `${d.number} · modèle « ${d.template.name} » v${d.template.version} · empreinte ${snapshotSha256.slice(0, 16)}`
  return (
    <Document title={t(`${d.title} — ${d.number}`)} author={t(d.company)} creator="Planificator" producer="Planificator" creationDate={date} modificationDate={date}>
      <Page size="A4" style={s.page}>
        <View style={s.header}>
          {d.logo ? <Image src={d.logo} style={s.logo} /> : <Text style={s.brand}>{t(d.company)}</Text>}
          <View><Text style={s.number}>{t(d.number)}</Text><Text style={s.number}>{t(dayFr(d.issuedOn))}</Text></View>
        </View>
        {status === "PENDING_APPROVAL" ? <Text style={s.stamp}>PROJET — EN ATTENTE DE VALIDATION</Text> : null}
        {status === "REJECTED" ? <Text style={s.stamp}>DOCUMENT REFUSÉ — SANS VALEUR</Text> : null}
        <Text style={s.title}>{t(d.title)}</Text>
        {d.blocks.map((b, i) => <BlockView key={i} b={b} />)}
        {approval ? (
          <View style={s.signBox} wrap={false}>
            <Text>{t(`Validé par ${approval.signerName}, le ${instantFr(approval.approvedAt)}`)}</Text>
            <Image style={s.signature} src={approval.signaturePng} />
          </View>
        ) : null}
        <View style={s.footer} fixed>
          {issuer ? <Text style={s.footerText}>{t(issuer)}</Text> : null}
          <Text style={[s.footerText, { marginTop: 2 }]} render={({ pageNumber, totalPages }) => t(`${trace} · page ${pageNumber} / ${totalPages}`)} />
        </View>
      </Page>
    </Document>
  )
}
