/**
 * Lot A Planificator V2 : service du stock et des achats sur une base PostgreSQL JETABLE migrée (jamais une base
 * réelle). Flux complets, isolation entre deux entreprises, stock jamais négatif (y compris en concurrence),
 * surréception refusée, contraintes de la base (CHECK, clés composites), audit et numérotation.
 * Exécution : TEST_PG_ADMIN_URL=postgresql://postgres@127.0.0.1:5432/postgres \
 *   sh tests/billing/pg/with-disposable-db.sh stock npm run test:stock:pg
 */
import assert from "node:assert/strict"
import { after, before, describe, it } from "node:test"
import { PrismaClient } from "@prisma/client"
import * as svc from "@/lib/stock/stock.service"
import { STOCK_ERRORS } from "@/lib/stock/stock.core"

const db = new PrismaClient()
const A = { companyId: "coA", userId: "uA" }
const B = { companyId: "coB", userId: "uB" }
let whA1 = "", whA2 = "", whB = "", poId = "", lineArt = "", lineFree = ""

const level = async (warehouseId: string, articleId = "artA") =>
  (await db.stockLevel.findFirst({ where: { warehouseId, articleId }, select: { quantityMilli: true } }))?.quantityMilli ?? 0
const ok = <T>(r: svc.StockResult<T>): T => { assert.ok(r.ok, r.ok ? "" : r.error); return (r as { ok: true; value: T }).value }

before(async () => {
  for (const sqlText of [
    `INSERT INTO companies(id,name,slug,"updatedAt") VALUES ('coA','A','a',now()),('coB','B','b',now())`,
    `INSERT INTO users(id,email,password,"updatedAt") VALUES ('uA','a@x.test','x',now()),('uB','b@x.test','x',now())`,
    `INSERT INTO clients(id,"companyId",name,"updatedAt") VALUES ('clA','coA','ClA',now())`,
    `INSERT INTO worksites(id,"companyId","clientId","createdById",name,"updatedAt") VALUES ('wA','coA','clA','uA','Chantier A',now())`,
    `INSERT INTO articles(id,"companyId",designation,unit,"unitPrice","updatedAt") VALUES ('artA','coA','Ciment 25 kg','sac',8.50,now()),('artB','coB','Article B','u',1,now())`,
    `INSERT INTO suppliers(id,"companyId",name,"updatedAt") VALUES ('supA','coA','Fournisseur A',now()),('supA2','coA','Autre fournisseur',now()),('supB','coB','Fournisseur B',now())`,
  ]) await db.$executeRawUnsafe(sqlText)
  whA1 = ok(await svc.createWarehouse(db, A, { name: "Dépôt central" })).id
  whA2 = ok(await svc.createWarehouse(db, A, { name: "Dépôt nord" })).id
  whB = ok(await svc.createWarehouse(db, B, { name: "Dépôt B" })).id
})
after(() => db.$disconnect())

