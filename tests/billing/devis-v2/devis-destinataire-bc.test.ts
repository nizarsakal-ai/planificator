// V2 06/11/2026 — tests PURS (sans base) : destinataire des devis et bon de commande client.
// Écrits sur le VPS, NON EXÉCUTÉS sur le VPS : à exécuter uniquement dans l'environnement isolé autorisé (npm run test:devis-v2).
import assert from "node:assert/strict"
import { describe, it } from "node:test"
import type { Prisma } from "@prisma/client"
import { RECIPIENT_ERRORS, buildRecipientSuggestions, normalizeEmail, parseRecipientInput } from "@/lib/billing/quotes/quote-recipient"
import { PO_REF_ERRORS, normalizePurchaseOrderRef } from "@/lib/billing/quotes/purchase-order-ref"
import { QUOTE_ERRORS, convertQuoteCore } from "@/lib/billing/quotes/quote-lifecycle.core"
import { parseInvoiceForm } from "@/lib/billing/invoices/invoice-schemas"
import { UNSAFE_PDF_CHARS, pdfSafe } from "@/lib/billing/pdf/pdf-text"

const client = { name: "Chayou SAS", email: "compta@chayou.example" }

describe("destinataire : validation de la saisie confirmée", () => {
  it("e-mail obligatoire et valide ; nom facultatif, normalisé, borné", () => {
    assert.deepEqual(parseRecipientInput({ name: "  Carline   Bourguine ", email: " Carline.B@Chayou.EXAMPLE ", source: "CONSULTATION" }), { ok: true, value: { name: "Carline Bourguine", email: "Carline.B@chayou.example", source: "CONSULTATION" } })
    assert.deepEqual(parseRecipientInput({ name: "", email: "x@y.example", source: "MANUAL" }), { ok: true, value: { name: null, email: "x@y.example", source: "MANUAL" } })
    assert.deepEqual(parseRecipientInput({ name: "A", email: "  ", source: "MANUAL" }), { ok: false, error: RECIPIENT_ERRORS.emailRequired })
    for (const bad of ["carline", "carline@", "@chayou.example", "a b@c.example", "a@b", "a@@b.example", "a..b@c.example", "<a@b.example>", "a@b.example\nBcc: x@y.example", "a@-b.example"]) {
      assert.deepEqual(parseRecipientInput({ email: bad, source: "MANUAL" }), { ok: false, error: RECIPIENT_ERRORS.emailInvalid }, bad)
    }
    assert.deepEqual(parseRecipientInput({ name: "x".repeat(121), email: "a@b.example", source: "MANUAL" }), { ok: false, error: RECIPIENT_ERRORS.nameTooLong })
  })
  it("refuse une origine inconnue, un champ en trop (companyId) ou un type inattendu", () => {
    assert.equal(parseRecipientInput({ email: "a@b.example", source: "AUTO" }).ok, false)
    assert.equal(parseRecipientInput({ email: "a@b.example", source: "MANUAL", companyId: "coB" }).ok, false)
    assert.equal(parseRecipientInput(null).ok, false)
    assert.equal(parseRecipientInput({ email: 42, source: "MANUAL" }).ok, false)
  })
  it("normalizeEmail : domaine en minuscules, partie locale conservée, 254 caractères au plus", () => {
    assert.equal(normalizeEmail("Jean.Dupont@EXEMPLE.Fr"), "Jean.Dupont@exemple.fr")
    assert.equal(normalizeEmail(`${"a".repeat(65)}@b.example`), null)
    assert.equal(normalizeEmail(`a@${"b".repeat(250)}.example`), null)
  })
})

