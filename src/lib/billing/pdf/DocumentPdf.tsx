// Gabarit PDF commun (devis, facture, acompte, avoir) — @react-pdf/renderer, déjà utilisé par le dépôt.
// Refonte du 29/10/2026 (mission devis / identité / présentation) : A4 sobre, marges régulières, hiérarchie claire,
// colonnes numériques alignées à droite, descriptions multilignes, séparations fines, en-tête de tableau répété sur
// chaque page (`fixed`), pied de page fixe avec identité juridique de l'émetteur et pagination, logo de l'entreprise
// émettrice si un logo géré est enregistré. Tout texte passe par `pdfSafe` (polices standard : voir pdf-text.ts).
// 20/11/2026 — modèles de design (Classique, Moderne, Bandeau, Épuré) × 2 couleurs, format Rapide/Complet, options
// d'affichage (identifiants client, coordonnées bancaires) et tampon de statut. Le contenu est identique d'un modèle à
// l'autre : seule la présentation change. « Classique » avec le design par défaut = rendu historique, à l'identique.
import { Document, Image, Page, StyleSheet, Text, View } from "@react-pdf/renderer"
import type { DocumentPdfData, PdfLine } from "./document-data"
import { pdfSafe } from "./pdf-text"
import { FRENCH_PREVAILS_EN, translate } from "./pdf-i18n"
import { BANK_MENTION, DEFAULT_PDF_DESIGN, buyerLinesFor, effectiveLayout, tint, type PdfDesign, type PdfLayout, type PdfStamp } from "./design"

const INK = "#1e293b"
const MUTED = "#64748b"
const RULE = "#e2e8f0"
const WHITE = "#ffffff"
const STAMP_COLOR: Record<PdfStamp["tone"], string> = { success: "#16a34a", danger: "#dc2626" }

const t = (v: string | null | undefined) => pdfSafe(v ?? "")

// ── Styles ─────────────────────────────────────────────────────────────────────────────────────────────────────────
// Styles communs (identiques au rendu historique), puis surcharges propres à chaque modèle.
function baseStyles(accent: string) {
  return StyleSheet.create({
    // Pas de `lineHeight` sur la page : @react-pdf 4.5 ne rend plus l'élément `fixed` en position absolue (pied de page)
    // lorsqu'un lineHeight est hérité de la Page (vérifié par rendu réel le 29/10/2026).
    page: { fontFamily: "Helvetica", fontSize: 9, color: INK, paddingTop: 40, paddingHorizontal: 44, paddingBottom: 78 },
    header: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 18 },
    logo: { maxWidth: 150, maxHeight: 52, objectFit: "contain", objectPosition: "left top" },
    sellerName: { fontFamily: "Helvetica-Bold", fontSize: 12, color: accent },
    titleBlock: { alignItems: "flex-end" },
    title: { fontFamily: "Helvetica-Bold", fontSize: 18, color: accent, letterSpacing: 0.5 },
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
    head: { borderBottomWidth: 1, borderBottomColor: accent, backgroundColor: "#f8fafc", paddingVertical: 5 },
    headText: { fontFamily: "Helvetica-Bold", fontSize: 8, color: accent },
    num: { textAlign: "right" },
    description: { fontSize: 8, color: MUTED, marginTop: 1 },
    totals: { marginTop: 12, alignSelf: "flex-end", width: "46%" },
    tRow: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 2.5, borderBottomWidth: 0.5, borderBottomColor: RULE },
    tLabel: { color: MUTED },
    tValue: {},
    tTotal: { borderTopWidth: 1.2, borderTopColor: accent, borderBottomWidth: 0, marginTop: 3, paddingTop: 5, fontSize: 11.5, fontFamily: "Helvetica-Bold" },
    tTotalLabel: {},
    tTotalValue: {},
    section: { marginTop: 14 },
    sectionTitle: { fontFamily: "Helvetica-Bold", fontSize: 8, color: accent, textTransform: "uppercase", letterSpacing: 0.6, marginBottom: 3 },
    mention: { fontSize: 8, color: "#334155", marginBottom: 2 },
    warning: { fontSize: 8, color: "#b45309", marginBottom: 2 },
    box: { borderWidth: 0.6, borderColor: RULE, borderRadius: 3, padding: 8 },
    signature: { marginTop: 16, width: "47%", alignSelf: "flex-end", minHeight: 70 },
    small: { fontSize: 8, color: MUTED },
    footer: { position: "absolute", bottom: 26, left: 44, right: 44, borderTopWidth: 0.5, borderTopColor: RULE, paddingTop: 5 },
    footerText: { fontSize: 7, color: MUTED, textAlign: "center" },
    footerPage: { fontSize: 7, color: MUTED, textAlign: "right", marginTop: 2 },
    stamp: { borderWidth: 1.6, borderRadius: 6, paddingVertical: 4, paddingHorizontal: 14, transform: "rotate(-7deg)", backgroundColor: WHITE },
    stampText: { fontFamily: "Helvetica-Bold", fontSize: 15, letterSpacing: 0.8 },
  })
}
type Styles = ReturnType<typeof baseStyles>

