// P2-01 — Identité d'une opération bancaire importée : identifiant bancaire stable si fourni, sinon tuple + rang d'occurrence
// dans le fichier ; lignes ambiguës conservées en attente de résolution explicite (jamais de paiement automatique).
import assert from "node:assert/strict"
import { after, before, describe, it } from "node:test"
import { PrismaClient } from "@prisma/client"
import { RecordingMailer, setBillingMailerForTests } from "@/lib/billing/mail/mailer"
import { autoReconcile, importBankStatement, matchTransaction } from "@/lib/accounting/c5/bank.service"
import { A, B, js, seedCompanies } from "./helpers"
import { issuedInvoice } from "./fixtures"

const db = new PrismaClient()
const M = { date: 0, label: 1, amount: 2, reference: 3, headerRows: 1 }
const H = "Date;Libellé;Montant;Référence\n"
const rows = (ctx: typeof A) => db.bankTransaction.findMany({ where: { companyId: ctx.companyId }, orderBy: [{ date: "asc" }, { occurrence: "asc" }], select: { amountCents: true, label: true, reference: true, occurrence: true, identityAmbiguous: true, externalId: true, status: true } })
const counted = (r: { imported: number; duplicates: number; ambiguous: number }) => [r.imported, r.duplicates, r.ambiguous]

before(async () => { process.env.BILLING_COMPLETE_ENABLED = "true"; setBillingMailerForTests(new RecordingMailer()); await seedCompanies(db) })
after(async () => { setBillingMailerForTests(null); delete process.env.BILLING_COMPLETE_ENABLED; await db.$disconnect() })