describe("destinataire : propositions", () => {
  it("demandeur identifié dans la consultation (exemple Nizar : Carline Bourguine pour Chayou) ⇒ proposé, pas la comptabilité", () => {
    const s = buildRecipientSuggestions({ lastSent: null, consultation: { contactName: "Carline Bourguine", contactEmail: "c.bourguine@chayou.example", senderEmail: "c.bourguine@chayou.example" }, client, previous: [] })
    assert.equal(s.identification, "CONSULTATION")
    assert.deepEqual(s.proposed, { name: "Carline Bourguine", email: "c.bourguine@chayou.example", source: "CONSULTATION" })
    assert.deepEqual(s.candidates.map((c) => c.source), ["CONSULTATION", "CLIENT"]) // la comptabilité reste un choix distinct
  })
  it("nom seul : aucune adresse inventée (e-mail vide à saisir), même si l'expéditeur technique a une adresse", () => {
    const s = buildRecipientSuggestions({ lastSent: null, consultation: { contactName: "Carline Bourguine", contactEmail: null, senderEmail: "noreply@plateforme.example" }, client, previous: [] })
    assert.equal(s.identification, "NAME_ONLY")
    assert.deepEqual(s.proposed, { name: "Carline Bourguine", email: null, source: "MANUAL" })
    assert.ok(!s.candidates.some((c) => c.email === "noreply@plateforme.example"), "l'expéditeur automatique n'est jamais proposé")
    assert.ok(s.notices.some((n) => /autre adresse/.test(n)))
  })
  it("expéditeur (transfert) distinct du demandeur : le demandeur est proposé, l'expéditeur signalé et exclu", () => {
    const s = buildRecipientSuggestions({ lastSent: null, consultation: { contactName: "Carline Bourguine", contactEmail: "c.bourguine@chayou.example", senderEmail: "assistant@chayou.example" }, client, previous: [] })
    assert.equal(s.proposed?.email, "c.bourguine@chayou.example")
    assert.ok(!s.candidates.some((c) => c.email === "assistant@chayou.example"))
    assert.ok(s.notices.some((n) => /transfert/.test(n)))
  })
  it("adresse extraite invalide : non proposée, signalée", () => {
    const s = buildRecipientSuggestions({ lastSent: null, consultation: { contactName: null, contactEmail: "carline at chayou", senderEmail: null }, client: { name: "Chayou", email: null }, previous: [] })
    assert.equal(s.identification, "ABSENT"); assert.equal(s.proposed, null)
    assert.ok(s.notices.some((n) => /forme valide/.test(n)))
  })
  it("ambiguïté (plusieurs contacts connus, aucune consultation) ⇒ aucune proposition imposée, choix explicite", () => {
    const s = buildRecipientSuggestions({ lastSent: null, consultation: null, client, previous: [{ name: "Paul", email: "paul@chayou.example" }, { name: "Paul bis", email: "PAUL@chayou.example" }, { name: "Léa", email: "lea@chayou.example" }] })
    assert.equal(s.identification, "AMBIGUOUS"); assert.equal(s.proposed, null)
    assert.deepEqual(s.candidates.map((c) => c.email), ["paul@chayou.example", "lea@chayou.example", "compta@chayou.example"]) // dédoublonné sans casse
  })
  it("un seul contact connu ⇒ proposé (à vérifier) ; aucun contact ⇒ saisie manuelle", () => {
    assert.equal(buildRecipientSuggestions({ lastSent: null, consultation: null, client, previous: [] }).identification, "SINGLE_KNOWN")
    const none = buildRecipientSuggestions({ lastSent: null, consultation: null, client: { name: "X", email: null }, previous: [] })
    assert.equal(none.identification, "ABSENT"); assert.equal(none.proposed, null); assert.equal(none.candidates.length, 0)
  })
  it("renvoi : le destinataire effectif précédent est proposé (modifiable), pas la consultation", () => {
    const s = buildRecipientSuggestions({ lastSent: { name: "Marc", email: "marc@chayou.example" }, consultation: { contactName: "Carline Bourguine", contactEmail: "c.bourguine@chayou.example", senderEmail: null }, client, previous: [] })
    assert.equal(s.identification, "LAST_SENT"); assert.deepEqual(s.proposed, { name: "Marc", email: "marc@chayou.example", source: "MANUAL" })
    assert.ok(s.candidates.some((c) => c.email === "c.bourguine@chayou.example"), "le contact de la demande reste sélectionnable")
  })
})