describe("dépôts et mouvements", () => {
  it("nom de dépôt unique par entreprise ; le même nom reste possible dans une autre entreprise", async () => {
    const dup = await svc.createWarehouse(db, A, { name: "Dépôt central" })
    assert.deepEqual(dup, { ok: false, error: "Un dépôt porte déjà ce nom." })
    assert.ok((await svc.createWarehouse(db, B, { name: "Dépôt central" })).ok)
  })
  it("entrée, sortie vers un chantier, transfert : niveaux exacts et audit", async () => {
    ok(await svc.recordMovement(db, A, { type: "RECEIPT", articleId: "artA", quantityMilli: 10000, toWarehouseId: whA1 }))
    ok(await svc.recordMovement(db, A, { type: "ISSUE", articleId: "artA", quantityMilli: 2500, fromWarehouseId: whA1, worksiteId: "wA" }))
    ok(await svc.recordMovement(db, A, { type: "TRANSFER", articleId: "artA", quantityMilli: 1500, fromWarehouseId: whA1, toWarehouseId: whA2 }))
    assert.equal(await level(whA1), 6000)
    assert.equal(await level(whA2), 1500)
    const issue = await db.stockMovement.findFirst({ where: { companyId: "coA", type: "ISSUE" }, select: { worksiteId: true, createdById: true } })
    assert.deepEqual(issue, { worksiteId: "wA", createdById: "uA" })
    assert.equal(await db.historyLog.count({ where: { companyId: "coA", entityType: "StockMovement" } }), 3)
  })
  it("sortie au-delà du stock refusée, sans aucune écriture (ni niveau ni mouvement ni audit)", async () => {
    const before = await db.stockMovement.count()
    const audits = await db.historyLog.count()
    assert.deepEqual(await svc.recordMovement(db, A, { type: "ISSUE", articleId: "artA", quantityMilli: 6001, fromWarehouseId: whA1 }), { ok: false, error: STOCK_ERRORS.insufficient })
    assert.equal(await level(whA1), 6000)
    assert.equal(await db.stockMovement.count(), before)
    assert.equal(await db.historyLog.count(), audits)
  })
  it("concurrence : deux sorties simultanées dont la somme dépasse le stock ⇒ une seule réussit, jamais de négatif", async () => {
    const [r1, r2] = await Promise.all([
      svc.recordMovement(db, A, { type: "ISSUE", articleId: "artA", quantityMilli: 4000, fromWarehouseId: whA1 }),
      svc.recordMovement(db, A, { type: "ISSUE", articleId: "artA", quantityMilli: 4000, fromWarehouseId: whA1 }),
    ])
    assert.equal([r1, r2].filter((r) => r.ok).length, 1)
    assert.equal(await level(whA1), 2000)
  })
  it("ajustement motivé et inventaire (écart tracé, aucun mouvement si conforme)", async () => {
    assert.deepEqual(await svc.recordMovement(db, A, { type: "ADJUSTMENT", articleId: "artA", quantityMilli: 100, fromWarehouseId: whA1, reason: " " }), { ok: false, error: STOCK_ERRORS.reasonRequired })
    assert.equal(ok(await svc.recordInventoryCount(db, A, { warehouseId: whA1, articleId: "artA", countedMilli: 2000, reason: "annuel" })), null)
    assert.ok(ok(await svc.recordInventoryCount(db, A, { warehouseId: whA1, articleId: "artA", countedMilli: 1800, reason: "annuel" })))
    assert.equal(await level(whA1), 1800)
    const adj = await db.stockMovement.findFirst({ where: { companyId: "coA", type: "ADJUSTMENT" }, orderBy: { createdAt: "desc" }, select: { quantityMilli: true, fromWarehouseId: true, reason: true } })
    assert.deepEqual(adj, { quantityMilli: 200, fromWarehouseId: whA1, reason: "Inventaire : annuel" })
  })
  it("dépôt désactivé : plus aucun mouvement, consultation conservée ; seuil d'alerte", async () => {
    ok(await svc.setWarehouseActive(db, A, whA2, false))
    assert.deepEqual(await svc.recordMovement(db, A, { type: "ISSUE", articleId: "artA", quantityMilli: 1, fromWarehouseId: whA2 }), { ok: false, error: STOCK_ERRORS.inactiveWarehouse })
    ok(await svc.setWarehouseActive(db, A, whA2, true))
    ok(await svc.setThreshold(db, A, { warehouseId: whA1, articleId: "artA", minQuantityMilli: 5000 }))
    assert.equal((await db.stockLevel.findFirst({ where: { warehouseId: whA1, articleId: "artA" } }))?.minQuantityMilli, 5000)
  })
})

