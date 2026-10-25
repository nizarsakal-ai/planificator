// Lot C1 — tests unitaires purs : schémas, import CSV, jeton de signature, automate (transaction simulée), accès/drapeau, navigation, courriers.
import assert from "node:assert/strict"
import { describe, it } from "node:test"
import type { Prisma } from "@prisma/client"
import { parseQuoteForm, previewQuoteTotals } from "@/lib/billing/quotes/quote-schemas"
import { detectDelimiter, parseCsv, parseQuoteImport } from "@/lib/billing/quotes/quote-import"
import { generateSignatureToken, hashIp, hashSignatureToken, isValidSignatureToken, signatureExpiry } from "@/lib/billing/quotes/quote-signature"
import { QUOTE_ERRORS, QUOTE_TRANSITIONS, canQuoteTransition, convertQuoteCore, replaceQuoteDraftCore, transitionQuoteCore } from "@/lib/billing/quotes/quote-lifecycle.core"
import { resolveBillingAccessCore } from "@/lib/billing/access"
import { isBillingCompleteEnabled, isBillingMailEnabled, isBillingRemindersEnabled } from "@/lib/billing/billing-feature-flag"
import { QUOTES_NAV_ITEM, getNavItems, withAccountingNavItem, withBillingNavItems } from "@/lib/navigation/nav-config"
import { escapeHtml, quoteSentMail } from "@/lib/billing/mail/templates"
import { RecordingMailer, getBillingMailer, setBillingMailerForTests } from "@/lib/billing/mail/mailer"
import { nextDocumentNumber } from "@/lib/billing/numbering"

const base = { worksiteId: "w1", issueDate: "2026-03-01", validUntil: "2026-03-31", subject: "Toiture", lines: [{ designation: "Tuiles", quantity: "10", unitPrice: "12,50", vatRate: "20" }, { designation: "Pose", unit: "h", quantity: "2,5", unitPrice: "40", discount: "10", vatRate: "10" }] }

describe("parseQuoteForm", () => {
  it("convertit une saisie valide en centimes et calcule les totaux", () => {
    const r = parseQuoteForm(base)
    assert.ok(r.ok); if (!r.ok) return
    assert.equal(r.value.lines[0].unitPriceCents, BigInt(1250))
    assert.equal(r.value.lines[1].quantityHundredths, BigInt(250))
    assert.equal(r.value.lines[1].discountBp, 1000)
    assert.equal(r.value.totals.totalHTCents, BigInt(12500 + 9000)) // 125 + (100 − 10 %)
    assert.equal(r.value.totals.totalVATCents, BigInt(2500 + 900))
    assert.equal(r.value.validUntil?.toISOString(), "2026-03-31T00:00:00.000Z")
  })
  it("refuse : champ inconnu (companyId), ligne vide, montant invalide, validité avant émission, taux interdit", () => {
    assert.equal(parseQuoteForm({ ...base, companyId: "x" }).ok, false)
    assert.equal(parseQuoteForm({ ...base, lines: [] }).ok, false)
    const bad = parseQuoteForm({ ...base, lines: [{ designation: "A", quantity: "1", unitPrice: "1,234", vatRate: "20" }] })
    assert.deepEqual(bad, { ok: false, error: "Ligne 1 : montant invalide (2 décimales max, sans signe)" })
    assert.equal(parseQuoteForm({ ...base, validUntil: "2026-02-01" }).ok, false)
    assert.equal(parseQuoteForm({ ...base, lines: [{ designation: "A", quantity: "1", unitPrice: "1", vatRate: "19.6" }] }).ok, false)
    assert.equal(parseQuoteForm({ ...base, issueDate: "2026-02-31" }).ok, false)
  })
  it("previewQuoteTotals tolère une saisie incomplète (null) sans lever", () => {
    assert.equal(previewQuoteTotals([{ designation: "", quantity: "x", unitPrice: "", vatRate: "20" }], "", false), null)
    assert.equal(previewQuoteTotals(base.lines, "", false)?.totalTTCCents, BigInt(24900))
  })
})

