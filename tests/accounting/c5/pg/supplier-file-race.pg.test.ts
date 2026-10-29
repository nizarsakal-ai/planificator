// Factures fournisseurs — courses et unicité d'une pièce active (29/10/2026, revue Codex « intégration production »).
// Base PostgreSQL JETABLE uniquement (tests/billing/pg/with-disposable-db.sh). Données synthétiques.
// M1 : deux imports simultanés du même fichier ⇒ réponse idempotente (fichier réutilisé ou doublon explicite), jamais une erreur brute.
// M2 : un fichier ne peut être rattaché qu'à UNE facture fournisseur active (non REJETÉE) par société, par tout chemin (admin et intake) ;
//      garantie en base (index unique partiel) + erreur explicite ; une facture REJETÉE libère sa pièce (réimport autorisé).
import assert from "node:assert/strict"
import { after, before, describe, it } from "node:test"
import { PrismaClient } from "@prisma/client"
import { createSupplierInvoice, rejectSupplierInvoice, storeSupplierFile, SUPPLIER_ERRORS } from "@/lib/accounting/c5/supplier-invoice.service"
import { LifecycleAbort, withLifecycleAbort } from "@/lib/billing/lifecycle-abort"

const db = new PrismaClient()
// Identifiants propres à ce fichier : la suite c5.pg.test.ts partage la même base jetable (test-concurrency=1) et insère coA/coB.
const A = { companyId: "coRA", userId: "admRA" }
const B = { companyId: "coRB", userId: "admRB" }
const now = new Date("2026-10-29T10:00:00Z")
const png = (tag: string) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(`race-${tag}`)])
const input = (number: string) => ({ supplierName: "Fournisseur Course", siret: null, number, date: now, dueDate: null, totalHTCents: BigInt(1000), vatCents: BigInt(200), totalTTCCents: BigInt(1200), vatRateBp: 2000, category: null, expenseAccountId: null, notes: null })
const settle = <T,>(ps: Promise<T>[]) => Promise.allSettled(ps)

before(async () => {
  await db.$executeRawUnsafe(`INSERT INTO companies(id,name,slug,siret,address,"updatedAt") VALUES ('coRA','Société course A','race-a','12345678900012','1 rue A',now()),('coRB','Société course B','race-b','98765432100011','2 rue B',now())`)
  await db.$executeRawUnsafe(`INSERT INTO users(id,email,password,role,"companyId","updatedAt") VALUES ('admRA','race-a@x','x','ADMIN','coRA',now()),('admRB','race-b@x','x','ADMIN','coRB',now())`)
})
after(async () => { await db.$disconnect() })

describe("M1 — import simultané du même fichier", () => {
  it("12 imports simultanés ⇒ une seule ligne supplier_invoice_files, 12 réponses ok (un créé, les autres réutilisés), aucune erreur brute", async () => {
    const bytes = png("m1")
    const results = await settle(Array.from({ length: 12 }, () => storeSupplierFile(db, A, bytes, "facture.png")))
    const rejected = results.filter((r) => r.status === "rejected")
    assert.deepEqual(rejected.map((r) => String((r as PromiseRejectedResult).reason?.code ?? (r as PromiseRejectedResult).reason)), [], "aucune promesse rejetée (P2002 brut)")
    const values = results.map((r) => (r as PromiseFulfilledResult<Awaited<ReturnType<typeof storeSupplierFile>>>).value)
    assert.ok(values.every((v) => v.ok), JSON.stringify(values))
    const ids = new Set(values.map((v) => (v.ok ? v.value.fileId : "?")))
    assert.equal(ids.size, 1)
    assert.equal(values.filter((v) => v.ok && !v.value.duplicate).length, 1, "exactement un « créé »")
    assert.equal(await db.supplierInvoiceFile.count({ where: { companyId: A.companyId, sha256: values[0].ok ? values[0].value.sha256 : "" } }), 1)
  })
  it("isolation : mêmes octets pour la société B ⇒ fichier distinct ; B ne peut pas rattacher le fichier de A", async () => {
    const bytes = png("m1")
    const a = await storeSupplierFile(db, A, bytes, "facture.png"); assert.ok(a.ok); if (!a.ok) return
    const b = await storeSupplierFile(db, B, bytes, "facture.png"); assert.ok(b.ok); if (!b.ok) return
    assert.notEqual(a.value.fileId, b.value.fileId)
    assert.deepEqual(await createSupplierInvoice(db, B, input("B-1"), { fileId: a.value.fileId, ocr: null }), { ok: false, error: "Fichier introuvable." })
  })
})

