/**
 * Lot C Planificator V2 : budgets et marges sur une base PostgreSQL JETABLE migrée (jamais une base réelle).
 * Le jeu fictif est construit par les VRAIS services des lots A (commande, réception, sortie de stock) et B (location,
 * matériel propre), puis la marge est lue par `getWorksiteBudget` et comparée au centime. Couvre aussi : versions
 * immuables (déclencheurs), révision concurrente, imputations (plafond, facture déjà comptée, autre entreprise,
 * concurrence, annulation), isolation entre entreprises et audit.
 * Intégration sur l'arbre publié 35c0f227 (revue indépendante du cadrage C) : dernier bloc ajouté, société coF distincte,
 * construit par les VRAIS services de facturation (devis 1 000 HT accepté, acompte 300 émis, facture de solde issue du
 * devis NETTE 700 après déduction de l'acompte ⇒ facturé 1 000 et non 1 300 ; avoir partiel 100 ⇒ 900 ; brouillon ignoré),
 * une commande, sa réception et sa facture fournisseur liée comptées UNE fois (engagé puis réel) et des véhicules V3 (trajet rattaché au chantier, frais approuvé imputé, frais en attente exclu) ; imputations
 * concurrentes sur DEUX chantiers différents ; isolation de lecture entre sociétés (sources de la page et de l'export).
 * Exécution : TEST_PG_ADMIN_URL=postgresql://postgres@127.0.0.1:5432/postgres \
 *   sh tests/billing/pg/with-disposable-db.sh budget npm run test:budget:pg
 */
import assert from "node:assert/strict"
import { after, before, describe, it } from "node:test"
import { Prisma, PrismaClient } from "@prisma/client"
import * as budget from "@/lib/budget/budget.service"
import * as stock from "@/lib/stock/stock.service"
import * as equipment from "@/lib/equipment/equipment.service"
import { BUDGET_ERRORS } from "@/lib/budget/budget.core"
import { getWorksiteBudget, listAllocatableInvoices, listWorksiteMargins } from "@/lib/budget/queries"
import { parseDay } from "@/lib/equipment/equipment.core"
import { randomUUID } from "node:crypto"
import { setBillingClockForTests } from "@/lib/billing/clock"
import { RecordingMailer, setBillingMailerForTests } from "@/lib/billing/mail/mailer"
import { parseQuoteForm } from "@/lib/billing/quotes/quote-schemas"
import { acceptQuoteManually, convertQuote, createQuote, sendQuote } from "@/lib/billing/quotes/quote.service"
import { parseInvoiceForm } from "@/lib/billing/invoices/invoice-schemas"
import { createDraftInvoice, issueInvoice } from "@/lib/billing/invoices/invoice.service"
import { applyDepositDeductions, createDepositInvoice } from "@/lib/billing/invoices/deposit.service"
import { createPartialCreditNote } from "@/lib/billing/invoices/credit-note.service"
import { createCreditNoteCore } from "@/lib/billing/invoice-lifecycle.core"
import { nextDocumentNumber } from "@/lib/billing/numbering"
import { flushDeferredConstraints } from "@/lib/deferred-constraints"
/**
 * Refus d'un déclencheur DIFFÉRÉ dans une transaction interactive Prisma (correctif c1-v7, preuve postgres.log) :
 * - oracle SQL : `SET CONSTRAINTS ALL IMMEDIATE` (flushDeferredConstraints) dans la transaction ⇒ le refus est levé DANS la
 *   transaction, message PostgreSQL d'origine vérifié par `motif` ;
 * - refus au COMMIT : Prisma 5 avale l'erreur levée au COMMIT (src/lib/deferred-constraints.ts) ; oracle précis : la promesse
 *   est RÉSOLUE (comportement documenté) ou, si une version de Prisma la rejette, son message porte `motif` ; dans les deux
 *   cas l'état est ensuite vérifié annulé par `annule()`.
 */
async function refusDiffere(ecrire: (tx: Prisma.TransactionClient) => Promise<unknown>, motif: RegExp, annule: () => Promise<boolean>) {
  await assert.rejects(db.$transaction(async (tx) => { await ecrire(tx); await flushDeferredConstraints(tx) }), motif, "oracle SQL (contraintes immédiates)")
  assert.ok(await annule(), "rien n'est écrit après le refus immédiat")
  const auCommit = await Promise.allSettled([db.$transaction(async (tx) => { await ecrire(tx) })])
  if (auCommit[0].status === "rejected") assert.match(String((auCommit[0].reason as Error)?.message), motif, "refus au COMMIT : message")
  else assert.equal(auCommit[0].status, "fulfilled", "Prisma 5 : erreur du COMMIT avalée (documenté)")
  assert.ok(await annule(), "refus au COMMIT : la base a annulé la transaction")
}
import { afterEquipmentChange, afterGoodsReceipt } from "@/lib/integration/event-sync"
import { EVENT_STOCK_ARTICLES } from "@/components/equipment/event-catalog"
import { executeMileageCommand } from "@/lib/vehicules/mileage-service"
import { executeExpenseCommand } from "@/lib/vehicules/v3/expense-service"

const db = new PrismaClient()
const A = { companyId: "coA", userId: "uA" }
const B = { companyId: "coB", userId: "uB" }
const NOW = new Date("2026-11-04T09:00:00Z")
const BACK = new Date("2026-11-05T16:00:00Z")
const d = (s: string) => parseDay(s)!
const ok = <T>(r: { ok: true; value: T } | { ok: false; error: string }): T => { assert.ok(r.ok, r.ok ? "" : r.error); return (r as { ok: true; value: T }).value }
const lines = (m: Record<string, bigint>) => Object.entries(m).map(([nature, amountCents]) => ({ nature: nature as "MATERIALS", amountCents }))
const margin = async () => (await getWorksiteBudget(db, "coA", "wA"))!.margin
const row = async (n: string) => (await margin()).natures.find((r) => r.nature === n)!

before(async () => {
  for (const sqlText of [
    `INSERT INTO companies(id,name,slug,"updatedAt") VALUES ('coA','A','a',now()),('coB','B','b',now())`,
    `INSERT INTO users(id,email,password,"updatedAt") VALUES ('uA','a@x.test','x',now()),('uB','b@x.test','x',now())`,
    `INSERT INTO clients(id,"companyId",name,"updatedAt") VALUES ('clA','coA','ClA',now()),('clB','coB','ClB',now())`,
    `INSERT INTO worksites(id,"companyId","clientId","createdById",name,"updatedAt") VALUES ('wA','coA','clA','uA','Chantier A',now()),('wA2','coA','clA','uA','Chantier A2',now()),('wB','coB','clB','uB','Chantier B',now())`,
    `INSERT INTO worksites(id,"companyId","clientId","createdById",name,"archivedAt","updatedAt") VALUES ('wArch','coA','clA','uA','Chantier archivé',now(),now())`,
    `INSERT INTO articles(id,"companyId",designation,unit,"unitPrice","updatedAt") VALUES ('artA','coA','Ciment 25 kg','sac',8.50,now())`,
    `INSERT INTO suppliers(id,"companyId",name,"updatedAt") VALUES ('supA','coA','Fournisseur A',now()),('supB','coB','Fournisseur B',now())`,
    `INSERT INTO supplier_invoices(id,"companyId","supplierId","supplierName",number,date,"totalHTCents","vatCents","totalTTCCents",status,"createdById","updatedAt") VALUES
      ('siSub','coA','supA','Fournisseur A','F-SUB','2026-10-20',100000,20000,120000,'VALIDATED','uA',now()),
      ('siPend','coA','supA','Fournisseur A','F-PEND','2026-10-21',50000,10000,60000,'PENDING','uA',now()),
      ('siRej','coA','supA','Fournisseur A','F-REJ','2026-10-22',7000,1400,8400,'REJECTED','uA',now()),
      ('siLinked','coA','supA','Fournisseur A','F-LINK','2026-10-23',4800,960,5760,'VALIDATED','uA',now()),
      ('siB','coB','supB','Fournisseur B','F-B','2026-10-23',9000,1800,10800,'VALIDATED','uB',now())`,
    // Devis : accepté 2 000,00 (signé) et brouillon 500,00 (ignoré) ; facture brouillon (non émise, ignorée).
    `INSERT INTO quotes(id,"companyId","worksiteId","clientId",number,status,"totalHT","createdById","updatedAt") VALUES
      ('qAcc','coA','wA','clA','DEV-2026-0001','ACCEPTED',2000.00,'uA',now()),('qDraft','coA','wA','clA','DEV-2026-0002','DRAFT',500.00,'uA',now())`,
    `INSERT INTO invoices(id,"companyId","worksiteId","clientId",number,"createdById","updatedAt",status,kind,"totalHT","totalVAT","totalTTC") VALUES ('invDraft','coA','wA','clA','PROV-2026-0001','uA',now(),'DRAFT','INVOICE',999.00,199.80,1198.80)`,
  ]) await db.$executeRawUnsafe(sqlText)
})
after(() => db.$disconnect())