describe("import CSV", () => {
  it("analyse RFC 4180 (guillemets, séparateur détecté)", () => {
    assert.deepEqual(parseCsv('a;"b;c";"d ""e"""\n1;2;3', ";"), [["a", "b;c", 'd "e"'], ["1", "2", "3"]])
    assert.equal(detectDelimiter("a,b;c;d"), ";"); assert.equal(detectDelimiter("a,b,c"), ",")
  })
  it("regroupe par référence, rejette le devis entier si une ligne est invalide, signale les colonnes manquantes", () => {
    const text = "reference;chantier;designation;quantite;prix_unitaire_ht;tva;remise;validite\nD1;Maison A;Tuiles;10;12,50;20;;2026-12-31\nD1;Maison A;Pose;2;40;10;5;\nD2;Maison B;Erreur;abc;1;20;;\n;Maison C;Sans ref;1;1;20;;"
    const r = parseQuoteImport(text, "2026-03-01")
    assert.equal(r.fatal, undefined)
    assert.equal(r.candidates.length, 1)
    assert.equal(r.candidates[0].reference, "D1"); assert.deepEqual(r.candidates[0].rowNumbers, [1, 2]); assert.equal(r.candidates[0].form.validUntil, "2026-12-31")
    assert.equal(r.invalid.length, 2)
    assert.ok(r.invalid.some((i) => i.reference === "D2" && /quantité/.test(i.errors[0])))
    assert.ok(r.invalid.some((i) => i.reference === "(sans référence)"))
    assert.match(parseQuoteImport("reference;designation\nx;y", "2026-03-01").fatal ?? "", /Colonnes manquantes/)
    assert.match(parseQuoteImport("reference;chantier;designation;quantite;prix_unitaire_ht;tva\n", "2026-03-01").fatal ?? "", /vide/)
  })
  it("limite de lignes", () => {
    const rows = Array.from({ length: 501 }, (_, i) => `R${i};C;D;1;1;20`).join("\n")
    assert.match(parseQuoteImport(`reference;chantier;designation;quantite;prix_unitaire_ht;tva\n${rows}`, "2026-03-01").fatal ?? "", /Trop de lignes/)
  })
})

describe("jeton de signature", () => {
  it("256 bits base64url (43 caractères), haché sha256, jamais égal au jeton", () => {
    const { token, hash } = generateSignatureToken()
    assert.match(token, /^[A-Za-z0-9_-]{43}$/)
    assert.match(hash, /^[0-9a-f]{64}$/)
    assert.equal(hashSignatureToken(token), hash)
    assert.notEqual(generateSignatureToken().token, token)
    assert.ok(isValidSignatureToken(token)); assert.ok(!isValidSignatureToken(token + "x")); assert.ok(!isValidSignatureToken(42))
  })
  it("expiration : fin de validité du devis si future, sinon +30 jours ; IP hachée", () => {
    const now = new Date("2026-03-01T10:00:00Z")
    assert.equal(signatureExpiry(new Date("2026-03-15T00:00:00Z"), now).toISOString(), "2026-03-15T23:59:59.999Z")
    assert.equal(signatureExpiry(new Date("2026-02-01T00:00:00Z"), now).toISOString(), "2026-03-31T10:00:00.000Z")
    assert.equal(signatureExpiry(null, now).toISOString(), "2026-03-31T10:00:00.000Z")
    assert.match(hashIp("203.0.113.9", "secret") ?? "", /^[0-9a-f]{64}$/); assert.equal(hashIp(null, "secret"), null)
    assert.equal(hashIp("203.0.113.9", undefined), null, "sans secret serveur : aucune empreinte")
    assert.notEqual(hashIp("203.0.113.9", "a"), hashIp("203.0.113.9", "b"))
  })
})