describe("bon de commande client : normalisation", () => {
  it("facultatif : vide/absent ⇒ null ; espaces réduits ; jamais inventé", () => {
    assert.deepEqual(normalizePurchaseOrderRef(undefined), { ok: true, value: null })
    assert.deepEqual(normalizePurchaseOrderRef("   "), { ok: true, value: null })
    assert.deepEqual(normalizePurchaseOrderRef("  BC  2026 / 118 "), { ok: true, value: "BC 2026 / 118" })
    assert.deepEqual(normalizePurchaseOrderRef("CMD-Été_04#7 (lot:B)+1"), { ok: true, value: "CMD-Été_04#7 (lot:B)+1" })
  })
  it("longueur et caractères bornés (aucun contrôle, chevron, guillemet, émoji)", () => {
    assert.deepEqual(normalizePurchaseOrderRef("A".repeat(65)), { ok: false, error: PO_REF_ERRORS.tooLong })
    assert.deepEqual(normalizePurchaseOrderRef("A".repeat(64)), { ok: true, value: "A".repeat(64) })
    for (const bad of ["<script>", "BC\"1", "BC\u0000", "-BC", "BC 🚧", "BC;DROP", 42]) assert.equal(normalizePurchaseOrderRef(bad).ok, false, String(bad))
    assert.deepEqual(normalizePurchaseOrderRef("-BC"), { ok: false, error: PO_REF_ERRORS.invalid })
  })
  it("R2 : accents français et lettres latines WinAnsi admis, rendus sans substitution (pdfSafe identique)", () => {
    for (const ref of ["BC 2026-118", "Commande Été-Œuvre n12", "ÀÂÄÇÈÉÊËÎÏÔÖÙÛÜŸàâäçèéêëîïôöùûüÿ", "Œœ Šš Žž", "Ñ-ß-ø-Å"]) {
      const r = normalizePurchaseOrderRef(ref); assert.ok(r.ok && r.value, ref)
      if (r.ok && r.value) { assert.equal(pdfSafe(r.value), r.value, ref); assert.equal(UNSAFE_PDF_CHARS.test(r.value), false, ref) }
    }
  })
  it("R2 : caractères hors encodage WinAnsi refusés explicitement (aucune translittération ni perte silencieuse)", () => {
    for (const bad of ["BC-漢字", "BC-Ж", "BC-١", "BC-٣٤", "BC-Ⅳ", "BC-１", "BC-α", "BC-Ł", "BC 🚧"]) {
      const r = normalizePurchaseOrderRef(bad)
      assert.equal(r.ok, false, bad)
      if (!r.ok) assert.match(r.error, /non pris en charge par le PDF/, bad)
    }
    assert.match((normalizePurchaseOrderRef("BC-Ж") as { error: string }).error, /« Ж »/)
  })
  it("R1 : schéma du brouillon — champ ABSENT ⇒ undefined (rien n'est écrit) ; chaîne VIDE ⇒ null (effacement explicite) ; invalide ⇒ refus", () => {
    const base = { worksiteId: "w", lines: [{ designation: "A", quantity: "1", unitPrice: "10", vatRate: "20" }] }
    const r = parseInvoiceForm({ ...base, clientPurchaseOrderRef: " BC-9 " }); assert.ok(r.ok); if (r.ok) assert.equal(r.value.clientPurchaseOrderRef, "BC-9")
    const absent = parseInvoiceForm(base); assert.ok(absent.ok); if (absent.ok) { assert.equal(absent.value.clientPurchaseOrderRef, undefined); assert.ok(!("clientPurchaseOrderRef" in absent.value) || absent.value.clientPurchaseOrderRef === undefined) }
    const empty = parseInvoiceForm({ ...base, clientPurchaseOrderRef: "   " }); assert.ok(empty.ok); if (empty.ok) assert.equal(empty.value.clientPurchaseOrderRef, null)
    const bad = parseInvoiceForm({ ...base, clientPurchaseOrderRef: "<x>" }); assert.equal(bad.ok, false)
    if (!bad.ok) assert.match(bad.error, /non pris en charge/)
  })
})