describe("budget : création, révisions, historique immuable", () => {
  it("budget initial (version 1) ; doublon, chantier archivé ou d'une autre entreprise refusés sans écriture ni audit", async () => {
    ok(await budget.createBudget(db, A, { worksiteId: "wA", plannedRevenueCents: BigInt(300_000), lines: lines({ MATERIALS: BigInt(50_000), SUBCONTRACTING: BigInt(120_000), EQUIPMENT: BigInt(40_000), LABOR: BigInt(30_000) }) }))
    const audits = await db.historyLog.count()
    assert.deepEqual(await budget.createBudget(db, A, { worksiteId: "wA", plannedRevenueCents: BigInt(1), lines: [] }), { ok: false, error: BUDGET_ERRORS.alreadyExists })
    assert.deepEqual(await budget.createBudget(db, A, { worksiteId: "wArch", plannedRevenueCents: BigInt(1), lines: [] }), { ok: false, error: BUDGET_ERRORS.archived })
    assert.deepEqual(await budget.createBudget(db, A, { worksiteId: "wB", plannedRevenueCents: BigInt(1), lines: [] }), { ok: false, error: BUDGET_ERRORS.notFound })
    assert.equal(await db.historyLog.count(), audits)
    const b = await db.worksiteBudget.findFirst({ where: { worksiteId: "wA" }, select: { currentRevision: true, revisions: { select: { number: true, kind: true, totalCostCents: true } } } })
    assert.deepEqual(b, { currentRevision: 1, revisions: [{ number: 1, kind: "INITIAL", totalCostCents: BigInt(240_000) }] })
  })
  it("révision 2 avec motif ; version 1 conservée telle quelle ; audit avant/après", async () => {
    const v1 = await db.worksiteBudgetRevision.findFirst({ where: { number: 1, budget: { worksiteId: "wA" } }, include: { lines: { orderBy: { nature: "asc" } } } })
    assert.deepEqual(ok(await budget.reviseBudget(db, A, { worksiteId: "wA", expectedRevision: 1, reason: "Avenant n° 1 : lot peinture", plannedRevenueCents: BigInt(350_000), lines: lines({ MATERIALS: BigInt(60_000), SUBCONTRACTING: BigInt(120_000), EQUIPMENT: BigInt(40_000), LABOR: BigInt(30_000), OTHER: BigInt(5_000) }) })), { revision: 2 })
    assert.deepEqual(await db.worksiteBudgetRevision.findFirst({ where: { number: 1, budget: { worksiteId: "wA" } }, include: { lines: { orderBy: { nature: "asc" } } } }), v1, "la version 1 n'est pas réécrite")
    const v2 = await db.worksiteBudgetRevision.findFirst({ where: { number: 2, budget: { worksiteId: "wA" } }, select: { kind: true, reason: true, totalCostCents: true, plannedRevenueCents: true } })
    assert.deepEqual(v2, { kind: "REVISED", reason: "Avenant n° 1 : lot peinture", totalCostCents: BigInt(255_000), plannedRevenueCents: BigInt(350_000) })
    const log = await db.historyLog.findFirst({ where: { entityType: "WorksiteBudget", action: "UPDATED" }, select: { worksiteId: true, actorId: true, oldValue: true, newValue: true } })
    assert.equal(log?.worksiteId, "wA")
    assert.equal((log?.oldValue as { revision: number }).revision, 1)
    assert.equal((log?.newValue as { revision: number }).revision, 2)
  })
  it("refus : version périmée, motif absent, révision identique", async () => {
    const same = { worksiteId: "wA", plannedRevenueCents: BigInt(350_000), lines: lines({ MATERIALS: BigInt(60_000), SUBCONTRACTING: BigInt(120_000), EQUIPMENT: BigInt(40_000), LABOR: BigInt(30_000), OTHER: BigInt(5_000) }) }
    assert.deepEqual(await budget.reviseBudget(db, A, { ...same, expectedRevision: 1, reason: "Motif valable" }), { ok: false, error: BUDGET_ERRORS.staleRevision })
    assert.deepEqual(await budget.reviseBudget(db, A, { ...same, expectedRevision: 2, reason: " " }), { ok: false, error: BUDGET_ERRORS.reason })
    assert.deepEqual(await budget.reviseBudget(db, A, { ...same, expectedRevision: -1, reason: "Motif valable" }), { ok: false, error: BUDGET_ERRORS.invalidForm })
    assert.deepEqual(await budget.reviseBudget(db, A, { ...same, expectedRevision: 2, reason: "Sans changement" }), { ok: false, error: BUDGET_ERRORS.unchanged })
  })
  it("concurrence : deux révisions depuis la même version ⇒ une seule réussit, l'autre « révisé entre-temps »", async () => {
    const mk = (rev: bigint) => budget.reviseBudget(db, A, { worksiteId: "wA", expectedRevision: 2, reason: "Révision concurrente", plannedRevenueCents: rev, lines: lines({ MATERIALS: BigInt(60_000), SUBCONTRACTING: BigInt(120_000), EQUIPMENT: BigInt(40_000), LABOR: BigInt(30_000), OTHER: BigInt(5_000) }) })
    const [r1, r2] = await Promise.all([mk(BigInt(360_000)), mk(BigInt(370_000))])
    assert.equal([r1, r2].filter((r) => r.ok).length, 1)
    assert.deepEqual([r1, r2].find((r) => !r.ok), { ok: false, error: BUDGET_ERRORS.staleRevision })
    assert.equal(await db.worksiteBudgetRevision.count({ where: { budget: { worksiteId: "wA" } } }), 3)
  })
  it("base : versions et lignes ni modifiables ni supprimables ; budget seulement +1 et jamais supprimé ; total incohérent refusé à la validation", async () => {
    const rev = (await db.worksiteBudgetRevision.findFirst({ where: { number: 1, budget: { worksiteId: "wA" } }, select: { id: true, budgetId: true } }))!
    await assert.rejects(db.$executeRawUnsafe(`UPDATE worksite_budget_revisions SET "plannedRevenueCents" = 1 WHERE id = '${rev.id}'`), /immutable/)
    await assert.rejects(db.$executeRawUnsafe(`DELETE FROM worksite_budget_revisions WHERE id = '${rev.id}'`), /immutable/)
    await assert.rejects(db.$executeRawUnsafe(`UPDATE worksite_budget_lines SET "amountCents" = 1 WHERE "revisionId" = '${rev.id}'`), /immutable/)
    await assert.rejects(db.$executeRawUnsafe(`DELETE FROM worksite_budget_lines WHERE "revisionId" = '${rev.id}'`), /immutable/)
    await assert.rejects(db.$executeRawUnsafe(`UPDATE worksite_budgets SET "currentRevision" = "currentRevision" + 2 WHERE id = '${rev.budgetId}'`), /only currentRevision \+ 1/)
    await assert.rejects(db.$executeRawUnsafe(`UPDATE worksite_budgets SET "worksiteId" = 'wA2', "currentRevision" = "currentRevision" + 1 WHERE id = '${rev.budgetId}'`), /only currentRevision \+ 1/)
    await assert.rejects(db.$executeRawUnsafe(`DELETE FROM worksite_budgets WHERE id = '${rev.budgetId}'`), /cannot be deleted/)
    await assert.rejects(db.$executeRawUnsafe(`TRUNCATE worksite_budget_lines`), /immutable/)
    // Version insérée hors service avec un total faux : refusée à la validation (déclencheur différé), rien n'est écrit.
    await refusDiffere(
      (tx) => tx.$executeRawUnsafe(`INSERT INTO worksite_budget_revisions(id,"companyId","budgetId",number,kind,reason,"plannedRevenueCents","totalCostCents","createdById") VALUES ('rx','coA','${rev.budgetId}',9,'REVISED','Injection',0,999,'uA')`),
      /total differs|not recorded/,
      async () => (await db.worksiteBudgetRevision.count({ where: { id: "rx" } })) === 0)
    // Version 1 « REVISED » ou révision sans motif : CHECK.
    await assert.rejects(db.$executeRawUnsafe(`INSERT INTO worksite_budget_revisions(id,"companyId","budgetId",number,kind,"plannedRevenueCents","totalCostCents","createdById") VALUES ('ry','coA','${rev.budgetId}',10,'REVISED',0,0,'uA')`), /worksite_budget_revisions_values_check/)
  })
  it("clés composites : une version ou une ligne ne peut pas désigner le budget d'une autre entreprise", async () => {
    const rev = (await db.worksiteBudgetRevision.findFirst({ where: { number: 1, budget: { worksiteId: "wA" } }, select: { id: true, budgetId: true } }))!
    await assert.rejects(db.$executeRawUnsafe(`INSERT INTO worksite_budget_lines(id,"companyId","revisionId",nature,"amountCents") VALUES ('lx','coB','${rev.id}','OTHER',1)`), /worksite_budget_lines_companyId_revisionId_fkey|foreign key|lines can only be added with their own revision/i)
    await assert.rejects(db.$executeRawUnsafe(`INSERT INTO worksite_budgets(id,"companyId","worksiteId","createdById","updatedAt") VALUES ('bx','coB','wA','uB',now())`), /worksite_budgets_worksiteId_companyId_fkey|foreign key/i)
  })
})

