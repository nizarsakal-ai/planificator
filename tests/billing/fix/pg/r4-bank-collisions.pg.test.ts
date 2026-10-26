// R4 (revue Codex R2, 26/10/2026) — identité bancaire sans identifiant : un tuple déjà connu d'un relevé ANTÉRIEUR n'est plus
// éliminé comme doublon certain. Reproduction Codex : relevé 1 « VIR IDENTIQUE 5,00 » ; relevé 2 différent avec le même virement +
// une autre ligne ⇒ la ligne est CONSERVÉE (collision, ambiguë, provenance), le rapport dit collisions=1, duplicates=0 ; résolution
// explicite DOUBLON (ignorée) ou DISTINCTE (rapprochable) sans effacer ni recommencer l'import ; aucun paiement avant résolution ;
// identifiant bancaire ⇒ doublon certain ; occurrences multiples et imports concurrents ; action réelle de résolution.
import assert from "node:assert/strict"
import { after, before, describe, it, mock } from "node:test"
import { PrismaClient } from "@prisma/client"
import { RecordingMailer, setBillingMailerForTests } from "@/lib/billing/mail/mailer"
import { BANK_ERRORS, autoReconcile, importBankStatement, matchTransaction, resolveBankCollision, resolveImportCollisions } from "@/lib/accounting/c5/bank.service"
import { A, B, js, seedCompanies, useTestClock } from "./helpers"
import { issuedInvoice } from "./fixtures"

const db = new PrismaClient()
process.env.BILLING_COMPLETE_ENABLED = "true"; process.env.ACCOUNTING_MODULE_ENABLED = "true"
mock.module("@/lib/prisma", { namedExports: { prisma: db } })
mock.module("next/cache", { namedExports: { revalidatePath: () => {} } })
mock.module("@/lib/accounting/access/accounting-access", { namedExports: { requireAccountingAdmin: async () => ({ companyId: "coA", userId: "admA", role: "ADMIN" }), resolveAccountingAccessForRequest: async () => ({ ok: false, reason: "TEST" }) } })
const M = { date: 0, label: 1, amount: 2, reference: 3, headerRows: 1 }
const H = "Date;Libellé;Montant;Référence\n"
const rows = (label: string, ctx = A) => db.bankTransaction.findMany({ where: { companyId: ctx.companyId, label }, orderBy: { occurrence: "asc" }, select: { id: true, occurrence: true, identityAmbiguous: true, status: true, collisionOfId: true, collisionResolution: true, tupleKey: true, importId: true, notes: true } })
const counted = (r: { ok: true; value: { imported: number; duplicates: number; ambiguous: number; collisions: number } } | { ok: false; error: string }) => { if (!r.ok) throw new Error(r.error); return [r.value.imported, r.value.duplicates, r.value.ambiguous, r.value.collisions] }

before(async () => { useTestClock(); setBillingMailerForTests(new RecordingMailer()); await seedCompanies(db) })
after(async () => { setBillingMailerForTests(null); delete process.env.BILLING_COMPLETE_ENABLED; await db.$disconnect() })