describe("M2 — une seule facture active par pièce", () => {
  it("chemin admin, séquentiel : la seconde création sur le même fileId est refusée explicitement ; une seule PENDING", async () => {
    const f = await storeSupplierFile(db, A, png("m2-seq"), "facture.png"); assert.ok(f.ok); if (!f.ok) return
    const c1 = await createSupplierInvoice(db, A, input("SEQ-1"), { fileId: f.value.fileId, ocr: null }); assert.ok(c1.ok)
    const c2 = await createSupplierInvoice(db, A, input("SEQ-2"), { fileId: f.value.fileId, ocr: null })
    assert.deepEqual(c2, { ok: false, error: SUPPLIER_ERRORS.duplicateSubmission })
    assert.equal(await db.supplierInvoice.count({ where: { companyId: A.companyId, fileId: f.value.fileId, status: { not: "REJECTED" } } }), 1)
    // Le fichier rattaché à une facture active n'est plus réimportable (règle existante conservée).
    assert.deepEqual(await storeSupplierFile(db, A, png("m2-seq"), "facture.png"), { ok: false, error: SUPPLIER_ERRORS.duplicateFile })
  })
  it("appel direct du service (hors wrapper), 8 créations simultanées sur le même fileId ⇒ une PENDING ; les perdants reçoivent l'exception TYPÉE LifecycleAbort (contrat pour l'appelant, qui doit l'encadrer de withLifecycleAbort)", async () => {
    const f = await storeSupplierFile(db, A, png("m2-race"), "facture.png"); assert.ok(f.ok); if (!f.ok) return
    const results = await settle(Array.from({ length: 8 }, (_, i) => createSupplierInvoice(db, A, input(`RACE-${i}`), { fileId: f.value.fileId, ocr: null })))
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected")
    for (const r of rejected) assert.ok(r.reason instanceof LifecycleAbort && r.reason.userMessage === SUPPLIER_ERRORS.duplicateSubmission, `rejet attendu : LifecycleAbort typé, reçu ${String(r.reason)}`)
    const values = results.filter((r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof createSupplierInvoice>>> => r.status === "fulfilled").map((r) => r.value)
    assert.equal(values.filter((v) => v.ok).length, 1, JSON.stringify(values))
    assert.ok(values.filter((v) => !v.ok).every((v) => !v.ok && v.error === SUPPLIER_ERRORS.duplicateSubmission), "les refus du pré-contrôle sont explicites")
    assert.equal(await db.supplierInvoice.count({ where: { companyId: A.companyId, fileId: f.value.fileId, status: { not: "REJECTED" } } }), 1)
  })
  it("garantie en base : une insertion SQL directe d'une seconde facture active sur la même pièce est refusée ; une REJETÉE est tolérée", async () => {
    const f = await storeSupplierFile(db, A, png("m2-sql"), "facture.png"); assert.ok(f.ok); if (!f.ok) return
    const c = await createSupplierInvoice(db, A, input("SQL-1"), { fileId: f.value.fileId, ocr: null }); assert.ok(c.ok)
    const insert = (id: string, status: string) => db.$executeRawUnsafe(`INSERT INTO supplier_invoices(id,"companyId","supplierName",number,date,"totalHTCents","vatCents","totalTTCCents",status,"fileId","createdById","updatedAt") VALUES ('${id}','coRA','X','${id}','2026-10-29',1000,200,1200,'${status}','${f.value.fileId}','admRA',now())`)
    await assert.rejects(insert("sql-dup-pending", "PENDING"), /one_active_per_file|23505|Unique constraint/)
    await assert.rejects(insert("sql-dup-validated", "VALIDATED"), /one_active_per_file|23505|Unique constraint/)
    await insert("sql-rejected-ok", "REJECTED")
    assert.equal(await db.supplierInvoice.count({ where: { fileId: f.value.fileId } }), 2)
  })
  it("REJETÉE ⇒ la pièce est libérée : réimport réutilise le fichier et une nouvelle facture peut le rattacher", async () => {
    const f = await storeSupplierFile(db, A, png("m2-rej"), "facture.png"); assert.ok(f.ok); if (!f.ok) return
    const c1 = await createSupplierInvoice(db, A, input("REJ-1"), { fileId: f.value.fileId, ocr: null }); assert.ok(c1.ok); if (!c1.ok) return
    assert.deepEqual(await rejectSupplierInvoice(db, A, c1.value.id, "erreur de saisie"), { ok: true, value: undefined })
    const again = await storeSupplierFile(db, A, png("m2-rej"), "facture.png")
    assert.ok(again.ok && again.value.duplicate && again.value.fileId === f.value.fileId)
    const c2 = await createSupplierInvoice(db, A, input("REJ-2"), { fileId: f.value.fileId, ocr: null }); assert.ok(c2.ok)
    assert.equal(await db.supplierInvoice.count({ where: { companyId: A.companyId, fileId: f.value.fileId } }), 2)
  })
  it("chemin ADMIN tel qu'écrit dans l'action (transaction + withLifecycleAbort) : 8 créations simultanées ⇒ une PENDING, refus explicites, aucun journal orphelin", async () => {
    // Reproduction FIDÈLE du wrapper de createSupplierInvoiceAction (test de niveau service : l'action réelle exige une session).
    const f = await storeSupplierFile(db, A, png("m2-admin-tx"), "facture.png"); assert.ok(f.ok); if (!f.ok) return
    const results = await settle(Array.from({ length: 8 }, (_, i) => withLifecycleAbort(() => db.$transaction((tx) => createSupplierInvoice(tx, A, input(`ADM-${i}`), { fileId: f.value.fileId, ocr: null })))))
    assert.deepEqual(results.filter((r) => r.status === "rejected").map((r) => String((r as PromiseRejectedResult).reason)), [], "aucune erreur brute")
    const values = results.map((r) => (r as PromiseFulfilledResult<Awaited<ReturnType<typeof createSupplierInvoice>>>).value)
    assert.equal(values.filter((v) => v.ok).length, 1)
    assert.ok(values.filter((v) => !v.ok).every((v) => !v.ok && v.error === SUPPLIER_ERRORS.duplicateSubmission))
    const invoices = await db.supplierInvoice.findMany({ where: { companyId: A.companyId, fileId: f.value.fileId }, select: { id: true } })
    assert.equal(invoices.length, 1)
    // Atomicité facture + journal : exactement un journal CREATED pour cette pièce, aucun pour les transactions annulées.
    assert.equal(await db.historyLog.count({ where: { companyId: A.companyId, entityType: "SupplierInvoice", action: "CREATED", entityId: { in: invoices.map((i) => i.id) } } }), 1)
    assert.equal(await db.historyLog.count({ where: { companyId: A.companyId, entityType: "SupplierInvoice", action: "CREATED", detail: { contains: "ADM-" } } }), 1)
  })
  it("chemin INTAKE tel qu'écrit dans l'action (pré-contrôle + transaction Serializable + withLifecycleAbort) : 8 soumissions simultanées ⇒ une PENDING ; refus explicites ou conflits de sérialisation (P2034), jamais deux factures", async () => {
    // Reproduction FIDÈLE du wrapper de createIntakeInvoiceAction (test de niveau service : l'action réelle exige une session intake ;
    // la preuve d'accès réel de l'action reste tests/accounting/supplier-intake.actions.test.ts, à base simulée).
    const f = await storeSupplierFile(db, A, png("m2-intake-tx"), "facture.png"); assert.ok(f.ok); if (!f.ok) return
    const submit = (i: number) => withLifecycleAbort(() => db.$transaction(async (tx) => {
      const duplicate = await tx.supplierInvoice.findFirst({ where: { companyId: A.companyId, fileId: f.value.fileId, status: { not: "REJECTED" } }, select: { id: true } })
      if (duplicate) return { ok: false as const, error: "Ce fichier a déjà été soumis." }
      return createSupplierInvoice(tx, A, input(`INT-${i}`), { fileId: f.value.fileId, ocr: null })
    }, { isolationLevel: "Serializable" }))
    const results = await settle(Array.from({ length: 8 }, (_, i) => submit(i)))
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected")
    for (const r of rejected) assert.equal((r.reason as { code?: string }).code, "P2034", `seul un conflit de sérialisation (P2034, réessayable) est toléré : ${String(r.reason)}`)
    const values = results.filter((r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof createSupplierInvoice>>> => r.status === "fulfilled").map((r) => r.value)
    assert.equal(values.filter((v) => v.ok).length, 1, JSON.stringify(values))
    assert.ok(values.filter((v) => !v.ok).every((v) => !v.ok && v.error === SUPPLIER_ERRORS.duplicateSubmission))
    assert.equal(await db.supplierInvoice.count({ where: { companyId: A.companyId, fileId: f.value.fileId, status: { not: "REJECTED" } } }), 1)
    console.log(`intake : ok=1, refus explicites=${values.filter((v) => !v.ok).length}, conflits de sérialisation P2034=${rejected.length}`)
  })
  it("sans fichier : plusieurs factures saisies manuellement restent possibles (l'index ne porte que sur fileId non nul)", async () => {
    assert.ok((await createSupplierInvoice(db, A, input("MAN-1"), { fileId: null, ocr: null })).ok)
    assert.ok((await createSupplierInvoice(db, A, input("MAN-2"), { fileId: null, ocr: null })).ok)
  })
})