/** Surcharges par modèle (fusionnées avec les styles communs, propriété par propriété). */
function templateOverrides(d: PdfDesign): Partial<Record<keyof Styles, object>> {
  const p = d.primary, s = d.secondary
  switch (d.template) {
    case "MODERN":
      return {
        table: { marginTop: 8 },
        head: { backgroundColor: p, borderRadius: 6, borderBottomWidth: 0, paddingVertical: 6, paddingHorizontal: 6, marginBottom: 2 },
        headText: { color: WHITE, fontSize: 8.5 },
        row: { borderBottomColor: tint(p, 0.12), paddingHorizontal: 6, paddingVertical: 5 },
        totals: { marginTop: 14, width: "48%" },
        tRow: { borderBottomWidth: 0, paddingVertical: 3 },
        tLabel: { color: s },
        tValue: { color: s, fontFamily: "Helvetica-Bold" },
        tTotal: { borderTopWidth: 0, marginTop: 6, paddingTop: 0, alignItems: "center", fontSize: 13 },
        tTotalLabel: { color: s },
        tTotalValue: { color: s, backgroundColor: tint(s, 0.12), borderRadius: 9, paddingVertical: 4, paddingHorizontal: 10 },
        sectionTitle: { color: p },
        box: { borderColor: tint(p, 0.3), borderRadius: 6 },
      }
    case "BAND":
      return {
        head: { borderBottomWidth: 1.5, borderBottomColor: p, backgroundColor: tint(p, 0.08), paddingVertical: 5, paddingHorizontal: 4 },
        headText: { color: p },
        row: { paddingHorizontal: 4 },
        partyLabel: { color: s, fontFamily: "Helvetica-Bold" },
        tTotal: { borderTopWidth: 0, backgroundColor: p, borderRadius: 4, marginTop: 6, paddingTop: 6, paddingBottom: 6, paddingHorizontal: 8, color: WHITE },
        tTotalLabel: { color: WHITE },
        tTotalValue: { color: WHITE },
        tValue: {},
        sectionTitle: { color: s },
        box: { borderColor: tint(p, 0.35) },
      }
    case "MINIMAL":
      return {
        head: { backgroundColor: WHITE, borderBottomWidth: 1, borderBottomColor: p, paddingVertical: 5 },
        headText: { color: INK, fontSize: 7.5, textTransform: "uppercase", letterSpacing: 0.5 },
        row: { borderBottomColor: "#f1f5f9", paddingVertical: 5 },
        tRow: { borderBottomColor: "#f1f5f9" },
        tTotal: { borderTopWidth: 1.5, borderTopColor: s, color: s },
        tTotalLabel: { color: s },
        tTotalValue: { color: s },
        sectionTitle: { color: INK },
        partyLabel: { color: MUTED },
      }
    default:
      // CLASSIQUE : la couleur secondaire n'est utilisée que pour le total TTC (identique au rendu historique par défaut).
      return { tTotalLabel: { color: s === p ? INK : s }, tTotalValue: { color: s === p ? INK : s } }
  }
}