describe("revue v1 P1 : aucune ligne ajoutée à une version existante (base)", () => {
  it("version validée : ajout refusé, nature absente et montant nul compris, y compris dans une transaction explicite", async () => {
    const v1 = (await db.worksiteBudgetRevision.findFirst({ where: { number: 1, budget: { worksiteId: "wA" } }, select: { id: true, totalCostCents: true, lines: { select: { nature: true } } } }))!
    assert.ok(!v1.lines.some((l) => l.nature === "OTHER"), "la nature OTHER est absente de la version 1")
    for (const amount of [0, 1]) {
      await assert.rejects(db.$executeRawUnsafe(`INSERT INTO worksite_budget_lines(id,"companyId","revisionId",nature,"amountCents") VALUES ('lAdd${amount}','coA','${v1.id}','OTHER',${amount})`), /lines can only be added with their own revision/)
    }
    await assert.rejects(db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`INSERT INTO worksite_budget_lines(id,"companyId","revisionId",nature,"amountCents") VALUES ('lAddTx','coA','${v1.id}','OTHER',0)`)
    }), /lines can only be added with their own revision/)
    const after = (await db.worksiteBudgetRevision.findFirst({ where: { id: v1.id }, select: { totalCostCents: true, lines: { select: { nature: true } } } }))!
    assert.deepEqual(after, { totalCostCents: v1.totalCostCents, lines: v1.lines }, "version 1 inchangée")
  })
  it("concurrence : une version créée par une transaction encore ouverte refuse toute ligne d'une autre transaction ; sa création légitime (lignes en plusieurs instructions) est validée", async () => {
    let release!: () => void; const gate = new Promise<void>((r) => { release = r })
    let created!: () => void; const ready = new Promise<void>((r) => { created = r })
    const t1 = db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`INSERT INTO worksite_budgets(id,"companyId","worksiteId","createdById","updatedAt") VALUES ('bP1','coA','wA2','uA',now())`)
      await tx.$executeRawUnsafe(`UPDATE worksite_budgets SET "currentRevision" = 1 WHERE id = 'bP1'`)
      await tx.$executeRawUnsafe(`INSERT INTO worksite_budget_revisions(id,"companyId","budgetId",number,kind,"plannedRevenueCents","totalCostCents","createdById") VALUES ('rP1','coA','bP1',1,'INITIAL',0,700,'uA')`)
      await tx.$executeRawUnsafe(`INSERT INTO worksite_budget_lines(id,"companyId","revisionId",nature,"amountCents") VALUES ('lP1a','coA','rP1','MATERIALS',500)`)
      created()
      await gate
      await tx.$executeRawUnsafe(`INSERT INTO worksite_budget_lines(id,"companyId","revisionId",nature,"amountCents") VALUES ('lP1b','coA','rP1','OTHER',200)`)
    }, { timeout: 20_000 })
    await ready
    await assert.rejects(db.$executeRawUnsafe(`INSERT INTO worksite_budget_lines(id,"companyId","revisionId",nature,"amountCents") VALUES ('lP1x','coA','rP1','LABOR',0)`), /lines can only be added with their own revision/)
    release()
    await t1
    assert.deepEqual(await db.worksiteBudgetLine.findMany({ where: { revisionId: "rP1" }, orderBy: { nature: "asc" }, select: { nature: true, amountCents: true } }), [{ nature: "MATERIALS", amountCents: BigInt(500) }, { nature: "OTHER", amountCents: BigInt(200) }])
    await assert.rejects(db.$executeRawUnsafe(`INSERT INTO worksite_budget_lines(id,"companyId","revisionId",nature,"amountCents") VALUES ('lP1y','coA','rP1','LABOR',0)`), /lines can only be added with their own revision/, "après validation, montant nul")
    await assert.rejects(db.$executeRawUnsafe(`INSERT INTO worksite_budget_lines(id,"companyId","revisionId",nature,"amountCents") VALUES ('lP1z','coA','rP1','LABOR',1)`), /lines can only be added with their own revision/, "après validation, montant positif")
  })
  it("C-R1 : currentRevision + 1 sans version correspondante refusé (instruction seule ou transaction) ; budget inséré avec une version courante fictive refusé", async () => {
    const b = (await db.worksiteBudget.findFirst({ where: { worksiteId: "wA" }, select: { id: true, currentRevision: true } }))!
    await assert.rejects(db.$executeRawUnsafe(`UPDATE worksite_budgets SET "currentRevision" = "currentRevision" + 1 WHERE id = '${b.id}'`), /current revision has no matching revision/)
    await refusDiffere(
      (tx) => tx.$executeRawUnsafe(`UPDATE worksite_budgets SET "currentRevision" = "currentRevision" + 1 WHERE id = '${b.id}'`),
      /current revision has no matching revision/,
      async () => (await db.worksiteBudget.findFirst({ where: { id: b.id }, select: { currentRevision: true } }))!.currentRevision === b.currentRevision)
    assert.equal((await db.worksiteBudget.findFirst({ where: { id: b.id }, select: { currentRevision: true } }))!.currentRevision, b.currentRevision, "version courante inchangée")
    await assert.rejects(db.$executeRawUnsafe(`INSERT INTO worksite_budgets(id,"companyId","worksiteId","currentRevision","createdById","updatedAt") VALUES ('bFict','coA','wArch',2,'uA',now())`), /current revision has no matching revision/)
    assert.equal(await db.worksiteBudget.count({ where: { id: "bFict" } }), 0)
  })
})

