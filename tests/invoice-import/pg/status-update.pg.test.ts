// Amendement SPEC-INVOICE-IMPORT-001 §5 — tests PostgreSQL (base jetable migrée) du changement de statut en masse :
// dry-run sans écriture, garde du nombre relu, idempotence, périmètre (société, lot, statut de départ), journal, empreinte,
// réimport sans conflit, totaux de la page Factures, et absence de tout effet sur la facturation Planificator.
import assert from "node:assert/strict"
import { after, before, describe, it } from "node:test"
import { PrismaClient } from "@prisma/client"
import { addFileToBatch, createBatch, getBatchView } from "@/lib/invoice-import/import.service"
import { STATUS_UPDATE_ERRORS, applyImportedStatusChange, hashWithStatus, listBatchesWithStatus, loadImportedTotalsRows, planImportedStatusChange } from "@/lib/invoice-import/status-update.service"
import { computeImportedTotals } from "@/lib/invoice-import/imported-totals"
import { numberKey } from "@/lib/invoice-import/normalize"
import type { ImportStatus } from "@/lib/invoice-import/types"

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL requis (base PostgreSQL jetable migrée)")
const db = new PrismaClient()
const A = { companyId: "stA", userId: "stAdmA" }
const B = { companyId: "stB", userId: "stAdmB" }
const TODAY = new Date("2026-11-19T00:00:00Z")
const req = (batchId: string) => ({ batchId, from: "UNKNOWN" as const, to: "PAID" as const })

async function seedImported(ctx: typeof A, batchId: string, clientId: string, p: { id: string; kind: "INVOICE" | "CREDIT_NOTE"; number: string; ttc: number; status: ImportStatus; sourceStatus?: string | null }) {
  const vat = Math.round(p.ttc / 6), ht = p.ttc - vat
  const base = {
    kind: p.kind, numberKey: numberKey(p.number), clientId, issueDate: new Date("2026-06-10T00:00:00Z"), dueDate: null,
    totalHTCents: BigInt(ht), vatCents: BigInt(vat), totalTTCCents: BigInt(p.ttc), creditedNumber: null,
  }
  await db.importedInvoice.create({
    data: {
      ...base, id: p.id, companyId: ctx.companyId, batchId, number: p.number, sourceSystem: "OTHER", sourceStatus: p.sourceStatus ?? null, status: p.status,
      contentHash: hashWithStatus(base, p.status), createdById: ctx.userId,
    },
  })
}

async function billingFingerprint() {
  const [invoices, payments, counters, entries] = await Promise.all([db.invoice.findMany({ orderBy: { id: "asc" }, select: { id: true, status: true, totalTTC: true } }), db.invoicePayment.count(), db.documentCounter.count(), db.journalEntry.count()])
  return JSON.stringify({ invoices, payments, counters, entries })
}

let batchA = "", batchB = "", previewBatch = "", baseline = ""

before(async () => {
  await db.$executeRawUnsafe(`INSERT INTO companies(id,name,slug,siret,"updatedAt") VALUES ('stA','GALYA ST','st-a','12345678900099',now()),('stB','Autre ST','st-b','98765432100099',now())`)
  await db.$executeRawUnsafe(`INSERT INTO users(id,email,password,role,"companyId","updatedAt") VALUES ('stAdmA','st-a@example.test','x','ADMIN','stA',now()),('stAdmB','st-b@example.test','x','ADMIN','stB',now())`)
  await db.$executeRawUnsafe(`INSERT INTO clients(id,"companyId",name,"updatedAt") VALUES ('stClA','stA','JAULIN',now()),('stClA2','stA','Agasf',now()),('stClB','stB','JAULIN',now())`)
  await db.$executeRawUnsafe(`INSERT INTO worksites(id,"companyId","clientId","createdById",name,"updatedAt") VALUES ('stWA','stA','stClA','stAdmA','Salon',now())`)
  // Brouillon Planificator (PROV) : ne doit compter nulle part et ne doit pas bouger.
  await db.$executeRawUnsafe(`INSERT INTO invoices(id,"companyId","worksiteId","clientId",number,status,kind,"totalTTC","createdById","updatedAt") VALUES ('stNative','stA','stWA','stClA','PROV-2026-0001','DRAFT','INVOICE',12865.92,'stAdmA',now())`)
  for (const [id, company, status] of [["stBatchA", "stA", "COMMITTED"], ["stBatchB", "stB", "COMMITTED"], ["stBatchP", "stA", "PREVIEW"]] as const) {
    await db.invoiceImportBatch.create({ data: { id, companyId: company, sourceSystem: "OTHER", sourceLabel: "Ancien logiciel", status, rows: { rows: [], table: null }, createdById: company === "stA" ? A.userId : B.userId, committedAt: status === "COMMITTED" ? new Date() : null } })
  }
  batchA = "stBatchA"; batchB = "stBatchB"; previewBatch = "stBatchP"
  await seedImported(A, batchA, "stClA", { id: "stI1", kind: "INVOICE", number: "2026-06-000020", ttc: 5000000, status: "UNKNOWN" })
  await seedImported(A, batchA, "stClA", { id: "stI2", kind: "INVOICE", number: "2026-06-000021", ttc: 1000000, status: "UNKNOWN", sourceStatus: "?" })
  await seedImported(A, batchA, "stClA", { id: "stC1", kind: "CREDIT_NOTE", number: "2026-06-000025", ttc: 1380000, status: "UNKNOWN" })
  await seedImported(A, batchA, "stClA2", { id: "stI3", kind: "INVOICE", number: "2026-06-000022", ttc: 700000, status: "ISSUED" })
  await seedImported(B, batchB, "stClB", { id: "stIB", kind: "INVOICE", number: "2026-06-000020", ttc: 999900, status: "UNKNOWN" })
  baseline = await billingFingerprint()
})
after(async () => { await db.$disconnect() })