function makeStyles(d: PdfDesign): Styles {
  const base = baseStyles(d.primary) as Record<string, object>
  const over = templateOverrides(d) as Record<string, object | undefined>
  const merged: Record<string, object> = {}
  for (const k of Object.keys(base)) merged[k] = over[k] ? { ...base[k], ...over[k] } : base[k]
  return merged as Styles
}

// ── Colonnes du tableau ───────────────────────────────────────────────────────────────────────────────────────────
interface Column { key: keyof PdfLine; label: string; width: number; numeric: boolean }

/**
 * Colonnes selon le format effectif. Classique : colonnes historiques inchangées. Autres modèles : la colonne « Remise »
 * n'apparaît que si au moins une ligne porte une remise (sa largeur revient à la désignation).
 */
function columnsFor(layout: PdfLayout, template: PdfDesign["template"], lines: readonly PdfLine[]): Column[] {
  if (layout === "QUICK") return [
    { key: "designation", label: "Désignation", width: 70, numeric: false },
    { key: "vatRate", label: "TVA", width: 12, numeric: true },
    { key: "lineHT", label: "Montant HT", width: 18, numeric: true },
  ]
  const showDiscount = template === "CLASSIC" || lines.some((l) => l.discount.trim() !== "")
  return [
    { key: "designation", label: "Désignation", width: showDiscount ? 42 : 50, numeric: false },
    { key: "unit", label: "Unité", width: 7, numeric: false },
    { key: "quantity", label: "Qté", width: 8, numeric: true },
    { key: "unitPrice", label: "PU HT", width: 13, numeric: true },
    ...(showDiscount ? [{ key: "discount" as const, label: "Remise", width: 8, numeric: true }] : []),
    { key: "vatRate", label: "TVA", width: 8, numeric: true },
    { key: "lineHT", label: "Total HT", width: 14, numeric: true },
  ]
}

// ── Blocs ─────────────────────────────────────────────────────────────────────────────────────────────────────────
/** Texte produit par l'application, traduit selon la langue du design (texte inconnu ⇒ inchangé). */
const L = (d: PdfDesign, v: string | null | undefined) => pdfSafe(translate(v ?? "", d.language))

function Stamp({ stamp, d, s }: { stamp: PdfStamp; d: PdfDesign; s: Styles }) {
  const c = STAMP_COLOR[stamp.tone]
  return <View style={[s.stamp, { borderColor: c }]}><Text style={[s.stampText, { color: c }]}>{L(d, stamp.label)}</Text></View>
}

function Meta({ data, d, s, color, align = "flex-end" }: { data: DocumentPdfData; d: PdfDesign; s: Styles; color?: string; align?: "flex-end" | "flex-start" }) {
  return (
    <View style={s.metaTable}>
      {data.meta.map((m) => (
        <View key={m.label} style={[s.metaRow, { justifyContent: align }]}>
          <Text style={[s.metaLabel, color ? { color } : {}]}>{L(d, m.label)} :</Text><Text style={color ? { color } : {}}>{L(d, m.value)}</Text>
        </View>
      ))}
    </View>
  )
}

function Party({ label, name, lines, s }: { label: string | null; name: string; lines: readonly string[]; s: Styles }) {
  return (
    <View style={s.party}>
      {label ? <Text style={s.partyLabel}>{label}</Text> : null}
      <Text style={s.partyName}>{t(name)}</Text>
      {lines.map((l, i) => <Text key={i} style={s.partyLine}>{t(l)}</Text>)}
    </View>
  )
}