describe("coûts réels et engagés construits par les services des lots A et B", () => {
  it("commande du chantier (article + prestation), réception partielle, sortie de stock, entrée manuelle signalée", async () => {
    const wh = ok(await stock.createWarehouse(db, A, { name: "Dépôt central" })).id
    const po = ok(await stock.createPurchaseOrder(db, A, { supplierId: "supA", warehouseId: wh, worksiteId: "wA", lines: [
      { articleId: "artA", designation: "Ciment 25 kg", quantityMilli: 10_000, unitPriceCents: 1_200 },
      { designation: "Pose", quantityMilli: 2_000, unitPriceCents: 30_000 },
    ] })).id
    ok(await stock.markOrdered(db, A, po, NOW))
    const ol = await db.purchaseOrderLine.findMany({ where: { purchaseOrderId: po }, orderBy: { position: "asc" }, select: { id: true } })
    ok(await stock.receiveGoods(db, A, po, { lines: [{ orderLineId: ol[0].id, quantityMilli: 4_000 }, { orderLineId: ol[1].id, quantityMilli: 1_000 }], supplierInvoiceId: "siLinked" }))
    ok(await stock.recordMovement(db, A, { type: "ISSUE", articleId: "artA", quantityMilli: 2_500, fromWarehouseId: wh, worksiteId: "wA" }))
    ok(await stock.recordMovement(db, A, { type: "RECEIPT", articleId: "artA", quantityMilli: 500, toWarehouseId: wh, worksiteId: "wA" }))
    const m = await margin()
    const mat = m.natures.find((r) => r.nature === "MATERIALS")!
    // Réel : prestation reçue 1 × 300,00 + sortie 2,5 × 12,00 = 30 000 + 3 000 ; engagé : prestation 1 × 300,00 + ciment 6 × 12,00.
    assert.equal(mat.actualCents, BigInt(33_000))
    assert.equal(mat.committedCents, BigInt(30_000) + BigInt(7_200))
    // BUD-01 : cumul HISTORIQUE des réceptions d'articles (4 u × 12,00), inchangé après la sortie de 2,5 u — pas un solde.
    assert.equal(m.receivedArticlesCumulativeCents, BigInt(4_800), "cumul des réceptions : sortie non déduite, jamais additionné au réel")
    assert.deepEqual(m.anomalies.filter((a) => a.code === "OTHER_MOVEMENTS").map((a) => a.count), [1])
  })
  it("location clôturée (réel), location en cours (engagé), matériel propre rendu (réel)", async () => {
    const rented = ok(await equipment.createEquipment(db, A, { number: "NAC-1", name: "Nacelle", category: "Élévation", ownership: "RENTED" })).id
    const c1 = ok(await equipment.createRentalContract(db, A, { equipmentId: rented, supplierId: "supA", worksiteId: "wA", startDate: d("2026-10-01"), endDate: d("2026-10-05"), dailyRateCents: 10_000, fixedFeesCents: 2_000 })).id
    assert.deepEqual(ok(await equipment.closeRentalContract(db, A, c1, d("2026-10-03"), NOW)), { costCents: BigInt(32_000) })
    ok(await equipment.createRentalContract(db, A, { equipmentId: rented, supplierId: "supA", worksiteId: "wA", startDate: d("2026-11-10"), endDate: d("2026-11-12"), dailyRateCents: 5_000 }))
    const owned = ok(await equipment.createEquipment(db, A, { number: "BET-1", name: "Bétonnière", category: "Gros œuvre", ownership: "OWNED", dailyCostCents: 2_500 })).id
    const bk = ok(await equipment.createBooking(db, A, { equipmentId: owned, firstDay: d("2026-11-04"), lastDay: d("2026-11-05"), worksiteId: "wA" }, NOW)).id
    ok(await equipment.checkoutBooking(db, A, bk, "GOOD", NOW))
    ok(await equipment.returnBooking(db, A, bk, { condition: "GOOD" }, BACK))
    const eq = await row("EQUIPMENT")
    assert.equal(eq.actualCents, BigInt(32_000) + BigInt(5_000), "31 h ⇒ 2 jours entamés × 25,00")
    assert.equal(eq.committedCents, BigInt(15_000))
  })
})

describe("revue 04db : catalogue événementiel (PR #128) — matériel créé à la réception sans coût journalier", () => {
  // Chemin RÉEL de la production 3de49237 : réception d'un article du catalogue suivi à l'unité ⇒ fiches Matériel OWNED créées
  // par afterGoodsReceipt, SANS coût journalier ; stock recalculé par un inventaire tracé (sans chantier). Utilisées sur un
  // chantier, elles ne doivent ni disparaître silencieusement du réel, ni recevoir une valorisation inventée : alerte explicite.
  const drapeaux = { STOCK_PURCHASING_ENABLED: process.env.STOCK_PURCHASING_ENABLED, EQUIPMENT_RENTAL_ENABLED: process.env.EQUIPMENT_RENTAL_ENABLED }
  before(() => { process.env.STOCK_PURCHASING_ENABLED = "true"; process.env.EQUIPMENT_RENTAL_ENABLED = "true" }) // base jetable uniquement
  after(() => { for (const [k, v] of Object.entries(drapeaux)) { if (v === undefined) delete process.env[k]; else process.env[k] = v } })
  const margeA2 = async () => (await getWorksiteBudget(db, "coA", "wA2"))!.margin

  it("fiches auto-créées sorties et rendue (synchronisation réelle PR #128) : réel inchangé, alerte ; coût renseigné : alerte levée, coût compté une fois", async () => {
    const item = EVENT_STOCK_ARTICLES.find((a) => a.tracked)!
    assert.ok(item, "le catalogue contient un article suivi à l'unité")
    const wh = ok(await stock.createWarehouse(db, A, { name: "Dépôt catalogue" })).id
    const articleId = await stock.ensureEventArticle(db, A, item)
    const po = ok(await stock.createPurchaseOrder(db, A, { supplierId: "supA", warehouseId: wh, worksiteId: "wA2", lines: [
      { articleId, designation: item.designation, quantityMilli: 2_000, unitPriceCents: 45_000 },
    ] })).id
    ok(await stock.markOrdered(db, A, po, NOW))
    const [ol] = await db.purchaseOrderLine.findMany({ where: { purchaseOrderId: po }, select: { id: true } })
    const rc = ok(await stock.receiveGoods(db, A, po, { lines: [{ orderLineId: ol.id, quantityMilli: 2_000 }] }))
    assert.equal(await afterGoodsReceipt(db, A, rc.id), 2, "PR #128 : une fiche Matériel par unité reçue")
    const fiches = await db.equipment.findMany({ where: { companyId: "coA", name: item.designation }, select: { id: true, ownership: true, dailyCostCents: true }, orderBy: { number: "asc" } })
    assert.deepEqual(fiches.map((f) => [f.ownership, f.dailyCostCents]), [["OWNED", null], ["OWNED", null]], "fiches propres SANS coût journalier")
    assert.equal(await db.stockMovement.count({ where: { companyId: "coA", articleId, worksiteId: { not: null }, NOT: { type: "RECEIPT" } } }), 0,
      "aucun mouvement de l'article catalogue, hors réception de la commande, ne porte de chantier (inventaires de synchronisation sans chantier)")

    const avant = await margeA2()
    assert.deepEqual(avant.anomalies.filter((a) => a.code === "EQUIPMENT_COST_MISSING"), [], "avant toute utilisation : aucune alerte")
    // Fiche 1 : réservée, sortie puis rendue sur A2. Fiche 2 : réservée et sortie (en cours). Une réservation seulement réservée
    // (non sortie) n'est pas une utilisation : elle n'est pas comptée.
    const b1 = ok(await equipment.createBooking(db, A, { equipmentId: fiches[0].id, firstDay: d("2026-11-04"), lastDay: d("2026-11-05"), worksiteId: "wA2" }, NOW)).id
    // Après chaque sortie et retour : la synchronisation Matériel → Stock que les actions de la PR #128 appellent (inchangée).
    const ajustements = () => db.stockMovement.findMany({ where: { companyId: "coA", articleId, type: "ADJUSTMENT" }, select: { worksiteId: true, quantityMilli: true } })
    assert.equal((await ajustements()).length, 0, "après la réception : stock = nombre de fiches, aucun ajustement")
    ok(await equipment.checkoutBooking(db, A, b1, "GOOD", NOW))
    await afterEquipmentChange(db, A, fiches[0].id, "sorti")
    ok(await equipment.returnBooking(db, A, b1, { condition: "GOOD" }, BACK))
    await afterEquipmentChange(db, A, fiches[0].id, "rentré")
    const b2 = ok(await equipment.createBooking(db, A, { equipmentId: fiches[1].id, firstDay: d("2026-11-04"), lastDay: d("2026-11-06"), worksiteId: "wA2" }, NOW)).id
    ok(await equipment.checkoutBooking(db, A, b2, "GOOD", NOW))
    await afterEquipmentChange(db, A, fiches[1].id, "sorti")
    const adj = await ajustements()
    assert.equal(adj.length, 3, "sortie, retour, sortie : trois inventaires tracés de synchronisation")
    assert.ok(adj.every((m) => m.worksiteId === null), "ADJUSTMENT de synchronisation SANS chantier")
    assert.equal((await db.stockLevel.findFirst({ where: { companyId: "coA", warehouseId: wh, articleId }, select: { quantityMilli: true } }))!.quantityMilli, 1_000, "stock du dépôt = fiches présentes (1 sortie)")
    ok(await equipment.createBooking(db, A, { equipmentId: fiches[0].id, firstDay: d("2026-11-20"), lastDay: d("2026-11-21"), worksiteId: "wA2" }, NOW))

    const apres = await margeA2()
    const eq = (m: typeof apres) => m.natures.find((r) => r.nature === "EQUIPMENT")!
    assert.equal(eq(apres).actualCents, eq(avant).actualCents, "aucune valorisation inventée pour le matériel sans coût")
    assert.equal(apres.actualCents, avant.actualCents)
    assert.equal(apres.currentMarginCents, avant.currentMarginCents)
    const alerte = apres.anomalies.find((a) => a.code === "EQUIPMENT_COST_MISSING")
    assert.ok(alerte, "alerte explicite : coût matériel manquant, marge incomplète")
    assert.equal(alerte!.count, 2, "sortie en cours + rendue ; la réservation non sortie n'est pas comptée")
    assert.match(alerte!.message, /^Marge incomplète : 2 réservation/)
    assert.deepEqual(apres.anomalies.filter((a) => a.code === "OTHER_MOVEMENTS"), avant.anomalies.filter((a) => a.code === "OTHER_MOVEMENTS"), "inventaires de synchronisation sans chantier : non signalés comme mouvements du chantier")
    // Liste consolidée et autre société : l'alerte suit le chantier, jamais une autre entreprise.
    const liste = await listWorksiteMargins(db, "coA", {})
    assert.ok(liste.rows.find((r) => r.worksiteId === "wA2")!.anomalies.some((a) => a.code === "EQUIPMENT_COST_MISSING"))
    assert.ok(!(await listWorksiteMargins(db, "coB", {})).rows.some((r) => r.anomalies.some((a) => a.code === "EQUIPMENT_COST_MISSING")))

    // Coût journalier renseigné sur les deux fiches (service Matériel inchangé, puis synchronisation comme l'action) :
    // l'alerte disparaît ; seule la réservation RENDUE entre au réel (règle du lot C), une seule fois ; la sortie en cours
    // n'est ni comptée ni signalée ; les inventaires de synchronisation n'ajoutent rien.
    for (const f of fiches) {
      const cur = (await db.equipment.findFirst({ where: { id: f.id }, select: { name: true, category: true, warehouseId: true } }))!
      ok(await equipment.updateEquipment(db, A, f.id, { name: cur.name, category: cur.category, warehouseId: cur.warehouseId, dailyCostCents: 3_000 }))
      await afterEquipmentChange(db, A, f.id, "fiche modifiée", { name: cur.name, category: cur.category })
    }
    const renseigne = await margeA2()
    assert.deepEqual(renseigne.anomalies.filter((a) => a.code === "EQUIPMENT_COST_MISSING"), [], "coût renseigné : alerte levée")
    assert.equal(eq(renseigne).actualCents, eq(avant).actualCents + BigInt(6_000), "réservation rendue : 31 h ⇒ 2 jours × 30,00, comptée UNE fois")
    assert.equal(renseigne.actualCents, avant.actualCents + BigInt(6_000))
    assert.equal(eq(renseigne).committedCents, eq(avant).committedCents, "sortie en cours : ni réel ni engagé")
    assert.equal((await ajustements()).length, 3, "renseigner le coût ne crée aucun nouvel ajustement")
    assert.deepEqual(renseigne.anomalies.filter((a) => a.code === "OTHER_MOVEMENTS"), avant.anomalies.filter((a) => a.code === "OTHER_MOVEMENTS"))
  })
})