// ─── Conversion (transaction simulée, même motif que tests/billing/c1/quote-unit.test.ts) ───
type Row = Record<string, unknown>
const matches = (row: Row, where: Record<string, unknown>) => Object.entries(where).every(([k, v]) => {
  if (v && typeof v === "object" && !Array.isArray(v) && "not" in (v as Row)) return row[k] !== (v as Row).not
  return row[k] === v
})
function makeTx(quotes: Row[], invoices: Row[] = []) {
  const q = quotes.map((r) => ({ ...r })); const inv = invoices.map((r) => ({ ...r })); const history: Row[] = []
  let seq = 0; const hooks: { beforeQuoteUpdate?: () => void; failTransition?: boolean } = {}
  const tx = {
    quote: {
      findFirst: async ({ where }: { where: Record<string, unknown> }) => { const r = q.find((x) => matches(x, where)); return r ? { ...r, worksite: { startDate: null, endDate: null }, lines: [{ designation: "Pose", unit: "u", quantity: "1", unitPrice: "100.00", vatRate: "20.00", lineHT: "100.00", discountBp: 500, position: 0, articleId: null, description: null }] } : null },
      updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        hooks.beforeQuoteUpdate?.()
        if (hooks.failTransition && data.status === "CONVERTED") return { count: 0 }
        let n = 0; for (const r of q) if (matches(r, where)) { Object.assign(r, data); n++ } return { count: n }
      },
    },
    invoice: {
      findFirst: async ({ where }: { where: Record<string, unknown> }) => inv.find((x) => matches(x, where)) ?? null,
      create: async ({ data }: { data: Record<string, unknown> }) => { const id = `inv-${++seq}`; inv.push({ id, ...data }); return { id, number: data.number as string } },
    },
    historyLog: { create: async ({ data }: { data: Record<string, unknown> }) => { history.push(data); return data } },
  } as unknown as Prisma.TransactionClient
  return { tx, q, inv, history, hooks }
}
const A = "coA", B = "coB", now = new Date("2026-11-06T10:00:00Z")
const quote = (id: string, status: string, over: Row = {}): Row => ({ id, companyId: A, status, number: `DEV-${id}`, worksiteId: "w", clientId: "c", totalHT: "95.00", totalVAT: "19.00", totalTTC: "114.00", globalDiscountBp: 250, vatReverseCharge: false, notes: "Note", paymentTerms: "30 jours", subject: "Toiture Chayou", clientPurchaseOrderRef: null, ...over })
const input = { companyId: A, actorId: "u", now, paymentTermsDays: 30, nextDraftNumber: async () => "PROV-2026-0042", lockQuote: async () => {} }