/** Destinataire : identité (identifiants selon l'option) puis adresse de livraison si elle est renseignée et affichée. */
function Buyer({ data, d, s, withLabel }: { data: DocumentPdfData; d: PdfDesign; s: Styles; withLabel: boolean }) {
  const delivery = d.showDeliveryAddress && data.deliveryAddress?.trim() ? data.deliveryAddress.trim() : null
  return (
    <View style={s.party}>
      {withLabel ? <Text style={s.partyLabel}>{L(d, data.partyLabels?.buyer ?? "Client")}</Text> : null}
      <Text style={s.partyName}>{t(data.buyer.name)}</Text>
      {buyerLinesFor(data.buyer.lines, d.showClientIds).map((l, i) => <Text key={i} style={s.partyLine}>{t(l)}</Text>)}
      {delivery ? (
        <View style={{ marginTop: 5 }}>
          <Text style={s.partyLabel}>{L(d, "Adresse de livraison")}</Text>
          {delivery.split(/\r?\n/).map((l, i) => <Text key={i} style={s.partyLine}>{t(l)}</Text>)}
        </View>
      ) : null}
    </View>
  )
}

function Parties({ data, d, s }: { data: DocumentPdfData; d: PdfDesign; s: Styles }) {
  return (
    <View style={s.parties}>
      <Party label={L(d, data.partyLabels?.seller ?? "Émetteur")} name={data.seller.name} lines={data.seller.lines} s={s} />
      <Buyer data={data} d={d} s={s} withLabel />
    </View>
  )
}

/** Tableau : lignes de facturation (colonnes selon le format) ou tableau propre au document (bon de livraison…). */
function Lines({ data, d, s }: { data: DocumentPdfData; d: PdfDesign; s: Styles }) {
  if (data.table) {
    const cols = data.table.columns
    return (
      <View style={s.table}>
        <View style={[s.row, s.head]} fixed>
          {cols.map((c, i) => <Text key={c.key} style={[{ width: `${c.width}%` }, i === 0 ? { paddingRight: 6 } : {}, c.numeric ? s.num : {}, s.headText]}>{L(d, c.label)}</Text>)}
        </View>
        {data.table.rows.map((r, ri) => (
          <View key={ri} style={s.row} wrap={false} minPresenceAhead={30}>
            {cols.map((c, i) => i === 0
              ? <View key={c.key} style={{ width: `${c.width}%`, paddingRight: 6 }}><Text>{t(r.cells[c.key])}</Text>{r.description ? <Text style={s.description}>{t(r.description)}</Text> : null}</View>
              : <Text key={c.key} style={[{ width: `${c.width}%` }, c.numeric ? s.num : {}]}>{t(r.cells[c.key])}</Text>)}
          </View>
        ))}
      </View>
    )
  }
  const cols = columnsFor(effectiveLayout(d, data.lines), d.template, data.lines)
  return (
    <View style={s.table}>
      {/* En-tête répété sur chaque page, lignes insécables */}
      <View style={[s.row, s.head]} fixed>
        {cols.map((c) => <Text key={c.key} style={[{ width: `${c.width}%` }, c.key === "designation" ? { paddingRight: 6 } : {}, c.numeric ? s.num : {}, s.headText]}>{L(d, c.label)}</Text>)}
      </View>
      {data.lines.map((l, i) => (
        <View key={i} style={s.row} wrap={false} minPresenceAhead={30}>
          {cols.map((c) => c.key === "designation"
            ? (
              <View key={c.key} style={{ width: `${c.width}%`, paddingRight: 6 }}>
                <Text>{t(l.designation)}</Text>
                {l.description ? <Text style={s.description}>{t(l.description)}</Text> : null}
              </View>
            )
            : <Text key={c.key} style={[{ width: `${c.width}%` }, c.numeric ? s.num : {}, c.key === "lineHT" && d.template !== "CLASSIC" ? s.bold : {}]}>{t(l[c.key] as string)}</Text>)}
        </View>
      ))}
    </View>
  )
}