describe("imputations de factures fournisseurs", () => {
  it("validée = réel, en attente = engagé ; jusqu'au montant HT exact, au-delà refusé", async () => {
    ok(await budget.allocateSupplierInvoice(db, A, { supplierInvoiceId: "siSub", worksiteId: "wA", nature: "SUBCONTRACTING", amountHTCents: BigInt(60_000) }))
    assert.deepEqual(await budget.allocateSupplierInvoice(db, A, { supplierInvoiceId: "siSub", worksiteId: "wA2", nature: "OTHER", amountHTCents: BigInt(40_001) }), { ok: false, error: BUDGET_ERRORS.allocationExceeds })
    ok(await budget.allocateSupplierInvoice(db, A, { supplierInvoiceId: "siSub", worksiteId: "wA2", nature: "OTHER", amountHTCents: BigInt(40_000), label: "Part du chantier A2" }))
    ok(await budget.allocateSupplierInvoice(db, A, { supplierInvoiceId: "siPend", worksiteId: "wA", nature: "SUBCONTRACTING", amountHTCents: BigInt(50_000) }))
    const sub = await row("SUBCONTRACTING")
    assert.equal(sub.actualCents, BigInt(60_000))
    assert.equal(sub.committedCents, BigInt(50_000))
    assert.ok(!(await listAllocatableInvoices(db, "coA")).some((i) => i.id === "siSub"), "facture entièrement imputée : plus proposée")
  })
  it("refus : facture déjà comptée par une réception, refusée, d'une autre entreprise, chantier d'une autre entreprise ; chantier archivé admis", async () => {
    const audits = await db.historyLog.count()
    assert.deepEqual(await budget.allocateSupplierInvoice(db, A, { supplierInvoiceId: "siLinked", worksiteId: "wA", nature: "MATERIALS", amountHTCents: BigInt(1) }), { ok: false, error: BUDGET_ERRORS.allocationLinked })
    assert.deepEqual(await budget.allocateSupplierInvoice(db, A, { supplierInvoiceId: "siRej", worksiteId: "wA", nature: "OTHER", amountHTCents: BigInt(1) }), { ok: false, error: BUDGET_ERRORS.allocationRejected })
    assert.deepEqual(await budget.allocateSupplierInvoice(db, A, { supplierInvoiceId: "siB", worksiteId: "wA", nature: "OTHER", amountHTCents: BigInt(1) }), { ok: false, error: BUDGET_ERRORS.notFound })
    assert.deepEqual(await budget.allocateSupplierInvoice(db, A, { supplierInvoiceId: "siPend", worksiteId: "wB", nature: "OTHER", amountHTCents: BigInt(1) }), { ok: false, error: BUDGET_ERRORS.notFound })
    assert.deepEqual(await budget.allocateSupplierInvoice(db, B, { supplierInvoiceId: "siPend", worksiteId: "wB", nature: "OTHER", amountHTCents: BigInt(1) }), { ok: false, error: BUDGET_ERRORS.notFound })
    assert.equal(await db.historyLog.count(), audits, "aucun audit d'une écriture refusée")
    const ids = (await listAllocatableInvoices(db, "coA")).map((i) => i.id)
    assert.ok(!ids.includes("siLinked") && !ids.includes("siRej") && !ids.includes("siB"))
  })
  it("concurrence : deux imputations dont la somme dépasse le reste ⇒ une seule réussit", async () => {
    await db.$executeRawUnsafe(`INSERT INTO supplier_invoices(id,"companyId","supplierId","supplierName",number,date,"totalHTCents","vatCents","totalTTCCents",status,"createdById","updatedAt") VALUES ('siCc','coA','supA','Fournisseur A','F-CC','2026-10-24',1000,200,1200,'VALIDATED','uA',now())`)
    const [r1, r2] = await Promise.all([
      budget.allocateSupplierInvoice(db, A, { supplierInvoiceId: "siCc", worksiteId: "wA2", nature: "OTHER", amountHTCents: BigInt(700) }),
      budget.allocateSupplierInvoice(db, A, { supplierInvoiceId: "siCc", worksiteId: "wA2", nature: "OTHER", amountHTCents: BigInt(700) }),
    ])
    assert.equal([r1, r2].filter((r) => r.ok).length, 1)
    assert.deepEqual([r1, r2].find((r) => !r.ok), { ok: false, error: BUDGET_ERRORS.allocationExceeds })
  })
  it("annulation : une seule fois, ligne conservée, montant libéré ; jamais supprimée ni réécrite en base", async () => {
    const a = (await db.supplierInvoiceAllocation.findFirst({ where: { supplierInvoiceId: "siCc", cancelledAt: null }, select: { id: true } }))!
    assert.deepEqual(await budget.cancelAllocation(db, B, a.id, "wA2"), { ok: false, error: BUDGET_ERRORS.notFound }, "autre entreprise")
    assert.deepEqual(await budget.cancelAllocation(db, A, a.id, "wA"), { ok: false, error: BUDGET_ERRORS.notFound }, "imputation d'un autre chantier")
    assert.deepEqual(ok(await budget.cancelAllocation(db, A, a.id, "wA2")), { worksiteId: "wA2" })
    assert.deepEqual(await budget.cancelAllocation(db, A, a.id, "wA2"), { ok: false, error: BUDGET_ERRORS.allocationCancelled })
    assert.ok((await listAllocatableInvoices(db, "coA")).some((i) => i.id === "siCc" && i.remainingHTCents === BigInt(1_000)))
    await assert.rejects(db.$executeRawUnsafe(`DELETE FROM supplier_invoice_allocations WHERE id = '${a.id}'`), /cannot be deleted/)
    await assert.rejects(db.$executeRawUnsafe(`UPDATE supplier_invoice_allocations SET "cancelledAt" = NULL, "cancelledById" = NULL WHERE id = '${a.id}'`), /single cancellation/)
    await assert.rejects(db.$executeRawUnsafe(`UPDATE supplier_invoice_allocations SET "amountHTCents" = 1 WHERE "supplierInvoiceId" = 'siPend'`), /single cancellation/)
    assert.equal(await db.historyLog.count({ where: { entityType: "SupplierInvoiceAllocation", entityId: a.id } }), 2, "création et annulation auditées")
  })
})