// ─── Automate (transaction simulée en mémoire appliquant les `where` comme PostgreSQL) ───
type Row = Record<string, unknown> & { id: string }
function matches(row: Row, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([k, v]) => {
    if (v && typeof v === "object" && "not" in (v as object)) return row[k] !== (v as { not: unknown }).not
    return row[k] === v
  })
}
function makeTx(quotes: Row[], invoices: Row[] = []) {
  const q = quotes.map((r) => ({ ...r })); const inv = invoices.map((r) => ({ ...r })); const lines: Row[] = []; const history: Row[] = []
  let seq = 0; const hooks: { beforeUpdate?: () => void } = {}
  const tx = {
    quote: {
      findFirst: async ({ where }: { where: Record<string, unknown> }) => { const r = q.find((x) => matches(x, where)); return r ? { ...r, worksite: { startDate: null, endDate: null }, lines: [] } : null },
      updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => { hooks.beforeUpdate?.(); let n = 0; for (const r of q) if (matches(r, where)) { Object.assign(r, data); n++ } return { count: n } },
    },
    quoteLine: { deleteMany: async () => ({ count: 0 }), createMany: async ({ data }: { data: Row[] }) => { lines.push(...data); return { count: data.length } } },
    invoice: {
      findFirst: async ({ where }: { where: Record<string, unknown> }) => inv.find((x) => matches(x, where)) ?? null,
      create: async ({ data }: { data: Record<string, unknown> }) => { const id = `inv-${++seq}`; inv.push({ id, ...data }); return { id, number: data.number as string } },
    },
    historyLog: { create: async ({ data }: { data: Record<string, unknown> }) => { history.push({ id: `h${++seq}`, ...data }); return data } },
  } as unknown as Prisma.TransactionClient
  return { tx, q, inv, history, hooks }
}
const A = "coA", B = "coB", now = new Date("2026-03-10T00:00:00Z")
const quote = (id: string, status: string, companyId = A): Row => ({ id, companyId, status, number: `DEV-${id}`, worksiteId: "w", clientId: "c", totalHT: "100.00", totalVAT: "20.00", totalTTC: "120.00", globalDiscountBp: 0, vatReverseCharge: false, notes: null, paymentTerms: null })