function Totals({ data, d, s }: { data: DocumentPdfData; d: PdfDesign; s: Styles }) {
  if (data.hideTotals) return null
  const totals = data.totals
  const row = (label: string, value: string) => (
    <View key={label} style={s.tRow}><Text style={s.tLabel}>{label}</Text><Text style={s.tValue}>{t(value)}</Text></View>
  )
  return (
    <View style={s.totals} wrap={false}>
      {row(L(d, "Sous-total HT"), totals.subtotal)}
      {totals.globalDiscount ? row(L(d, totals.globalDiscountLabel ?? "Remise globale"), totals.globalDiscount) : null}
      <View style={[s.tRow, s.bold]}><Text style={d.template === "CLASSIC" ? s.bold : [s.tLabel, s.bold]}>{L(d, "Total HT")}</Text><Text style={[s.tValue, s.bold]}>{t(totals.totalHT)}</Text></View>
      {totals.vat.map((v) => row(`${L(d, v.label)} (base ${t(v.base)})`, v.amount))}
      {row(L(d, "Total TVA"), totals.totalVAT)}
      <View style={[s.tRow, s.tTotal]}><Text style={s.tTotalLabel}>{L(d, "Total TTC")}</Text><Text style={s.tTotalValue}>{t(totals.totalTTC)}</Text></View>
    </View>
  )
}

/** Blocs après les totaux : identiques pour tous les modèles (contenu documentaire inchangé). */
function Sections({ data, d, s }: { data: DocumentPdfData; d: PdfDesign; s: Styles }) {
  const bank = d.showBankDetails && data.bank ? data.bank : null
  // L'encadré bancaire reprend l'information de la mention « Règlement par virement : IBAN … » : jamais affichée deux fois.
  const baseMentions = bank ? data.mentions.filter((m) => !BANK_MENTION.test(m)) : data.mentions
  const mentions = d.language === "EN" && baseMentions.length > 0 ? [...baseMentions, FRENCH_PREVAILS_EN] : baseMentions
  const delivery = data.signatureKind === "delivery"
  return (
    <>
      {data.extraBlocks?.map((b) => (
        <View key={b.title} style={[s.box, s.section]} wrap={false}><Text style={s.bold}>{L(d, b.title)}</Text>{b.rows.map((r, i) => <Text key={i} style={s.small}>{L(d, r)}</Text>)}</View>
      ))}
      {data.settlement && (
        <View style={[s.box, s.section, { borderStyle: "dashed" }]} wrap={false}><Text style={s.bold}>{L(d, data.settlement.title)}</Text>{data.settlement.rows.map((r, i) => <Text key={i} style={s.small}>{L(d, r)}</Text>)}</View>
      )}
      {bank && (
        <View style={[s.box, s.section]} wrap={false}>
          <Text style={s.sectionTitle}>{L(d, "Coordonnées bancaires")}</Text>
          <Text style={s.mention}>{L(d, "Titulaire")} : {t(data.seller.name)}</Text>
          <Text style={s.mention}>IBAN : {t(bank.iban)}</Text>
          {bank.bic ? <Text style={s.mention}>BIC : {t(bank.bic)}</Text> : null}
        </View>
      )}
      {data.notes && <View style={s.section}><Text style={s.sectionTitle}>{L(d, "Notes")}</Text><Text style={s.mention}>{t(data.notes)}</Text></View>}

      {/* Conditions et mentions : lisibles, groupées */}
      {mentions.length > 0 && (
        <View style={s.section}>
          <Text style={s.sectionTitle}>{L(d, data.mentionsTitle ?? "Conditions et mentions")}</Text>
          {mentions.map((m, i) => <Text key={i} style={s.mention}>{L(d, m)}</Text>)}
        </View>
      )}
      {data.draftWarnings && data.draftWarnings.length > 0 && (
        <View style={s.section}>
          <Text style={s.sectionTitle}>{L(d, "Brouillon — à compléter avant émission")}</Text>
          {data.draftWarnings.map((w, i) => <Text key={i} style={s.warning}>{t(w)}</Text>)}
        </View>
      )}

      {data.signature !== undefined && (
        <View style={[s.box, s.signature]} wrap={false}>
          <Text style={s.bold}>{L(d, delivery ? "Réception de la livraison" : "Bon pour accord")}</Text>
          {data.signature
            ? <Text style={s.small}>{L(d, `${delivery ? "Reçu par" : "Signé en ligne par"} ${data.signature.name} le ${data.signature.date}`)}</Text>
            : <Text style={s.small}>{L(d, delivery ? "Date, nom et signature du destinataire" : "Date, nom et signature du client")}</Text>}
        </View>
      )}
    </>
  )
}