describe("marge consolidée et isolation", () => {
  it("chantier A au centime : prévu (version courante), engagé, réel, devis signés, facturé (brouillon exclu)", async () => {
    const m = await margin()
    const current = (await db.worksiteBudget.findFirst({ where: { worksiteId: "wA" }, select: { currentRevision: true } }))!.currentRevision
    assert.equal(m.budgetRevision, current)
    assert.equal(m.plannedCostCents, BigInt(255_000))
    assert.equal(m.actualCents, BigInt(33_000) + BigInt(37_000) + BigInt(60_000))
    assert.equal(m.committedCents, BigInt(37_200) + BigInt(15_000) + BigInt(50_000))
    assert.equal(m.signedQuotesHTCents, BigInt(200_000))
    assert.equal(m.invoicedHTCents, BigInt(0), "facture brouillon non émise : non comptée")
    assert.equal(m.currentMarginCents, -BigInt(130_000))
    assert.ok(m.anomalies.some((a) => a.code === "LABOR_NOT_COMPUTED"))
  })
  it("liste de l'entreprise A : chantiers A seulement (archivé sur demande) ; l'entreprise B ne voit rien de A", async () => {
    const a = await listWorksiteMargins(db, "coA")
    assert.deepEqual(a.rows.map((r) => r.worksiteId).sort(), ["wA", "wA2"])
    // A2 : imputation « autres frais » 400,00 + matériel du catalogue (scénario revue 04db, bloc précédent) rendu sur A2 puis coût
    // journalier renseigné : 31 h ⇒ 2 jours × 30,00 = 60,00, compté une fois (preuve c2-r1 : 46 000 ; oracle explicite).
    assert.equal(a.rows.find((r) => r.worksiteId === "wA2")!.actualCents, BigInt(40_000) + BigInt(6_000), "imputation « autres frais » sur A2 (400,00) + matériel catalogue rendu, coût renseigné (60,00)")
    assert.ok((await listWorksiteMargins(db, "coA", { includeArchived: true })).rows.some((r) => r.worksiteId === "wArch"))
    const b = await listWorksiteMargins(db, "coB")
    assert.deepEqual(b.rows.map((r) => r.worksiteId), ["wB"])
    assert.equal(b.rows[0].actualCents, BigInt(0))
    assert.equal(await getWorksiteBudget(db, "coB", "wA"), null, "identifiant forgé d'une autre entreprise")
  })
})