describe("automate des devis", () => {
  it("table des transitions sans retour arrière", () => {
    assert.deepEqual(QUOTE_TRANSITIONS.DRAFT, ["SENT", "EXPIRED"]); assert.deepEqual(QUOTE_TRANSITIONS.ACCEPTED, ["CONVERTED"]); assert.deepEqual(QUOTE_TRANSITIONS.CONVERTED, [])
    assert.ok(!canQuoteTransition("ACCEPTED", "DRAFT")); assert.ok(!canQuoteTransition("REFUSED", "SENT")); assert.ok(canQuoteTransition("SENT", "REFUSED"))
  })
  it("DRAFT → SENT pose sentAt et trace ; SENT → DRAFT refusé ; autre société ⇒ introuvable", async () => {
    const { tx, q, history } = makeTx([quote("1", "DRAFT")])
    const r = await transitionQuoteCore(tx, { companyId: A, quoteId: "1", to: "SENT", actorId: "u", now })
    assert.deepEqual(r, { ok: true, value: { from: "DRAFT" } }); assert.equal(q[0].status, "SENT"); assert.equal(q[0].sentAt, now); assert.equal(history.length, 1)
    assert.deepEqual(await transitionQuoteCore(tx, { companyId: B, quoteId: "1", to: "ACCEPTED", actorId: "u", now }), { ok: false, error: QUOTE_ERRORS.notFound })
    assert.deepEqual(await transitionQuoteCore(tx, { companyId: A, quoteId: "1", to: "CONVERTED", actorId: "u", now }), { ok: false, error: QUOTE_ERRORS.forbidden })
  })
  it("course : statut changé entre lecture et écriture ⇒ conflit, rien n'est écrasé", async () => {
    const { tx, q, hooks } = makeTx([quote("1", "SENT")])
    hooks.beforeUpdate = () => { q[0].status = "REFUSED"; hooks.beforeUpdate = undefined }
    assert.deepEqual(await transitionQuoteCore(tx, { companyId: A, quoteId: "1", to: "ACCEPTED", actorId: "u", now }), { ok: false, error: QUOTE_ERRORS.conflict })
    assert.equal(q[0].status, "REFUSED"); assert.equal(q[0].acceptedAt, undefined)
  })
  it("remplacement des lignes : brouillon uniquement", async () => {
    const { tx } = makeTx([quote("1", "SENT"), quote("2", "DRAFT")])
    const header = { issueDate: now, validUntil: null, subject: null, notes: null, paymentTerms: null, globalDiscountBp: 0, vatReverseCharge: false, totalHT: "1.00", totalVAT: "0.20", totalTTC: "1.20" }
    assert.deepEqual(await replaceQuoteDraftCore(tx, { companyId: A, quoteId: "1", actorId: "u", header, lines: [] }), { ok: false, error: QUOTE_ERRORS.notDraft })
    assert.deepEqual(await replaceQuoteDraftCore(tx, { companyId: A, quoteId: "9", actorId: "u", header, lines: [] }), { ok: false, error: QUOTE_ERRORS.notFound })
    assert.equal((await replaceQuoteDraftCore(tx, { companyId: A, quoteId: "2", actorId: "u", header, lines: [] })).ok, true)
  })
  it("conversion : ACCEPTED requis, facture brouillon créée, devis CONVERTED ; seconde conversion ⇒ facture existante (idempotent)", async () => {
    const { tx, q, inv, history } = makeTx([quote("1", "ACCEPTED"), quote("2", "SENT")])
    let locks = 0
    const input = { companyId: A, actorId: "u", now, paymentTermsDays: 30, nextDraftNumber: async () => "PROV-2026-0001", lockQuote: async () => { locks++ } }
    assert.deepEqual(await convertQuoteCore(tx, { ...input, quoteId: "2" }), { ok: false, error: QUOTE_ERRORS.notAccepted })
    const r1 = await convertQuoteCore(tx, { ...input, quoteId: "1" })
    assert.ok(r1.ok); if (!r1.ok) return
    assert.equal(r1.value.existing, false); assert.equal(q[0].status, "CONVERTED"); assert.equal(inv.length, 1); assert.equal(inv[0].status, "DRAFT"); assert.equal(inv[0].quoteId, "1"); assert.equal(inv[0].kind, "INVOICE")
    assert.equal((inv[0].dueDate as Date).toISOString(), "2026-04-09T00:00:00.000Z")
    const r2 = await convertQuoteCore(tx, { ...input, quoteId: "1" })
    assert.deepEqual(r2, { ok: true, value: { invoiceId: r1.value.invoiceId, invoiceNumber: "PROV-2026-0001", existing: true } })
    assert.equal(inv.length, 1); assert.equal(locks, 3); assert.ok(history.some((h) => h.entityType === "Invoice" && h.action === "CREATED"))
    assert.deepEqual(await convertQuoteCore(tx, { ...input, companyId: B, quoteId: "1" }), { ok: false, error: QUOTE_ERRORS.notFound })
  })
})