const statuses = async () => Object.fromEntries((await db.importedInvoice.findMany({ select: { id: true, status: true } })).map((r) => [r.id, r.status]))

describe("changement de statut en masse — dry-run", () => {
  it("liste exacte (UNKNOWN du lot uniquement), totaux signés, aucune écriture", async () => {
    const before = await statuses()
    const r = await planImportedStatusChange(db, A, req(batchA))
    assert.ok(r.ok)
    assert.deepEqual(r.value.items.map((i) => i.id).sort(), ["stC1", "stI1", "stI2"])
    assert.equal(r.value.invoiceCount, 2)
    assert.equal(r.value.creditNoteCount, 1)
    assert.equal(r.value.netTTCCents, BigInt(5000000 + 1000000 - 1380000))
    assert.equal(r.value.items.find((i) => i.id === "stC1")?.signedTTCCents, BigInt(-1380000))
    assert.deepEqual(await statuses(), before)
  })
  it("lots proposés : uniquement les lots validés de la société avec des pièces UNKNOWN", async () => {
    assert.deepEqual((await listBatchesWithStatus(db, A.companyId, "UNKNOWN")).map((b) => [b.id, b.count]), [[batchA, 3]])
  })
  it("isolation société : le lot d'une autre société est introuvable", async () => {
    assert.deepEqual(await planImportedStatusChange(db, A, req(batchB)), { ok: false, error: STATUS_UPDATE_ERRORS.batchNotFound })
  })
  it("lot en aperçu refusé ; statut de départ = cible refusé", async () => {
    assert.deepEqual(await planImportedStatusChange(db, A, req(previewBatch)), { ok: false, error: STATUS_UPDATE_ERRORS.batchNotCommitted })
    assert.deepEqual(await planImportedStatusChange(db, A, { batchId: batchA, from: "PAID", to: "PAID" }), { ok: false, error: STATUS_UPDATE_ERRORS.sameStatus })
  })
})

describe("changement de statut en masse — application", () => {
  it("nombre relu différent : refus, rien n'est modifié", async () => {
    const before = await statuses()
    assert.deepEqual(await applyImportedStatusChange(db, A, { ...req(batchA), expectedCount: 2 }), { ok: false, error: STATUS_UPDATE_ERRORS.stale })
    assert.deepEqual(await statuses(), before)
    assert.equal(await db.historyLog.count({ where: { companyId: A.companyId, entityType: "ImportedInvoice" } }), 0)
  })
  it("application : 3 pièces PAID, empreinte recalculée, montants et statut source intacts, journal par pièce", async () => {
    const r = await applyImportedStatusChange(db, A, { ...req(batchA), expectedCount: 3 })
    assert.ok(r.ok)
    assert.equal(r.value.items.length, 3)
    const rows = await db.importedInvoice.findMany({ where: { id: { in: ["stI1", "stI2", "stC1"] } } })
    for (const row of rows) {
      assert.equal(row.status, "PAID")
      assert.equal(row.updatedById, A.userId)
      assert.equal(row.contentHash, hashWithStatus(row, "PAID"))
    }
    assert.equal(rows.find((x) => x.id === "stI2")?.sourceStatus, "?")
    assert.equal(rows.find((x) => x.id === "stC1")?.totalTTCCents, BigInt(1380000))
    const logs = await db.historyLog.findMany({ where: { companyId: A.companyId, entityType: "ImportedInvoice" } })
    assert.deepEqual(logs.map((l) => l.entityId).sort(), ["stC1", "stI1", "stI2"])
    assert.ok(logs.every((l) => l.action === "STATUS_CHANGED" && l.actorId === A.userId))
  })
  it("hors périmètre intact : pièce ISSUED du même lot, pièce UNKNOWN de l'autre société", async () => {
    const s = await statuses()
    assert.equal(s.stI3, "ISSUED")
    assert.equal(s.stIB, "UNKNOWN")
  })
  it("idempotent : relance ⇒ plan vide, application refusée sans écriture", async () => {
    const plan = await planImportedStatusChange(db, A, req(batchA))
    assert.ok(plan.ok)
    assert.equal(plan.value.items.length, 0)
    assert.deepEqual(await applyImportedStatusChange(db, A, { ...req(batchA), expectedCount: 3 }), { ok: false, error: STATUS_UPDATE_ERRORS.nothing })
    assert.equal(await db.historyLog.count({ where: { companyId: A.companyId, entityType: "ImportedInvoice" } }), 3)
    assert.deepEqual(await listBatchesWithStatus(db, A.companyId, "UNKNOWN"), [])
  })
  it("facturation Planificator intacte (factures, paiements, compteurs, écritures)", async () => {
    assert.equal(await billingFingerprint(), baseline)
  })
})