describe("conversion devis → facture avec bon de commande client", () => {
  it("accepté + référence : facture brouillon reprenant client, chantier, objet, lignes, remises, TVA, conditions ; référence copiée et conservée sur le devis", async () => {
    const { tx, q, inv, history } = makeTx([quote("1", "ACCEPTED")])
    const r = await convertQuoteCore(tx, { ...input, quoteId: "1", clientPurchaseOrderRef: "BC-2026-118" })
    assert.deepEqual(r, { ok: true, value: { invoiceId: "inv-1", invoiceNumber: "PROV-2026-0042", existing: false } })
    const f = inv[0]
    assert.equal(f.status, "DRAFT"); assert.equal(f.kind, "INVOICE"); assert.equal(f.clientId, "c"); assert.equal(f.worksiteId, "w"); assert.equal(f.quoteId, "1")
    assert.equal(f.subject, "Toiture Chayou"); assert.equal(f.notes, "Note"); assert.equal(f.paymentTerms, "30 jours")
    assert.equal(f.totalHT, "95.00"); assert.equal(f.totalVAT, "19.00"); assert.equal(f.totalTTC, "114.00"); assert.equal(f.globalDiscountBp, 250); assert.equal(f.vatReverseCharge, false)
    assert.equal(((f.lines as { create: Row[] }).create[0]).discountBp, 500)
    assert.equal(f.clientPurchaseOrderRef, "BC-2026-118"); assert.notEqual(f.number, "BC-2026-118")
    assert.equal(q[0].clientPurchaseOrderRef, "BC-2026-118"); assert.equal(q[0].status, "CONVERTED")
    assert.ok(history.some((h) => /bon de commande client BC-2026-118/.test(String(h.detail))))
  })
  it("sans référence : facture sans référence (jamais inventée), devis inchangé sur ce champ", async () => {
    const { tx, q, inv } = makeTx([quote("1", "ACCEPTED")])
    assert.ok((await convertQuoteCore(tx, { ...input, quoteId: "1" })).ok)
    assert.equal(inv[0].clientPurchaseOrderRef, null); assert.equal(q[0].clientPurchaseOrderRef, null)
  })
  it("double clic / réessai : facture existante renvoyée, sa référence n'est pas écrasée, aucune seconde facture", async () => {
    const { tx, q, inv } = makeTx([quote("1", "ACCEPTED")])
    const r1 = await convertQuoteCore(tx, { ...input, quoteId: "1", clientPurchaseOrderRef: "BC-1" }); assert.ok(r1.ok)
    const r2 = await convertQuoteCore(tx, { ...input, quoteId: "1", clientPurchaseOrderRef: "BC-AUTRE" })
    assert.deepEqual(r2, { ok: true, value: { invoiceId: "inv-1", invoiceNumber: "PROV-2026-0042", existing: true } })
    assert.equal(inv.length, 1); assert.equal(inv[0].clientPurchaseOrderRef, "BC-1"); assert.equal(q[0].clientPurchaseOrderRef, "BC-1")
  })
  it("refus : brouillon, envoyé non accepté, refusé, expiré (aucune acceptation automatique) ; autre société ⇒ introuvable", async () => {
    for (const st of ["DRAFT", "SENT", "REFUSED", "EXPIRED"]) {
      const { tx, q, inv } = makeTx([quote("1", st)])
      assert.deepEqual(await convertQuoteCore(tx, { ...input, quoteId: "1", clientPurchaseOrderRef: "BC-1" }), { ok: false, error: QUOTE_ERRORS.notAccepted }, st)
      assert.equal(q[0].status, st); assert.equal(q[0].clientPurchaseOrderRef, null); assert.equal(inv.length, 0)
    }
    const { tx } = makeTx([quote("1", "ACCEPTED")])
    assert.deepEqual(await convertQuoteCore(tx, { ...input, companyId: B, quoteId: "1" }), { ok: false, error: QUOTE_ERRORS.notFound })
  })
  it("course sur la référence : statut changé avant l'écriture ⇒ conflit, aucune facture", async () => {
    const { tx, q, inv, hooks } = makeTx([quote("1", "ACCEPTED")])
    hooks.beforeQuoteUpdate = () => { q[0].status = "REFUSED"; hooks.beforeQuoteUpdate = undefined }
    assert.deepEqual(await convertQuoteCore(tx, { ...input, quoteId: "1", clientPurchaseOrderRef: "BC-1" }), { ok: false, error: QUOTE_ERRORS.conflict })
    assert.equal(inv.length, 0)
  })
  it("échec de la transition après création ⇒ exception (ROLLBACK de la transaction entière, jamais de facture orpheline)", async () => {
    const { tx, hooks } = makeTx([quote("1", "ACCEPTED")])
    hooks.failTransition = true
    await assert.rejects(() => convertQuoteCore(tx, { ...input, quoteId: "1", clientPurchaseOrderRef: "BC-1" }), /QUOTE_CONVERT_CONFLICT/)
  })
  it("solde recréé (brouillon précédent abandonné) : référence conservée sur le devis reprise si aucune nouvelle saisie", async () => {
    const { tx, inv } = makeTx([quote("1", "CONVERTED", { clientPurchaseOrderRef: "BC-INITIAL" })], [{ id: "old", companyId: A, quoteId: "1", kind: "INVOICE", status: "CANCELLED", number: "PROV-1" }])
    assert.ok((await convertQuoteCore(tx, { ...input, quoteId: "1" })).ok)
    assert.equal(inv[1].clientPurchaseOrderRef, "BC-INITIAL")
  })
})