describe("isolation entre entreprises", () => {
  it("l'entreprise B ne peut ni lire ni utiliser le dépôt, l'article, le chantier ou le fournisseur de A", async () => {
    for (const r of [
      await svc.recordMovement(db, B, { type: "RECEIPT", articleId: "artA", quantityMilli: 1, toWarehouseId: whB }),
      await svc.recordMovement(db, B, { type: "RECEIPT", articleId: "artB", quantityMilli: 1, toWarehouseId: whA1 }),
      await svc.recordMovement(db, B, { type: "ISSUE", articleId: "artB", quantityMilli: 1, fromWarehouseId: whB, worksiteId: "wA" }),
      await svc.setWarehouseActive(db, B, whA1, false),
      await svc.setThreshold(db, B, { warehouseId: whA1, articleId: "artA", minQuantityMilli: 1 }),
      await svc.createPurchaseOrder(db, B, { supplierId: "supA", warehouseId: whB, lines: [{ designation: "x", quantityMilli: 1000, unitPriceCents: 1 }] }),
      await svc.createPurchaseOrder(db, B, { supplierId: "supB", warehouseId: whA1, lines: [{ designation: "x", quantityMilli: 1000, unitPriceCents: 1 }] }),
    ]) assert.deepEqual(r, { ok: false, error: STOCK_ERRORS.notFound })
    assert.equal(await level(whA1), 1800)
  })
  it("la base refuse elle-même un niveau de stock reliant un dépôt de A à une ligne de B (clé composite)", async () => {
    await assert.rejects(db.$executeRawUnsafe(`INSERT INTO stock_levels(id,"companyId","warehouseId","articleId","quantityMilli","updatedAt") VALUES ('x1','coB','${whA1}','artB',1,now())`), /stock_levels_companyId_warehouseId_fkey|foreign key/i)
  })
  it("la base refuse un stock négatif et un mouvement incohérent écrits hors du service (CHECK)", async () => {
    await assert.rejects(db.$executeRawUnsafe(`UPDATE stock_levels SET "quantityMilli" = -1 WHERE "warehouseId" = '${whA1}'`), /stock_levels_values_check/)
    await assert.rejects(db.$executeRawUnsafe(`INSERT INTO stock_movements(id,"companyId",type,"articleId","fromWarehouseId","toWarehouseId","quantityMilli","createdById") VALUES ('m1','coA','TRANSFER','artA','${whA1}','${whA1}',1,'uA')`), /stock_movements_values_check/)
  })
})

describe("commandes d'achat, réceptions et rapprochement", () => {
  it("création numérotée CA-AAAA-0001, total HT, audit ; ligne sans article admise (hors stock)", async () => {
    const po = ok(await svc.createPurchaseOrder(db, A, {
      supplierId: "supA", warehouseId: whA1, worksiteId: "wA",
      lines: [{ articleId: "artA", designation: "", quantityMilli: 20000, unitPriceCents: 850 }, { designation: "Transport", quantityMilli: 1000, unitPriceCents: 4000 }],
    }))
    poId = po.id
    assert.match(po.number, /^CA-\d{4}-0001$/)
    const row = await db.purchaseOrder.findUniqueOrThrow({ where: { id: poId }, select: { totalHTCents: true, status: true, lines: { orderBy: { position: "asc" }, select: { id: true, designation: true } } } })
    assert.equal(row.totalHTCents, BigInt("21000"))
    assert.equal(row.status, "DRAFT")
    assert.equal(row.lines[0].designation, "Ciment 25 kg")
    ;[lineArt, lineFree] = row.lines.map((l) => l.id)
    assert.equal(await db.historyLog.count({ where: { companyId: "coA", entityType: "PurchaseOrder", entityId: poId } }), 1)
  })
  it("réception refusée tant que la commande n'est pas passée ; puis réception partielle", async () => {
    assert.deepEqual(await svc.receiveGoods(db, A, poId, { lines: [{ orderLineId: lineArt, quantityMilli: 1000 }] }), { ok: false, error: STOCK_ERRORS.orderNotReceivable })
    ok(await svc.markOrdered(db, A, poId))
    const before = await level(whA1)
    const r = ok(await svc.receiveGoods(db, A, poId, { lines: [{ orderLineId: lineArt, quantityMilli: 12000 }] }))
    assert.equal(r.status, "PARTIALLY_RECEIVED")
    assert.match(r.number, /^BR-\d{4}-0001$/)
    assert.equal(await level(whA1), before + 12000)
    const mv = await db.stockMovement.findFirst({ where: { goodsReceiptLine: { goodsReceiptId: r.id } }, select: { type: true, worksiteId: true, quantityMilli: true } })
    assert.deepEqual(mv, { type: "RECEIPT", worksiteId: "wA", quantityMilli: 12000 })
  })
  it("surréception refusée sans écriture ; annulation refusée après une réception", async () => {
    const lvl = await level(whA1)
    assert.deepEqual(await svc.receiveGoods(db, A, poId, { lines: [{ orderLineId: lineArt, quantityMilli: 8001 }] }), { ok: false, error: STOCK_ERRORS.overReceipt })
    assert.equal(await level(whA1), lvl)
    assert.equal(await db.goodsReceipt.count({ where: { purchaseOrderId: poId } }), 1)
    assert.deepEqual(await svc.cancelOrder(db, A, poId), { ok: false, error: STOCK_ERRORS.orderNotReceivable })
  })
  it("facture d'un autre fournisseur refusée ; solde de la commande ; rapprochement conforme à la tolérance près", async () => {
    await db.$executeRawUnsafe(`INSERT INTO supplier_invoices(id,"companyId","supplierId","supplierName",number,date,"totalHTCents","vatCents","totalTTCCents","createdById","updatedAt") VALUES
      ('siA','coA','supA','Fournisseur A','F-1','2026-11-04',21050,4210,25260,'uA',now()),('siX','coA','supA2','Autre fournisseur','F-9','2026-11-04',100,20,120,'uA',now())`)
    assert.deepEqual(await svc.receiveGoods(db, A, poId, { lines: [{ orderLineId: lineArt, quantityMilli: 8000 }], supplierInvoiceId: "siX" }), { ok: false, error: STOCK_ERRORS.supplierInvoiceMismatch })
    const r = ok(await svc.receiveGoods(db, A, poId, { lines: [{ orderLineId: lineArt, quantityMilli: 8000 }, { orderLineId: lineFree, quantityMilli: 1000 }], supplierInvoiceId: "siA" }))
    assert.equal(r.status, "RECEIVED")
    assert.equal(await db.stockMovement.count({ where: { goodsReceiptLine: { goodsReceiptId: r.id } } }), 1, "la ligne sans article ne crée pas de mouvement")
    const match = await svc.orderMatch(db, A, poId)
    assert.deepEqual(match, { orderedCents: BigInt("21000"), receivedCents: BigInt("21000"), invoicedCents: BigInt("21050"), status: "CONFORME" })
    assert.equal(await svc.orderMatch(db, B, poId), null, "rapprochement invisible pour une autre entreprise")
  })
  it("la base interdit une surréception écrite hors du service (CHECK receivedMilli <= quantityMilli)", async () => {
    await assert.rejects(db.$executeRawUnsafe(`UPDATE purchase_order_lines SET "receivedMilli" = "quantityMilli" + 1 WHERE id = '${lineArt}'`), /purchase_order_lines_values_check/)
  })
})