/** Pied de page fixe : identité juridique exacte de l'émetteur, pied personnalisé, pagination. */
function Footer({ data, s }: { data: DocumentPdfData; s: Styles }) {
  return (
    <View style={s.footer} fixed>
      {data.legalFooter ? <Text style={s.footerText}>{t(data.legalFooter)}</Text> : null}
      {data.footer ? <Text style={s.footerText}>{t(data.footer)}</Text> : null}
      <Text style={s.footerPage} render={({ pageNumber, totalPages }) => `${t(data.number)} — page ${pageNumber} / ${totalPages}`} />
    </View>
  )
}

function Subject({ data, d, s }: { data: DocumentPdfData; d: PdfDesign; s: Styles }) {
  return data.subject ? <Text style={s.subject}><Text style={s.bold}>{L(d, "Objet")} : </Text>{t(data.subject)}</Text> : null
}

/** Intitulé libre du document (sous le titre légal, qui reste « FACTURE », « DEVIS »…). */
function Subtitle({ data, color, align = "right" }: { data: DocumentPdfData; color?: string; align?: "right" | "left" }) {
  return data.subtitle?.trim() ? <Text style={{ fontSize: 10, marginTop: 2, textAlign: align, color: color ?? INK }}>{t(data.subtitle.trim())}</Text> : null
}

// ── En-têtes propres à chaque modèle ──────────────────────────────────────────────────────────────────────────────
function ClassicHeader({ data, d, s }: { data: DocumentPdfData; d: PdfDesign; s: Styles }) {
  const logo = data.logoDataUrl ?? null
  return (
    <>
      {/* En-tête : identité émettrice (logo ou dénomination) à gauche, type / numéro / métadonnées à droite */}
      <View style={s.header}>
        <View style={{ width: "48%" }}>
          {logo ? <Image src={logo} style={s.logo} /> : <Text style={s.sellerName}>{t(data.seller.name)}</Text>}
        </View>
        <View style={s.titleBlock}>
          <Text style={s.title}>{L(d, data.title)}</Text>
          <Subtitle data={data} />
          <Text style={s.number}>{t(data.number)}</Text>
          <Meta data={data} d={d} s={s} />
        </View>
      </View>
      <Parties data={data} d={d} s={s} />
    </>
  )
}

/** Moderne : logo et tampon en tête, client en haut à droite, émetteur à gauche, titre et références au-dessus du tableau. */
function ModernHeader({ data, d, s }: { data: DocumentPdfData; d: PdfDesign; s: Styles }) {
  const logo = data.logoDataUrl ?? null
  return (
    <>
      <View style={[s.header, { marginBottom: 10 }]}>
        <View style={{ width: "50%" }}>
          {logo ? <Image src={logo} style={s.logo} /> : <Text style={[s.sellerName, { fontSize: 14 }]}>{t(data.seller.name)}</Text>}
        </View>
        <View style={{ alignItems: "flex-end", minHeight: 30 }}>{data.stamp ? <Stamp stamp={data.stamp} d={d} s={s} /> : null}</View>
      </View>
      <View style={{ flexDirection: "row", justifyContent: "flex-end", marginBottom: 6 }}>
        <Buyer data={data} d={d} s={s} withLabel={!!data.partyLabels} />
      </View>
      <View style={{ marginBottom: 16 }}>
        <Party label={data.partyLabels ? L(d, data.partyLabels.seller) : null} name={data.seller.name} lines={data.seller.lines} s={s} />
      </View>
      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "flex-end", marginBottom: 10 }}>
        <View>
          <Text style={[s.bold, { fontSize: 11 }]}>{L(d, data.title)} {L(d, "N°")} {t(data.number)}</Text>
          <Subtitle data={data} align="left" />
          <Meta data={data} d={d} s={s} align="flex-start" />
        </View>
      </View>
    </>
  )
}