describe("P2-01 — occurrences, réimport, chevauchement", () => {
  it("deux opérations réellement distinctes mais identiques dans un fichier ⇒ deux occurrences conservées (ambiguës) ; réimport du même fichier ⇒ zéro ajout", async () => {
    const csv = `${H}12/03/2026;VIR LOYER;500,00;L1\n12/03/2026;VIR LOYER;500,00;L1\n13/03/2026;VIR AUTRE;10,00;X\n`
    const r1 = await importBankStatement(db, A, csv, "f1.csv", M); assert.ok(r1.ok, js(r1)); if (!r1.ok) return
    assert.deepEqual(counted(r1.value), [3, 0, 2])
    assert.deepEqual((await rows(A)).map((r) => [Number(r.amountCents), r.occurrence, r.identityAmbiguous]), [[50000, 1, true], [50000, 2, true], [1000, 1, false]])
    assert.deepEqual(await importBankStatement(db, A, csv, "f1.csv", M), { ok: false, error: "Ce relevé a déjà été importé." })
    const r2 = await importBankStatement(db, A, csv + "\n", "f1bis.csv", M); assert.ok(r2.ok); if (!r2.ok) return
    assert.deepEqual(counted(r2.value), [0, 3, 0]); assert.equal((await rows(A)).length, 3)
  })
  it("fichiers partiellement superposés : multiplicité = maximum observé, jamais de perte ni de doublon ; même référence/dates ou montants différents ⇒ distinctes ; sans référence", async () => {
    const overlap = `${H}12/03/2026;VIR LOYER;500,00;L1\n14/03/2026;VIR NOUVEAU;20,00;N\n`
    const r = await importBankStatement(db, A, overlap, "f2.csv", M); assert.ok(r.ok); if (!r.ok) return
    assert.deepEqual(counted(r.value), [1, 1, 0]); assert.equal((await rows(A)).length, 4)
    const triple = `${H}12/03/2026;VIR LOYER;500,00;L1\n12/03/2026;VIR LOYER;500,00;L1\n12/03/2026;VIR LOYER;500,00;L1\n`
    const r3 = await importBankStatement(db, A, triple, "f3.csv", M); assert.ok(r3.ok); if (!r3.ok) return
    assert.deepEqual(counted(r3.value), [1, 2, 1], "seule la 3e occurrence est nouvelle")
    assert.equal((await rows(A)).filter((x) => x.label === "VIR LOYER").length, 3)
    // Propagation : « VIR NOUVEAU » (importé une fois, non ambigu) réapparaît deux fois dans un relevé ultérieur ⇒ l'occurrence 1
    // déjà présente devient ambiguë elle aussi (identité incertaine), l'occurrence 2 est ajoutée ambiguë.
    assert.equal((await rows(A)).find((x) => x.label === "VIR NOUVEAU")?.identityAmbiguous, false)
    const r3b = await importBankStatement(db, A, `${H}14/03/2026;VIR NOUVEAU;20,00;N\n14/03/2026;VIR NOUVEAU;20,00;N\n`, "f3b.csv", M); assert.ok(r3b.ok); if (!r3b.ok) return
    assert.deepEqual(counted(r3b.value), [1, 1, 1])
    assert.deepEqual((await rows(A)).filter((x) => x.label === "VIR NOUVEAU").map((x) => [x.occurrence, x.identityAmbiguous]), [[1, true], [2, true]])
    const variants = `${H}12/03/2026;VIR LOYER;500,01;L1\n15/03/2026;VIR LOYER;500,00;L1\n12/03/2026;VIR SANS REF;500,00;\n12/03/2026;VIR SANS REF;500,00;\n`
    const r4 = await importBankStatement(db, A, variants, "f4.csv", M); assert.ok(r4.ok); if (!r4.ok) return
    assert.deepEqual(counted(r4.value), [4, 0, 2])
    assert.equal((await rows(A)).filter((x) => x.reference === null).length, 2)
  })
  it("identifiant bancaire stable : identité certaine (jamais ambiguë), doublon par identifiant, identifiant répété dans un fichier ⇒ ligne invalide ; unique par société", async () => {
    const MX = { ...M, bankId: 4 }
    const csv = `Date;Libellé;Montant;Référence;IdBanque\n12/03/2026;VIR LOYER;500,00;L1;OP-1\n12/03/2026;VIR LOYER;500,00;L1;OP-2\n12/03/2026;VIR LOYER;500,00;L1;OP-2\n`
    const r = await importBankStatement(db, A, csv, "f5.csv", MX); assert.ok(r.ok); if (!r.ok) return
    assert.deepEqual(counted(r.value), [2, 0, 0]); assert.deepEqual(r.value.invalid.map((i) => i.error), ["identifiant bancaire en double dans le fichier (OP-2)"])
    const again = await importBankStatement(db, A, csv.replace("OP-2\n12/03/2026;VIR LOYER;500,00;L1;OP-2", "OP-2\n13/03/2026;VIR X;1,00;;OP-3"), "f6.csv", MX); assert.ok(again.ok); if (!again.ok) return
    assert.deepEqual(counted(again.value), [1, 2, 0])
    assert.deepEqual((await rows(A)).filter((x) => x.externalId).map((x) => [x.externalId, x.identityAmbiguous]), [["OP-1", false], ["OP-2", false], ["OP-3", false]])
    const rB = await importBankStatement(db, B, csv, "f5.csv", MX); assert.ok(rB.ok); if (!rB.ok) return
    assert.deepEqual(counted(rB.value), [2, 0, 0], "sociétés distinctes : mêmes identifiants importés chacune")
  })
  it("imports concurrents de fichiers qui se chevauchent ⇒ aucune opération en double ; rapprochement automatique : lignes ambiguës jamais rapprochées, résolution manuelle explicite", async () => {
    const f7 = `${H}20/03/2026;VIR CONC;7,00;C\n21/03/2026;VIR A;8,00;A\n`, f8 = `${H}20/03/2026;VIR CONC;7,00;C\n22/03/2026;VIR B;9,00;B\n`
    const [a, b] = await Promise.all([importBankStatement(db, A, f7, "f7.csv", M), importBankStatement(db, A, f8, "f8.csv", M)])
    assert.ok(a.ok && b.ok, js([a, b]))
    assert.equal((await rows(A)).filter((x) => x.label === "VIR CONC").length, 1)
    // Deux imports simultanés du MÊME fichier : un seul relevé, le second obtient le message « déjà importé » (pas une erreur brute).
    const same = `${H}23/03/2026;VIR MEME;3,00;S\n`
    const twin = await Promise.all([importBankStatement(db, A, same, "same.csv", M), importBankStatement(db, A, same, "same.csv", M)])
    assert.deepEqual(twin.map((t) => t.ok).sort(), [false, true], js(twin)); assert.ok(twin.some((t) => !t.ok && t.error === "Ce relevé a déjà été importé."), js(twin))
    assert.equal(await db.bankStatementImport.count({ where: { companyId: "coA", fileName: "same.csv" } }), 1)
    assert.equal((a.ok ? a.value.imported : 0) + (b.ok ? b.value.imported : 0), 3)
    // Facture 100 € TTC ; deux lignes identiques de 100 € citant son numéro ⇒ ambiguës : l'automate n'en rapproche aucune.
    const inv = await issuedInvoice(db, A, "wA", [{ designation: "P", quantity: "1", unitPrice: "83.33", vatRate: "20" }])
    const num = (await db.invoice.findUniqueOrThrow({ where: { id: inv } })).number
    const r = await importBankStatement(db, A, `${H}10/03/2026;VIR ${num};100,00;\n10/03/2026;VIR ${num};100,00;\n`, "f9.csv", M); assert.ok(r.ok); if (!r.ok) return
    assert.deepEqual(counted(r.value), [2, 0, 2])
    const auto = await autoReconcile(db, A)
    assert.equal(auto.matched, 0); assert.ok(auto.ambiguous >= 2, js(auto))
    assert.equal(await db.invoicePayment.count({ where: { invoiceId: inv } }), 0)
    const amb = await db.bankTransaction.findMany({ where: { companyId: "coA", identityAmbiguous: true, amountCents: BigInt(10000), status: "PENDING" } })
    const manual = await matchTransaction(db, A, amb[0].id, { invoiceId: inv }); assert.ok(manual.ok, js(manual))
    assert.equal(await db.invoicePayment.count({ where: { invoiceId: inv } }), 1)
    const second = await matchTransaction(db, A, amb[1].id, { invoiceId: inv }); assert.equal(second.ok, false, "facture soldée : la seconde ligne reste à résoudre (autre facture ou ignorer)")
  })
})