describe("totaux /factures après application", () => {
  it("encaissé importé = factures payées − avoir payé ; dû = pièce ISSUED ; société B non comptée", async () => {
    const t = computeImportedTotals(await loadImportedTotalsRows(db, A.companyId, TODAY), TODAY)
    assert.equal(t.collectedCents, BigInt(5000000 + 1000000 - 1380000))
    assert.equal(t.dueCents, BigInt(700000))
    assert.deepEqual(t.excluded, { unknown: 0, partial: 0, cancelled: 0 })
  })
})

describe("agrégation en base des totaux", () => {
  it("loadImportedTotalsRows (groupBy) donne exactement le calcul pièce par pièce, retard compris", async () => {
    await db.importedInvoice.update({ where: { id: "stI3" }, data: { dueDate: new Date("2026-10-01T00:00:00Z") } })
    await seedImported(A, batchA, "stClA2", { id: "stI4", kind: "INVOICE", number: "2026-06-000023", ttc: 300000, status: "ISSUED" })
    await seedImported(A, batchA, "stClA2", { id: "stI5", kind: "INVOICE", number: "2026-06-000024", ttc: 120000, status: "CANCELLED" })
    await seedImported(A, batchA, "stClA2", { id: "stC2", kind: "CREDIT_NOTE", number: "2026-06-000026", ttc: 50000, status: "ISSUED" })
    const perRow = (await db.importedInvoice.findMany({ where: { companyId: A.companyId }, select: { kind: true, status: true, totalTTCCents: true, dueDate: true } }))
    const expected = computeImportedTotals(perRow, TODAY)
    const aggregated = computeImportedTotals(await loadImportedTotalsRows(db, A.companyId, TODAY), TODAY)
    assert.deepEqual(aggregated, expected)
    assert.equal(aggregated.overdueCents, BigInt(700000))
    assert.equal(aggregated.overdueCount, 1)
    assert.equal(aggregated.dueCents, BigInt(700000 + 300000 - 50000))
    assert.equal(aggregated.excluded.cancelled, 1)
  })
})

describe("réimport du même export (statut vide) après passage en « Payée »", () => {
  it("pièce reconnue « déjà importée », pas de conflit", async () => {
    const csv = ["Numéro;Type;Client;Date d'émission;Date d'échéance;Total HT;Total TVA;Total TTC;Statut", `2026-06-000021;Facture;JAULIN;10/06/2026;;8 333,33;1 666,67;10 000,00;`].join("\r\n")
    const id = (await createBatch(db, A, { sourceSystem: "OTHER", sourceLabel: "Ancien logiciel" })).id
    const added = await addFileToBatch(db, A, id, { name: "export.csv", data: Buffer.from(csv, "utf8") })
    assert.ok(added.ok, added.ok ? "" : added.error)
    const v = await getBatchView(db, A, id)
    assert.ok(v)
    const a = v.analyzed.find((x) => x.row.number === "2026-06-000021")
    assert.ok(a, "ligne absente")
    assert.equal(a.row.status, "UNKNOWN")
    assert.ok(a.anomalies.some((x) => x.code === "ALREADY_IMPORTED"), JSON.stringify(a.anomalies))
    assert.ok(!a.anomalies.some((x) => x.code === "CONFLICT"))
  })
})