/** Bandeau : grand en-tête plein en couleur principale, titre / numéro / références en blanc, logo sur pastille blanche. */
function BandHeader({ data, d, s }: { data: DocumentPdfData; d: PdfDesign; s: Styles }) {
  const logo = data.logoDataUrl ?? null
  const soft = tint(d.primary, 0.15) // texte secondaire du bandeau : blanc légèrement teinté
  return (
    <>
      <View style={{ marginTop: -40, marginHorizontal: -44, paddingTop: 26, paddingBottom: 20, paddingHorizontal: 44, backgroundColor: d.primary, flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 18 }}>
        <View style={{ width: "46%" }}>
          {logo
            ? <View style={{ backgroundColor: WHITE, borderRadius: 6, padding: 6, alignSelf: "flex-start" }}><Image src={logo} style={[s.logo, { maxHeight: 44 }]} /></View>
            : <Text style={{ fontFamily: "Helvetica-Bold", fontSize: 14, color: WHITE }}>{t(data.seller.name)}</Text>}
        </View>
        <View style={{ alignItems: "flex-end" }}>
          <Text style={{ fontFamily: "Helvetica-Bold", fontSize: 20, color: WHITE, letterSpacing: 1 }}>{L(d, data.title)}</Text>
          <Subtitle data={data} color={WHITE} />
          <Text style={{ fontFamily: "Helvetica-Bold", fontSize: 11, color: WHITE, marginTop: 2 }}>{t(data.number)}</Text>
          <Meta data={data} d={d} s={s} color={soft} />
          {data.stamp ? <View style={{ marginTop: 8 }}><Stamp stamp={data.stamp} d={d} s={s} /></View> : null}
        </View>
      </View>
      <Parties data={data} d={d} s={s} />
    </>
  )
}

/** Épuré : noir et blanc, titre espacé, la couleur réservée aux filets et au total. */
function MinimalHeader({ data, d, s }: { data: DocumentPdfData; d: PdfDesign; s: Styles }) {
  const logo = data.logoDataUrl ?? null
  return (
    <>
      <View style={s.header}>
        <View style={{ width: "48%" }}>
          {logo ? <Image src={logo} style={s.logo} /> : <Text style={[s.sellerName, { color: INK }]}>{t(data.seller.name)}</Text>}
        </View>
        <View style={s.titleBlock}>
          <Text style={{ fontSize: 16, letterSpacing: 3, color: INK, textTransform: "uppercase" }}>{L(d, data.title)}</Text>
          <Subtitle data={data} color={MUTED} />
          <Text style={{ fontSize: 10, color: MUTED, marginTop: 3 }}>{t(data.number)}</Text>
          <Meta data={data} d={d} s={s} />
          {data.stamp ? <View style={{ marginTop: 8 }}><Stamp stamp={data.stamp} d={d} s={s} /></View> : null}
        </View>
      </View>
      <View style={{ borderBottomWidth: 1, borderBottomColor: d.primary, marginBottom: 14 }} />
      <Parties data={data} d={d} s={s} />
    </>
  )
}

/**
 * Rendu d'un document. Appelée comme une fonction par les routes et les tests (`renderToBuffer(DocumentPdf({ data }))`) :
 * elle retourne directement l'élément <Document>, sans hook.
 */
export function DocumentPdf({ data }: { data: DocumentPdfData }) {
  const d = data.design ?? DEFAULT_PDF_DESIGN
  const s = makeStyles(d)
  const Header = d.template === "MODERN" ? ModernHeader : d.template === "BAND" ? BandHeader : d.template === "MINIMAL" ? MinimalHeader : ClassicHeader
  return (
    <Document title={pdfSafe(`${translate(data.title, d.language)} ${data.number}`)} author={t(data.seller.name)} creator="Planificator">
      <Page size="A4" style={s.page}>
        <Header data={data} d={d} s={s} />
        <Subject data={data} d={d} s={s} />
        <Lines data={data} d={d} s={s} />
        <Totals data={data} d={d} s={s} />
        <Sections data={data} d={d} s={s} />
        <Footer data={data} s={s} />
      </Page>
    </Document>
  )
}