describe("R4 — collision inter-fichiers conservée, résolution explicite", () => {
  it("reproduction Codex : second fichier avec le même virement ⇒ conservé comme collision (occurrence 2, ambiguë, provenance = occurrence 1) ; rapport collisions=1, duplicates=0", async () => {
    // Facture 5,00 € TTC créée d'abord : son numéro figure dans le libellé (candidate automatique : montant exact + référence).
    const inv = await issuedInvoice(db, A, "wA", [{ designation: "P", quantity: "1", unitPrice: "4.17", vatRate: "20" }]) // 5,00 TTC
    const num = (await db.invoice.findUniqueOrThrow({ where: { id: inv } })).number
    const f1 = `${H}12/03/2026;VIR IDENTIQUE ${num};5,00;\n`, f2 = f1 + "13/03/2026;AUTRE;2,00;X\n"
    const a = await importBankStatement(db, A, f1, "extrait1.csv", M), b = await importBankStatement(db, A, f2, "extrait2.csv", M)
    assert.deepEqual(counted(a), [1, 0, 0, 0]); assert.deepEqual(counted(b), [1, 0, 0, 1], js(b))
    const r = await rows(`VIR IDENTIQUE ${num}`)
    assert.equal(r.length, 2, "aucune opération perdue")
    assert.deepEqual(r.map((x) => [x.occurrence, x.identityAmbiguous, x.status, x.collisionOfId === r[0].id, x.collisionResolution]), [[1, false, "PENDING", false, null], [2, true, "PENDING", true, null]])
    assert.equal(r[0].tupleKey, r[1].tupleKey); assert.ok(r[0].tupleKey)
    // Aucun paiement possible avant résolution : automatique (ambiguë), manuel et « ignorer » refusés avec le message explicite.
    const auto = await autoReconcile(db, A); assert.equal(auto.matched, 1, js(auto)); assert.equal(auto.ambiguous, 1, "la collision (ambiguë) n'est jamais rapprochée automatiquement")
    assert.equal(await db.invoicePayment.count({ where: { invoiceId: inv } }), 1)
    const inv2 = await issuedInvoice(db, A, "wA", [{ designation: "P", quantity: "1", unitPrice: "4.17", vatRate: "20" }])
    assert.deepEqual(await matchTransaction(db, A, r[1].id, { invoiceId: inv2 }), { ok: false, error: BANK_ERRORS.collisionUnresolved })
    assert.deepEqual(await matchTransaction(db, A, r[1].id, { ignore: true }), { ok: false, error: BANK_ERRORS.collisionUnresolved })
    assert.equal(await db.invoicePayment.count({ where: { invoiceId: inv2 } }), 0); assert.equal((await rows(`VIR IDENTIQUE ${num}`))[1].status, "PENDING")
    // Résolution DISTINCTE ⇒ rapprochable (manuellement ; et automatiquement : son tuple n'est pas répété dans son propre relevé).
    const d = await resolveBankCollision(db, A, r[1].id, "DISTINCT", "second virement réel"); assert.deepEqual(d, { ok: true, value: { status: "PENDING" } })
    const after = (await rows(`VIR IDENTIQUE ${num}`))[1]
    assert.equal(after.collisionResolution, "DISTINCT"); assert.equal(after.identityAmbiguous, false); assert.match(after.notes ?? "", /Opération distincte de l'opération .* \(relevé extrait1\.csv, occurrence 1\) — second virement réel/)
    assert.deepEqual(await resolveBankCollision(db, A, r[1].id, "DUPLICATE"), { ok: false, error: BANK_ERRORS.notCollision }, "résolution irréversible")
    const m = await matchTransaction(db, A, r[1].id, { invoiceId: inv2 }); assert.ok(m.ok, js(m))
    assert.equal(await db.invoicePayment.count({ where: { invoiceId: inv2 } }), 1)
    assert.equal(await db.historyLog.count({ where: { entityId: r[1].id, detail: { contains: "Collision d'identité résolue" } } }), 1)
  })
  it("résolution DOUBLON ⇒ ignorée, note de provenance, aucun paiement ; résolution en bloc d'un relevé chevauchant ; rejeu refusé", async () => {
    const f3 = `${H}20/03/2026;VIR LOYER;500,00;L\n21/03/2026;VIR EAU;30,00;E\n`
    const f4 = `${H}20/03/2026;VIR LOYER;500,00;L\n21/03/2026;VIR EAU;30,00;E\n22/03/2026;VIR NEUF;1,00;N\n` // chevauchement de 2 lignes
    assert.deepEqual(counted(await importBankStatement(db, A, f3, "mars-a.csv", M)), [2, 0, 0, 0])
    const r4 = await importBankStatement(db, A, f4, "mars-b.csv", M); assert.deepEqual(counted(r4), [1, 0, 0, 2]); if (!r4.ok) return
    const loyer = await rows("VIR LOYER"); assert.equal(loyer.length, 2); assert.equal(loyer[1].collisionOfId, loyer[0].id)
    const dup = await resolveBankCollision(db, A, loyer[1].id, "DUPLICATE"); assert.deepEqual(dup, { ok: true, value: { status: "IGNORED" } })
    const l1 = (await rows("VIR LOYER"))[1]; assert.equal(l1.status, "IGNORED"); assert.equal(l1.collisionResolution, "DUPLICATE"); assert.match(l1.notes ?? "", /Doublon de l'opération .* \(relevé mars-a\.csv, occurrence 1\)/)
    // En bloc : la collision restante du relevé (VIR EAU) ; VIR NEUF (non collision) n'est pas touché.
    const bulk = await resolveImportCollisions(db, A, r4.value.importId, "DUPLICATE"); assert.deepEqual(bulk, { ok: true, value: { resolved: 1 } })
    assert.deepEqual((await rows("VIR EAU")).map((x) => [x.occurrence, x.status, x.collisionResolution]), [[1, "PENDING", null], [2, "IGNORED", "DUPLICATE"]])
    assert.deepEqual((await rows("VIR NEUF")).map((x) => [x.status, x.collisionOfId]), [["PENDING", null]])
    assert.deepEqual(await resolveImportCollisions(db, A, r4.value.importId, "DUPLICATE"), { ok: true, value: { resolved: 0 } })
    assert.deepEqual(await resolveImportCollisions(db, A, "inconnu", "DUPLICATE"), { ok: false, error: "Relevé introuvable." })
    // Un troisième relevé chevauchant : nouvelle collision (occurrence 3), provenance = occurrence 1 ; l'historique des résolutions est conservé.
    assert.deepEqual(counted(await importBankStatement(db, A, f3 + "\n", "mars-c.csv", M)), [0, 0, 0, 2])
    assert.deepEqual((await rows("VIR LOYER")).map((x) => [x.occurrence, x.status, x.collisionResolution]), [[1, "PENDING", null], [2, "IGNORED", "DUPLICATE"], [3, "PENDING", null]])
  })
  it("tuple répété dans le second fichier ET déjà connu : occurrences max+1, max+2, toutes collisions ; DISTINCT garde l'ambiguïté intra-fichier ; identifiant bancaire ⇒ doublon certain (jamais collision)", async () => {
    assert.deepEqual(counted(await importBankStatement(db, A, `${H}01/04/2026;VIR REP;7,00;\n`, "avr-a.csv", M)), [1, 0, 0, 0])
    const r = await importBankStatement(db, A, `${H}01/04/2026;VIR REP;7,00;\n01/04/2026;VIR REP;7,00;\n`, "avr-b.csv", M); assert.deepEqual(counted(r), [0, 0, 0, 2])
    const rep = await rows("VIR REP")
    assert.deepEqual(rep.map((x) => [x.occurrence, x.identityAmbiguous, x.collisionOfId === rep[0].id]), [[1, true, false], [2, true, true], [3, true, true]], "l'occurrence 1 devient ambiguë (tuple répété dans le nouveau relevé)")
    assert.ok((await resolveBankCollision(db, A, rep[1].id, "DISTINCT")).ok)
    assert.equal((await rows("VIR REP"))[1].identityAmbiguous, true, "distincte de la provenance mais encore répétée dans son propre relevé ⇒ reste ambiguë (rapprochement manuel)")
    // Identifiant bancaire stable : doublon CERTAIN, aucune collision, aucune ligne ajoutée.
    const MX = { ...M, bankId: 4 }
    assert.deepEqual(counted(await importBankStatement(db, A, `Date;Libellé;Montant;Référence;Id\n02/04/2026;VIR ID;9,00;;OP-9\n`, "id-a.csv", MX)), [1, 0, 0, 0])
    assert.deepEqual(counted(await importBankStatement(db, A, `Date;Libellé;Montant;Référence;Id\n02/04/2026;VIR ID;9,00;;OP-9\n03/04/2026;VIR ID2;1,00;;OP-10\n`, "id-b.csv", MX)), [1, 1, 0, 0])
    assert.equal((await rows("VIR ID")).length, 1)
    // Sociétés distinctes : le même tuple chez B n'est pas une collision avec A.
    assert.deepEqual(counted(await importBankStatement(db, B, `${H}01/04/2026;VIR REP;7,00;\n`, "avr-a.csv", M)), [1, 0, 0, 0]); assert.equal((await rows("VIR REP", B))[0].collisionOfId, null)
  })
  it("imports concurrents de relevés chevauchants : une opération certaine + une collision, jamais deux certaines ; action réelle de résolution (session simulée) refuse les identifiants de B", async () => {
    const f7 = `${H}20/05/2026;VIR CONC;7,00;C\n21/05/2026;VIR A;8,00;A\n`, f8 = `${H}20/05/2026;VIR CONC;7,00;C\n22/05/2026;VIR B;9,00;B\n`
    const [a, b] = await Promise.all([importBankStatement(db, A, f7, "f7.csv", M), importBankStatement(db, A, f8, "f8.csv", M)])
    assert.ok(a.ok && b.ok, js([a, b]))
    const conc = await rows("VIR CONC")
    assert.deepEqual(conc.map((x) => [x.occurrence, x.collisionOfId === null]), [[1, true], [2, false]], "le second import (rejoué sur violation d'unicité) voit le tuple connu ⇒ collision")
    assert.equal(a.value.collisions + b.value.collisions, 1); assert.equal(a.value.imported + b.value.imported, 3)
    const { resolveBankCollisionAction, resolveImportCollisionsAction } = await import("@/lib/actions/accounting-c5.actions")
    assert.deepEqual(await resolveBankCollisionAction({ transactionId: conc[1].id, resolution: "DUPLICATE", companyId: "coB" } as unknown), { ok: false, error: "Demande invalide." })
    const bImp = await importBankStatement(db, B, f7, "f7.csv", M); if (!bImp.ok) throw new Error(bImp.error)
    const bImp2 = await importBankStatement(db, B, f8, "f8.csv", M); if (!bImp2.ok) throw new Error(bImp2.error)
    const concB = await rows("VIR CONC", B)
    assert.deepEqual(await resolveBankCollisionAction({ transactionId: concB[1].id, resolution: "DUPLICATE" }), { ok: false, error: BANK_ERRORS.notFound }, "identifiant de B depuis la session A : introuvable, sans mutation")
    assert.deepEqual(await resolveImportCollisionsAction({ importId: bImp2.value.importId, resolution: "DUPLICATE" }), { ok: false, error: "Relevé introuvable." })
    assert.equal((await rows("VIR CONC", B))[1].status, "PENDING")
    assert.deepEqual(await resolveBankCollisionAction({ transactionId: conc[1].id, resolution: "DUPLICATE", notes: "même relevé" }), { ok: true, status: "IGNORED" })
  })
})