describe("revue indépendante du lot A : identifiants forgés, concurrence des réceptions, chantier archivé, prix", () => {
  it("l'entreprise B ne peut ni passer, ni annuler, ni réceptionner la commande de A, ni lier ses réceptions", async () => {
    const receipt = await db.goodsReceipt.findFirstOrThrow({ where: { purchaseOrderId: poId }, select: { id: true } })
    assert.deepEqual(await svc.markOrdered(db, B, poId), { ok: false, error: STOCK_ERRORS.orderNotEditable })
    assert.deepEqual(await svc.cancelOrder(db, B, poId), { ok: false, error: STOCK_ERRORS.orderNotReceivable })
    assert.deepEqual(await svc.receiveGoods(db, B, poId, { lines: [{ orderLineId: lineArt, quantityMilli: 1 }] }), { ok: false, error: STOCK_ERRORS.notFound })
    assert.deepEqual(await svc.linkSupplierInvoice(db, B, receipt.id, null), { ok: false, error: STOCK_ERRORS.notFound })
    assert.deepEqual(await svc.linkSupplierInvoice(db, A, receipt.id, "siInexistante"), { ok: false, error: STOCK_ERRORS.notFound })
    assert.equal((await db.purchaseOrder.findUniqueOrThrow({ where: { id: poId }, select: { status: true } })).status, "RECEIVED")
  })
  it("brouillon de A : B ne peut ni le passer ni l'annuler (refus ET état inchangé, donc discriminant)", async () => {
    const draft = ok(await svc.createPurchaseOrder(db, A, { supplierId: "supA", warehouseId: whA1, lines: [{ designation: "Gants", quantityMilli: 1000, unitPriceCents: 300 }] }))
    assert.deepEqual(await svc.markOrdered(db, B, draft.id), { ok: false, error: STOCK_ERRORS.orderNotEditable })
    assert.deepEqual(await svc.cancelOrder(db, B, draft.id), { ok: false, error: STOCK_ERRORS.orderNotReceivable })
    assert.equal((await db.purchaseOrder.findUniqueOrThrow({ where: { id: draft.id }, select: { status: true } })).status, "DRAFT")
    assert.equal(await db.historyLog.count({ where: { entityType: "PurchaseOrder", entityId: draft.id } }), 1, "seule la création est tracée")
  })
  it("numérotation concurrente : deux commandes créées en même temps reçoivent des numéros distincts et consécutifs", async () => {
    const mk = () => svc.createPurchaseOrder(db, A, { supplierId: "supA", warehouseId: whA1, lines: [{ designation: "Vis", quantityMilli: 1000, unitPriceCents: 10 }] })
    const [p1, p2] = await Promise.all([mk(), mk()])
    const n = [ok(p1).number, ok(p2).number].map((x) => Number(x.slice(-4))).sort((a, b) => a - b)
    assert.equal(n[1] - n[0], 1)
  })
  it("deux réceptions simultanées du même reste : une seule réussit, l'autre est entièrement annulée (aucune trace)", async () => {
    const po = ok(await svc.createPurchaseOrder(db, A, { supplierId: "supA", warehouseId: whA1, lines: [{ articleId: "artA", designation: "", quantityMilli: 5000, unitPriceCents: 850 }] }))
    ok(await svc.markOrdered(db, A, po.id))
    const line = await db.purchaseOrderLine.findFirstOrThrow({ where: { purchaseOrderId: po.id }, select: { id: true } })
    const lvl = await level(whA1)
    const [r1, r2] = await Promise.all([
      svc.receiveGoods(db, A, po.id, { lines: [{ orderLineId: line.id, quantityMilli: 5000 }] }),
      svc.receiveGoods(db, A, po.id, { lines: [{ orderLineId: line.id, quantityMilli: 5000 }] }),
    ])
    assert.equal([r1, r2].filter((r) => r.ok).length, 1)
    assert.equal(await db.goodsReceipt.count({ where: { purchaseOrderId: po.id } }), 1)
    assert.equal(await level(whA1), lvl + 5000)
    assert.equal((await db.purchaseOrderLine.findUniqueOrThrow({ where: { id: line.id }, select: { receivedMilli: true } })).receivedMilli, 5000)
  })
  it("chantier archivé : nouvelle sortie refusée, mais réception d'une commande antérieure acceptée", async () => {
    const po = ok(await svc.createPurchaseOrder(db, A, { supplierId: "supA", warehouseId: whA1, worksiteId: "wA", lines: [{ articleId: "artA", designation: "", quantityMilli: 1000, unitPriceCents: 850 }] }))
    ok(await svc.markOrdered(db, A, po.id))
    await db.$executeRawUnsafe(`UPDATE worksites SET "archivedAt" = now() WHERE id = 'wA'`)
    assert.deepEqual(await svc.recordMovement(db, A, { type: "ISSUE", articleId: "artA", quantityMilli: 1, fromWarehouseId: whA1, worksiteId: "wA" }), { ok: false, error: STOCK_ERRORS.notFound })
    const line = await db.purchaseOrderLine.findFirstOrThrow({ where: { purchaseOrderId: po.id }, select: { id: true } })
    assert.equal(ok(await svc.receiveGoods(db, A, po.id, { lines: [{ orderLineId: line.id, quantityMilli: 1000 }] })).status, "RECEIVED")
    await db.$executeRawUnsafe(`UPDATE worksites SET "archivedAt" = NULL WHERE id = 'wA'`)
  })
  it("prix vide : prix de l'article ; ligne sans article et sans prix refusée", async () => {
    const po = ok(await svc.createPurchaseOrder(db, A, { supplierId: "supA", warehouseId: whA1, lines: [{ articleId: "artA", designation: "", quantityMilli: 2000, unitPriceCents: null }] }))
    const line = await db.purchaseOrderLine.findFirstOrThrow({ where: { purchaseOrderId: po.id }, select: { unitPriceCents: true } })
    assert.equal(line.unitPriceCents, 850)
    assert.equal((await db.purchaseOrder.findUniqueOrThrow({ where: { id: po.id }, select: { totalHTCents: true } })).totalHTCents, BigInt("1700"))
    const r = await svc.createPurchaseOrder(db, A, { supplierId: "supA", warehouseId: whA1, lines: [{ designation: "Location benne", quantityMilli: 1000, unitPriceCents: null }] })
    assert.deepEqual(r, { ok: false, error: "Prix unitaire manquant (ligne 1)." })
  })
})