describe("intégration 35c0 : recettes émises réelles, frais de véhicules, concurrence entre chantiers, isolation (société coF)", () => {
  const F = { companyId: "coF", userId: "admF" }
  const FNOW = new Date("2026-11-06T10:00:00Z")
  const val = <T>(r: { ok: true; value: T } | { ok: false; error: string }): T => { assert.ok(r.ok, r.ok ? "" : r.error); return (r as { ok: true; value: T }).value }
  const marginF = async () => (await getWorksiteBudget(db, "coF", "wF"))!.margin
  before(async () => {
    setBillingClockForTests(() => FNOW)
    setBillingMailerForTests(new RecordingMailer()) // aucun envoi réel
    process.env.PLANIFICATOR_VEHICLES_V3_ENABLED = "true" // drapeau de test des véhicules V3, base jetable uniquement
    for (const sqlText of [
      `INSERT INTO companies(id,name,slug,siret,address,"updatedAt") VALUES ('coF','Société F','f','12345678900099','9 rue F',now())`,
      `INSERT INTO users(id,email,password,role,"companyId","updatedAt") VALUES ('admF','f@x.test','x','ADMIN','coF',now())`,
      `INSERT INTO clients(id,"companyId",name,email,address,"updatedAt") VALUES ('clF','coF','Client F','client-f@example.test','19 rue F',now())`,
      `INSERT INTO worksites(id,"companyId","clientId","createdById",name,"updatedAt") VALUES ('wF','coF','clF','admF','Chantier F',now()),('wF2','coF','clF','admF','Chantier F2',now()),('wF3','coF','clF','admF','Chantier F3',now()),('wF4','coF','clF','admF','Chantier F4',now())`,
      `INSERT INTO suppliers(id,"companyId",name,"updatedAt") VALUES ('supF','coF','Fournisseur F',now())`,
      `INSERT INTO supplier_invoices(id,"companyId","supplierId","supplierName",number,date,"totalHTCents","vatCents","totalTTCCents",status,"createdById","updatedAt") VALUES ('siX','coF','supF','Fournisseur F','F-X','2026-10-25',1000,200,1200,'VALIDATED','admF',now()),
        ('siR','coF','supF','Fournisseur F','F-R','2026-10-26',10000,2000,12000,'VALIDATED','admF',now())`,
    ]) await db.$executeRawUnsafe(sqlText)
    ok(await budget.createBudget(db, F, { worksiteId: "wF", plannedRevenueCents: BigInt(100_000), lines: lines({ VEHICLES: BigInt(10_000), OTHER: BigInt(5_000) }) }))
  })
  after(() => { setBillingMailerForTests(null); delete process.env.PLANIFICATOR_VEHICLES_V3_ENABLED })

  it("oracle Finance : devis 1 000 HT, acompte 300 émis, facture de solde NETTE 700 (déduction réelle) ⇒ facturé 1 000 et non 1 300 ; avoir 100 ⇒ 900 ; brouillon exclu", async () => {
    const q = parseQuoteForm({ worksiteId: "wF", issueDate: "2026-11-06", lines: [{ designation: "Gros œuvre", quantity: "1", unitPrice: "1000", vatRate: "20" }] })
    if (!q.ok) throw new Error(q.error)
    const quoteId = val(await createQuote(db, F, q.value)).id
    await sendQuote(db, F, quoteId, FNOW); await acceptQuoteManually(db, F, quoteId, FNOW)
    // Acompte 30 % du devis (1 200 TTC à 20 %) ⇒ 300,00 HT, émis.
    const dep = val(await createDepositInvoice(db, F, quoteId, { kind: "PERCENT", bp: 3000 }, FNOW)).id
    val(await issueInvoice(db, F, dep, FNOW))
    // Facture de solde issue du devis, acompte déduit par le service réel (applyDepositDeductions ⇒ applyDepositDeductionsCore), émise.
    const finalId = val(await convertQuote(db, F, quoteId, FNOW)).invoiceId
    assert.equal(val(await applyDepositDeductions(db, F, finalId)).deposits, 1)
    // Liaison réelle (revue C-R2) : une déduction enregistrée vers CET acompte, et ses lignes négatives sur la facture de solde.
    assert.deepEqual((await db.invoiceDepositDeduction.findMany({ where: { companyId: "coF", finalInvoiceId: finalId }, select: { depositInvoiceId: true } })).map((x) => x.depositInvoiceId), [dep])
    const deductionLines = await db.invoiceLine.findMany({ where: { invoiceId: finalId, deductsDepositId: dep }, select: { lineHT: true } })
    assert.ok(deductionLines.length >= 1 && deductionLines.every((l) => Number(l.lineHT) < 0), "lignes de déduction négatives présentes")
    assert.equal(deductionLines.reduce((t, l) => t + Math.round(Number(l.lineHT) * 100), 0), -30_000, "déduction totale = acompte 300,00 HT")
    val(await issueInvoice(db, F, finalId, FNOW))
    const fin = await db.invoice.findUniqueOrThrow({ where: { id: finalId }, select: { kind: true, totalHT: true, sentAt: true } })
    assert.equal(fin.kind, "INVOICE"); assert.ok(fin.sentAt)
    assert.equal(fin.totalHT.toFixed(2), "700.00", "facture de solde NETTE de l'acompte")
    let m = await marginF()
    assert.equal(m.invoicedHTCents, BigInt(100_000), "acompte 300 + solde net 700 = 1 000, jamais 1 300")
    assert.equal(m.signedQuotesHTCents, BigInt(100_000), "devis converti = signé")
    // Avoir partiel de 100,00 HT émis sur la facture de solde ⇒ 900.
    val(await createPartialCreditNote(db, F, finalId, { kind: "AMOUNT_HT", cents: BigInt(10_000) }, "Remise commerciale", FNOW))
    // Brouillon indépendant 70,00 HT jamais émis : exclu.
    const draft = parseInvoiceForm({ worksiteId: "wF", lines: [{ designation: "Option", quantity: "1", unitPrice: "70", vatRate: "20" }] })
    if (!draft.ok) throw new Error(draft.error)
    val(await createDraftInvoice(db, F, draft.value, FNOW))
    const kinds = await db.invoice.findMany({ where: { companyId: "coF", worksiteId: "wF" }, select: { kind: true, sentAt: true, totalHT: true } })
    assert.deepEqual(kinds.map((k) => `${k.kind}:${k.sentAt ? "émise" : "brouillon"}:${k.totalHT.toFixed(2)}`).sort(),
      ["CREDIT_NOTE:émise:100.00", "DEPOSIT:émise:300.00", "INVOICE:brouillon:70.00", "INVOICE:émise:700.00"])
    m = await marginF()
    assert.equal(m.invoicedHTCents, BigInt(90_000), "1 000 − avoir 100 = 900 ; brouillon exclu")
    assert.equal(m.toInvoiceCents, BigInt(10_000), "reste à facturer = max(recette prévue 1 000, devis signés 1 000) − 900")
  })
  it("annulation Finance : facture émise puis AVOIR TOTAL (origine CANCELLED, date d'émission conservée) ⇒ comptées ensemble, contribution nette nulle ; jamais l'avoir seul", async () => {
    const x = parseInvoiceForm({ worksiteId: "wF", lines: [{ designation: "Travaux annexes", quantity: "1", unitPrice: "200", vatRate: "20" }] })
    if (!x.ok) throw new Error(x.error)
    const xId = val(await createDraftInvoice(db, F, x.value, FNOW)).id
    val(await issueInvoice(db, F, xId, FNOW))
    assert.equal((await marginF()).invoicedHTCents, BigInt(90_000) + BigInt(20_000), "facture émise comptée")
    const note = await db.$transaction(async (tx) => {
      const r = await createCreditNoteCore(tx, { companyId: "coF", invoiceId: xId, actorId: "admF", reason: "Erreur de facturation", now: FNOW, nextNumber: (t) => nextDocumentNumber(t, "coF", "CREDIT_NOTE", 2026) })
      await flushDeferredConstraints(tx)
      return r
    })
    assert.ok(note.ok, note.ok ? "" : note.error)
    const origine = await db.invoice.findUniqueOrThrow({ where: { id: xId }, select: { status: true, sentAt: true, totalHT: true } })
    assert.equal(origine.status, "CANCELLED"); assert.ok(origine.sentAt, "l'origine contrepassée garde sa date d'émission")
    const avoir = await db.invoice.findFirstOrThrow({ where: { companyId: "coF", creditedInvoiceId: xId, kind: "CREDIT_NOTE" }, select: { status: true, sentAt: true, totalHT: true } })
    assert.ok(avoir.sentAt); assert.equal(avoir.totalHT.toFixed(2), origine.totalHT.toFixed(2))
    assert.equal((await marginF()).invoicedHTCents, BigInt(90_000), "+200 − 200 : facture annulée et son avoir comptés ensemble")
  })
  it("une commande, sa réception et sa facture fournisseur liée (100,00) : engagé à la commande, réel à la réception, JAMAIS deux fois", async () => {
    const wh = ok(await stock.createWarehouse(db, F, { name: "Dépôt F" })).id
    const po = ok(await stock.createPurchaseOrder(db, F, { supplierId: "supF", warehouseId: wh, worksiteId: "wF4", lines: [{ designation: "Prestation", quantityMilli: 1_000, unitPriceCents: 10_000 }] })).id
    ok(await stock.markOrdered(db, F, po, FNOW))
    const site = async () => (await getWorksiteBudget(db, "coF", "wF4"))!.margin
    let m = await site()
    assert.deepEqual([m.committedCents, m.actualCents], [BigInt(10_000), BigInt(0)], "commandée : engagé seulement")
    const ol = (await db.purchaseOrderLine.findFirstOrThrow({ where: { purchaseOrderId: po }, select: { id: true } })).id
    ok(await stock.receiveGoods(db, F, po, { lines: [{ orderLineId: ol, quantityMilli: 1_000 }], supplierInvoiceId: "siR" }))
    m = await site()
    assert.deepEqual([m.committedCents, m.actualCents], [BigInt(0), BigInt(10_000)], "reçue : réel, l'engagé est soldé")
    assert.deepEqual(await budget.allocateSupplierInvoice(db, F, { supplierInvoiceId: "siR", worksiteId: "wF4", nature: "MATERIALS", amountHTCents: BigInt(10_000) }), { ok: false, error: BUDGET_ERRORS.allocationLinked }, "facture déjà comptée par la réception")
    m = await site()
    assert.deepEqual([m.committedCents, m.actualCents], [BigInt(0), BigInt(10_000)], "la facture liée n'ajoute rien")
    assert.ok(!(await listAllocatableInvoices(db, "coF")).some((i) => i.id === "siR"))
  })
  it("frais de véhicules : trajet rattaché au chantier, frais approuvé imputé compté au réel ; frais en attente exclu et signalé", async () => {
    const truck = await db.truck.create({ data: { companyId: "coF", matricule: `TF-${randomUUID()}` } })
    const deps = { db, auth: async () => ({ user: { id: "admF", role: "ADMIN", companyId: "coF" } }) }
    const mileage = (type: "READING" | "START" | "END", body: unknown) => executeMileageCommand(truck.id, type, body, randomUUID(), deps)
    await mileage("READING", { mileage: 1000, expectedRevision: 0, occurredAt: "2026-11-02T07:00:00Z" })
    const started = await mileage("START", { mileage: 1000, expectedRevision: 1, occurredAt: "2026-11-03T07:00:00Z", worksiteId: "wF" })
    await mileage("END", { mileage: 1080, expectedRevision: 2, occurredAt: "2026-11-03T17:00:00Z", tripId: started.receipt.tripId })
    const run = async (body: unknown) => (await executeExpenseCommand(truck.id, body, randomUUID(), deps)).expense as unknown as { id: string; revision: number; status: string }
    const data = { category: "OTHER", occurredAt: "2026-11-03T12:00:00Z", amount: "45.00", currency: "EUR", litres: null, mileageObservation: 1040 }
    let approved = await run({ action: "CREATE", data })
    approved = await run({ action: "APPROVE", expenseId: approved.id, expectedRevision: approved.revision, reason: "Justificatif contrôlé" })
    await run({ action: "ALLOCATE", expenseId: approved.id, expectedRevision: approved.revision, reason: "Trajet du chantier F", allocations: [{ amount: "45.00", mileageTripId: started.receipt.tripId }] })
    const pending = await run({ action: "CREATE", data: { ...data, amount: "12.00", mileageObservation: 1050 } })
    await run({ action: "ALLOCATE", expenseId: pending.id, expectedRevision: pending.revision, reason: "Trajet du chantier F", allocations: [{ amount: "12.00", mileageTripId: started.receipt.tripId }] })
    const m = await marginF()
    const veh = m.natures.find((r) => r.nature === "VEHICLES")!
    assert.equal(veh.actualCents, BigInt(4_500), "seul le frais APPROUVÉ en EUR est compté")
    assert.deepEqual(m.anomalies.filter((a) => a.code === "VEHICLE_EXCLUDED").map((a) => a.count), [1])
    assert.equal(m.actualCents, BigInt(4_500))
    assert.equal(m.currentMarginCents, BigInt(90_000) - BigInt(4_500), "marge à date = facturé − réel, au centime")
  })
  it("concurrence entre chantiers (barrière déterministe) : deux imputations de la même facture sur DEUX chantiers, réellement en attente du même verrou, dont la somme dépasse le HT ⇒ une seule réussit", async () => {
    // Barrière : une transaction témoin tient le verrou de la facture ; les deux imputations l'attendent, ce qui est constaté
    // AVANT de lever la barrière. Correctif c1-v7 : pg_stat_activity est figée dans une transaction (cliché au premier accès) ;
    // chaque observation commence donc par pg_stat_clear_snapshot(). Preuve : PID de la témoin (détenteur du verrou), puis
    // pg_blocking_pids (calculée en direct) : DEUX sessions bloquées par la témoin, directement ou derrière l'autre imputation
    // qui l'attend (file d'attente du MÊME verrou de ligne) ; aucune imputation terminée avant la levée. Complément : pg_locks.
    // La barrière est TOUJOURS levée (finally) et les TROIS promesses (témoin, deux imputations) toujours récupérées.
    let release!: () => void; const gate = new Promise<void>((r) => { release = r })
    let locked!: () => void; const isLocked = new Promise<void>((r) => { locked = r })
    let witness!: Parameters<Parameters<typeof db.$transaction>[0]>[0] // connexion de la barrière, réutilisée pour l'observation (pas de connexion de plus)
    let holderPid = 0
    const holder = db.$transaction(async (tx) => {
      await tx.$queryRawUnsafe(`SELECT id FROM supplier_invoices WHERE id = 'siX' AND "companyId" = 'coF' FOR UPDATE`)
      holderPid = (await tx.$queryRawUnsafe<{ pid: number }[]>(`SELECT pg_backend_pid() AS pid`))[0].pid
      witness = tx; locked(); await gate
    }, { timeout: 30_000 })
    await isLocked
    const settledEarly: string[] = []
    const call = (w: string) => budget.allocateSupplierInvoice(db, F, { supplierInvoiceId: "siX", worksiteId: w, nature: "OTHER", amountHTCents: BigInt(700) })
      .finally(() => { settledEarly.push(w) })
    const p2 = call("wF2"), p3 = call("wF3")
    let attente: { detenteur: number; bloquees: number[]; pg_locks_non_accordes: number; terminees_avant_levee: string[] } = { detenteur: 0, bloquees: [], pg_locks_non_accordes: 0, terminees_avant_levee: [] }
    type Imputation = Awaited<ReturnType<typeof budget.allocateSupplierInvoice>>
    let toutes: [PromiseSettledResult<void>, PromiseSettledResult<Imputation>, PromiseSettledResult<Imputation>] | undefined
    try {
      for (let i = 0; i < 100; i++) {
        await witness.$executeRawUnsafe(`SELECT pg_stat_clear_snapshot()`)
        const rows = await witness.$queryRawUnsafe<{ pid: number; bloqueurs: number[] }[]>(`SELECT pid, pg_blocking_pids(pid) AS bloqueurs FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid() AND wait_event_type = 'Lock'`)
        const l = await witness.$queryRawUnsafe<{ n: number }[]>(`SELECT count(DISTINCT pid)::int AS n FROM pg_locks WHERE NOT granted AND pid <> pg_backend_pid()`)
        const chaine = new Set<number>([holderPid])
        for (let k = 0; k < rows.length; k++) for (const r of rows) if (!chaine.has(r.pid) && r.bloqueurs.some((b) => chaine.has(b))) chaine.add(r.pid)
        chaine.delete(holderPid)
        attente = { detenteur: holderPid, bloquees: [...chaine], pg_locks_non_accordes: l[0].n, terminees_avant_levee: [...settledEarly] }
        if (attente.bloquees.length >= 2) break
        await new Promise((r) => setTimeout(r, 50))
      }
      assert.ok(holderPid > 0 && attente.bloquees.length >= 2 && attente.terminees_avant_levee.length === 0, `les deux imputations attendent le verrou de la témoin avant sa levée (constaté : ${JSON.stringify(attente)})`)
    } finally {
      release()
      toutes = await Promise.allSettled([holder, p2, p3])
    }
    const [h, a2, a3] = toutes!
    if (h.status === "rejected") throw h.reason
    if (a2.status === "rejected") throw a2.reason
    if (a3.status === "rejected") throw a3.reason
    const r1 = a2.value, r2 = a3.value
    assert.equal([r1, r2].filter((r) => r.ok).length, 1)
    assert.deepEqual([r1, r2].find((r) => !r.ok), { ok: false, error: BUDGET_ERRORS.allocationExceeds })
    const active = await db.supplierInvoiceAllocation.findMany({ where: { supplierInvoiceId: "siX", cancelledAt: null }, select: { amountHTCents: true } })
    assert.deepEqual(active.map((a) => a.amountHTCents), [BigInt(700)], "jamais plus que le HT de la facture")
  })
  it("isolation entre sociétés en lecture (sources de la page et de l'export) : aucune ligne, aucun montant, aucune facture de l'autre", async () => {
    const f = await listWorksiteMargins(db, "coF")
    assert.deepEqual(f.rows.map((r) => r.worksiteId).sort(), ["wF", "wF2", "wF3", "wF4"])
    const a = await listWorksiteMargins(db, "coA")
    assert.deepEqual(a.rows.map((r) => r.worksiteId).sort(), ["wA", "wA2"], "coA ne voit aucun chantier de coF")
    assert.equal(a.rows.find((r) => r.worksiteId === "wA")!.invoicedHTCents, BigInt(0), "les factures émises de coF ne sont jamais comptées chez coA")
    assert.equal(await getWorksiteBudget(db, "coA", "wF"), null, "identifiant forgé : chantier de coF lu par coA")
    assert.equal(await getWorksiteBudget(db, "coF", "wA"), null, "identifiant forgé : chantier de coA lu par coF")
    assert.ok(!(await listAllocatableInvoices(db, "coA")).some((i) => i.id === "siX"))
    assert.ok((await listAllocatableInvoices(db, "coF")).every((i) => i.id === "siX"), "coF ne voit que sa facture encore imputable")
    assert.deepEqual(await budget.allocateSupplierInvoice(db, A, { supplierInvoiceId: "siX", worksiteId: "wA", nature: "OTHER", amountHTCents: BigInt(1) }), { ok: false, error: BUDGET_ERRORS.notFound })
  })
})

it("masque un client d’une autre société dans la liste et le détail utilisés par le CSV", async () => {
  const worksiteId = "worksite-client-cross-tenant"
  await db.$executeRaw`
    INSERT INTO worksites (id, "companyId", "clientId", "createdById", name, "updatedAt")
    VALUES (${worksiteId}, 'coA', 'clB', 'uA', 'Chantier avec lien client incohérent', now())
  `
  try {
    const { rows } = await listWorksiteMargins(db, A.companyId)
    assert.equal(rows.find((site) => site.worksiteId === worksiteId)?.clientName, "—")
    assert.equal(rows.find((site) => site.worksiteId === "wA")?.clientName, "ClA")

    const detail = await getWorksiteBudget(db, A.companyId, worksiteId)
    assert.equal(detail?.worksite.clientName, "—")
    assert.equal((await getWorksiteBudget(db, A.companyId, "wA"))?.worksite.clientName, "ClA")
    assert.equal(await getWorksiteBudget(db, B.companyId, worksiteId), null)
  } finally {
    await db.worksite.delete({ where: { id: worksiteId } })
  }
})