describe("drapeaux, accès, navigation, courriers", () => {
  it("drapeaux fail-closed : seule la valeur exacte « true » active", () => {
    for (const v of [undefined, "", "TRUE", "1", " true ", "yes"]) { assert.equal(isBillingCompleteEnabled({ BILLING_COMPLETE_ENABLED: v }), false, String(v)); assert.equal(isBillingMailEnabled({ BILLING_MAIL_ENABLED: v }), false); assert.equal(isBillingRemindersEnabled({ BILLING_REMINDERS_ENABLED: v }), false) }
    assert.equal(isBillingCompleteEnabled({ BILLING_COMPLETE_ENABLED: "true" }), true)
  })
  it("accès : drapeau OFF ⇒ MODULE_DISABLED avant toute session ; rôle et société de session requis", () => {
    assert.deepEqual(resolveBillingAccessCore(false, { user: { id: "u", role: "ADMIN", companyId: "c" } }), { ok: false, reason: "MODULE_DISABLED" })
    assert.deepEqual(resolveBillingAccessCore(true, null), { ok: false, reason: "UNAUTHENTICATED" })
    assert.deepEqual(resolveBillingAccessCore(true, { user: { id: "u", role: "TEAM_LEADER", companyId: "c" } }), { ok: false, reason: "FORBIDDEN" })
    assert.deepEqual(resolveBillingAccessCore(true, { user: { id: "u", role: "ADMIN", companyId: " " } }), { ok: false, reason: "NO_COMPANY" })
    assert.deepEqual(resolveBillingAccessCore(true, { user: { id: "u", role: "SUPER_ADMIN", companyId: "c" } }), { ok: true, context: { userId: "u", companyId: "c", role: "SUPER_ADMIN" } })
  })
  it("navigation : menus existants inchangés ; « Devis » inséré avant « Factures » seulement si visible", () => {
    for (const role of ["ADMIN", "SUPER_ADMIN", "TEAM_LEADER", "EMPLOYEE", "CLIENT"] as const) {
      assert.ok(!getNavItems(role).some((i) => i.href === "/devis"))
      assert.deepEqual(withBillingNavItems(getNavItems(role), false).map((i) => i.href), getNavItems(role).map((i) => i.href))
    }
    const items = withBillingNavItems(withAccountingNavItem(getNavItems("ADMIN"), true), true)
    const i = items.findIndex((x) => x.href === "/devis")
    assert.equal(items[i + 1]?.href, "/factures"); assert.equal(items[i + 2]?.href, "/comptabilite"); assert.equal(items.filter((x) => x.href === "/devis").length, 1)
    assert.equal(QUOTES_NAV_ITEM.label, "Devis")
    assert.equal(withBillingNavItems(getNavItems("EMPLOYEE"), true).some((x) => x.href === "/devis"), false)
  })
  it("courriers : HTML échappé, mailer enregistreur par défaut (jamais Resend sans drapeau)", () => {
    assert.equal(escapeHtml("<b>&\"'"), "&lt;b&gt;&amp;&quot;&#39;")
    const m = quoteSentMail({ companyName: "<X>", clientName: "A & B", quoteNumber: "DEV-1", totalTTC: "1,00 €", validUntil: "01/01/2027", signatureUrl: "http://x/devis-signature/t\"" })
    assert.ok(m.html.includes("&lt;X&gt;") && m.html.includes("A &amp; B") && !m.html.includes("t\"")); assert.ok(m.text.includes("DEV-1"))
    setBillingMailerForTests(null)
    assert.equal(getBillingMailer().name, "recording")
    const rec = new RecordingMailer(); setBillingMailerForTests(rec); assert.equal(getBillingMailer(), rec); setBillingMailerForTests(null)
  })
  it("Lot B : l'émission d'une facture à numéro provisoire est refusée (numéro légal à l'émission, C2)", async () => {
    const { transitionInvoiceCore, LIFECYCLE_ERRORS } = await import("@/lib/billing/invoice-lifecycle.core")
    const inv: Row = { id: "i1", companyId: A, status: "DRAFT", kind: "INVOICE", number: "PROV-2026-0001", worksiteId: "w" }
    const tx = { invoice: { findFirst: async () => inv, updateMany: async () => { throw new Error("ne doit pas écrire") } }, historyLog: { create: async () => ({}) } } as unknown as Prisma.TransactionClient
    assert.deepEqual(await transitionInvoiceCore(tx, { companyId: A, invoiceId: "i1", to: "SENT", actorId: "u", now }), { ok: false, error: LIFECYCLE_ERRORS.provisionalNumber })
  })
  it("numérotation : préfixe provisoire PROV pour les brouillons de facture", async () => {
    const tx = { documentCounter: { upsert: async ({ create }: { create: { type: string } }) => ({ lastValue: 7, type: create.type }) } } as unknown as Prisma.TransactionClient
    assert.equal(await nextDocumentNumber(tx, "co", "INVOICE_DRAFT", 2026), "PROV-2026-0007")
    assert.equal(await nextDocumentNumber(tx, "co", "CREDIT_NOTE", 2026), "AV-2026-0007")
  })
})
