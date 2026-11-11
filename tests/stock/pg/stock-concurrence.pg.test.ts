/**
 * L1a v2 — revue indépendante (R1 P1 inventaire, R2 P2 réceptions) : scénarios PostgreSQL ADVERSARIAUX et DÉTERMINISTES
 * sur une base JETABLE migrée (jamais une base réelle). Écrit sur le VPS, NON EXÉCUTÉ sur le VPS.
 * Exécution : sh tests/billing/pg/with-disposable-db.sh stock npm run test:stock:pg (après stock-service.pg.test.ts,
 * --test-concurrency=1 ; identifiants « cc… » distincts de ce fichier).
 *
 * Méthode (reprise de la méthode revue pour le matériel, réserves M1–M4) : aucune conclusion tirée d'un délai.
 * 1. Une session témoin T0 prend un verrou sur la ligne disputée (niveau de stock ou commande), ou y insère une ligne
 *    NON validée (niveau absent), puis signale qu'elle le détient.
 * 2. Les deux opérations du SERVICE sont alors lancées ; on attend (borné) que les DEUX soient réellement en attente de
 *    verrou dans PostgreSQL (pg_stat_activity.wait_event_type = 'Lock'), au moins une bloquée directement par T0
 *    (pg_blocking_pids). À cet instant, chacune a déjà fait toutes ses lectures non verrouillantes antérieures.
 * 3. T0 est libérée (ROLLBACK : elle n'écrit rien de durable) ; les deux opérations se disputent la ligne.
 * Sur la v1, ce schéma reproduit les défauts (double écart d'inventaire ; commande soldée laissée partielle) ; la v2 doit
 * donner un résultat équivalent à une exécution SÉRIELLE. Libération garantie par `finally`, attentes bornées.
 * Les tests d'origine (stock-service.pg.test.ts) ne sont pas modifiés : aucun invariant n'est affaibli.
 */
import assert from "node:assert/strict"
import { after, before, describe, it } from "node:test"
import { PrismaClient, type Prisma } from "@prisma/client"
import * as svc from "@/lib/stock/stock.service"
import { STOCK_ERRORS } from "@/lib/stock/stock.core"

const RAW_URL = process.env.DATABASE_URL
if (!RAW_URL) throw new Error("DATABASE_URL requis (base PostgreSQL jetable migrée)")
// T0, deux opérations du service et l'observateur ouverts ensemble : limite de pool explicite.
const url = new URL(RAW_URL); url.searchParams.set("connection_limit", "8")
const db = new PrismaClient({ datasources: { db: { url: url.toString() } } })
const A = { companyId: "ccA", userId: "ucA" }
const B = { companyId: "ccB", userId: "ucB" }
const T0_TX = { timeout: 30_000, maxWait: 10_000 }
const T0_ROLLBACK = "rollback-volontaire-T0"
let wh = "", supplier = ""

const ok = <T>(r: svc.StockResult<T>): T => { assert.ok(r.ok, r.ok ? "" : r.error); return (r as { ok: true; value: T }).value }
const level = async (articleId: string, warehouseId = wh) =>
  (await db.stockLevel.findFirst({ where: { warehouseId, articleId }, select: { quantityMilli: true } }))?.quantityMilli ?? null
/** Mouvements de l'article dans le dépôt, avec leur signe (entrée +, sortie −). */
async function movements(articleId: string) {
  const rows = await db.stockMovement.findMany({ where: { companyId: A.companyId, articleId }, orderBy: { createdAt: "asc" }, select: { type: true, quantityMilli: true, fromWarehouseId: true, toWarehouseId: true } })
  return rows.map((m) => ({ type: m.type, signed: (m.toWarehouseId === wh ? m.quantityMilli : 0) - (m.fromWarehouseId === wh ? m.quantityMilli : 0) }))
}
const audits = (entityType: string) => db.historyLog.count({ where: { companyId: A.companyId, entityType } })

function signal<T = void>() {
  let resolve!: (v: T) => void, reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const guard = new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error(`délai dépassé : ${label}`)), ms) })
  return Promise.race([p, guard]).finally(() => clearTimeout(timer))
}
async function waitFor(label: string, check: () => Promise<boolean>, ms: number) {
  const end = Date.now() + ms
  while (Date.now() < end) { if (await check()) return; await new Promise((r) => setTimeout(r, 20)) }
  throw new Error(`délai dépassé : ${label}`)
}
const pidOf = async (tx: Prisma.TransactionClient) => (await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`)[0].pid
/** Sessions de cette base en attente de verrou (hors observateur et hors T0), avec leurs bloqueurs. */
const waiters = async (pid0: number) => withTimeout(db.$queryRaw<{ pid: number; b: number[] }[]>`
  SELECT pid, pg_blocking_pids(pid) AS b FROM pg_stat_activity
  WHERE datname = current_database() AND wait_event_type = 'Lock' AND pid <> pg_backend_pid() AND pid <> ${pid0}::int`, 2_000, "sonde pg_stat_activity")

/** Attache une gestion de rejet DÈS le lancement (aucun rejet non géré) ; la promesse d'origine reste attendue telle quelle. */
function tracked<T>(p: Promise<T>): Promise<T> { p.catch(() => {}); return p }
const why = (e: unknown) => (e instanceof Error ? `${e.name}: ${e.message}` : String(e))
/** Jonction BORNÉE de toutes les promesses ; chaque rejet est journalisé avec son rôle (diagnostic d'erreur technique). */
async function settleAll(label: string, named: Array<[string, Promise<unknown>]>) {
  const settled = await withTimeout(Promise.allSettled(named.map(([, p]) => p)), 30_000, `${label} : jonction`)
    .catch((j) => { console.error(`DIAGNOSTIC ${label} jonction_impossible=${why(j)}`); return null })
  settled?.forEach((r, i) => { if (r.status === "rejected") console.error(`DIAGNOSTIC ${label} rejet ${named[i][0]} = ${why(r.reason)}`) })
  return settled
}

/**
 * T0 prend `lock`, les opérations sont lancées, on attend qu'elles soient TOUTES en attente de verrou (au moins une
 * bloquée par T0), puis T0 est annulée et les résultats des opérations sont renvoyés dans l'ordre de `ops`.
 * L'attente d'observation est courte (≤ 3 s) : les transactions du service gardent leur délai Prisma par défaut.
 * v3 (recontrôle) : T0 et chaque opération ont une gestion de rejet attachée dès leur lancement (un lancement qui échoue
 * de façon synchrone devient un rejet) ; en cas d'échec, technique ou d'assertion, toutes les promesses sont jointes
 * IMMÉDIATEMENT et chaque rejet est journalisé avant de relever l'erreur d'origine (jamais masquée, jamais de PASS induit).
 */
async function contended<R>(label: string, lock: (tx: Prisma.TransactionClient) => Promise<unknown>, ops: Array<() => Promise<R>>): Promise<R[]> {
  const held = signal<number>(), release = signal()
  held.promise.catch(() => {})
  const p0 = tracked(db.$transaction(async (tx) => { const pid = await pidOf(tx); await lock(tx); held.resolve(pid); await release.promise; throw new Error(T0_ROLLBACK) }, T0_TX)
    .then(() => { throw new Error("T0 aurait dû être annulée") }, (e) => { if (!(e instanceof Error && e.message.includes(T0_ROLLBACK))) { held.reject(e); throw e } }))
  const started: Promise<R>[] = []
  try {
    const pid0 = await withTimeout(held.promise, 10_000, `${label} : verrou de T0`)
    assert.ok(Number.isInteger(pid0) && pid0 > 0)
    for (const op of ops) started.push(tracked(Promise.resolve().then(op)))
    await waitFor(`${label} : ${ops.length} opérations en attente de verrou`, async () => (await waiters(pid0)).length >= ops.length, 3_000)
    const w = await waiters(pid0)
    assert.ok(w.some((x) => x.b.includes(pid0)), `${label} : au moins une opération bloquée directement par T0`)
    console.log(`DIAGNOSTIC ${label} pid_T0=${pid0} en_attente=${JSON.stringify(w.map((x) => ({ pid: x.pid, bloqueurs: x.b })))}`)
    release.resolve()
    await withTimeout(p0, 10_000, `${label} : annulation de T0`)
    const settled = await withTimeout(Promise.allSettled(started), 20_000, `${label} : fin des opérations`)
    const rejected = settled.map((r, i) => [i, r] as const).filter(([, r]) => r.status === "rejected")
    if (rejected.length > 0) {
      for (const [i, r] of rejected) console.error(`DIAGNOSTIC ${label} rejet op${i + 1} = ${why((r as PromiseRejectedResult).reason)}`)
      throw (rejected[0][1] as PromiseRejectedResult).reason
    }
    return settled.map((r) => (r as PromiseFulfilledResult<R>).value)
  } catch (e) {
    release.resolve()
    console.error(`DIAGNOSTIC ${label} echec = ${why(e)}`)
    await settleAll(label, [["T0", p0], ...started.map((p, i) => [`op${i + 1}`, p] as [string, Promise<unknown>])])
    throw e
  }
}
const lockLevel = (articleId: string) => async (tx: Prisma.TransactionClient) => {
  const r = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "stock_levels" WHERE "warehouseId" = ${wh} AND "articleId" = ${articleId} FOR UPDATE`
  assert.equal(r.length, 1, "T0 : ligne de stock à verrouiller présente")
}
const lockOrder = (orderId: string) => async (tx: Prisma.TransactionClient) => {
  const r = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "purchase_orders" WHERE "id" = ${orderId} FOR UPDATE`
  assert.equal(r.length, 1, "T0 : commande à verrouiller présente")
}
const inventory = (articleId: string, countedMilli: number) => () => svc.recordInventoryCount(db, A, { warehouseId: wh, articleId, countedMilli, reason: "concurrence" })

/** Commande passée (ORDERED) de lignes à prix explicite ; renvoie l'id et les ids de lignes dans l'ordre. */
async function orderedPo(lines: Array<{ articleId: string | null; quantityMilli: number }>) {
  const po = ok(await svc.createPurchaseOrder(db, A, {
    supplierId: supplier, warehouseId: wh,
    lines: lines.map((l, i) => ({ articleId: l.articleId, designation: `Ligne ${i + 1}`, quantityMilli: l.quantityMilli, unitPriceCents: 100 })),
  }))
  ok(await svc.markOrdered(db, A, po.id))
  const ids = (await db.purchaseOrderLine.findMany({ where: { purchaseOrderId: po.id }, orderBy: { position: "asc" }, select: { id: true } })).map((l) => l.id)
  return { id: po.id, lines: ids }
}
const receive = (orderId: string, orderLineId: string, quantityMilli: number) => () => svc.receiveGoods(db, A, orderId, { lines: [{ orderLineId, quantityMilli }] })
async function orderState(orderId: string) {
  const o = await db.purchaseOrder.findUniqueOrThrow({ where: { id: orderId }, select: { status: true, lines: { orderBy: { position: "asc" }, select: { quantityMilli: true, receivedMilli: true } }, receipts: { select: { id: true } } } })
  return { status: o.status, received: o.lines.map((l) => l.receivedMilli), ordered: o.lines.map((l) => l.quantityMilli), receipts: o.receipts.length }
}

before(async () => {
  for (const sqlText of [
    `INSERT INTO companies(id,name,slug,"updatedAt") VALUES ('ccA','CA','cc-a',now()),('ccB','CB','cc-b',now())`,
    `INSERT INTO users(id,email,password,"updatedAt") VALUES ('ucA','cca@x.test','x',now()),('ucB','ccb@x.test','x',now())`,
    `INSERT INTO articles(id,"companyId",designation,unit,"unitPrice","updatedAt") VALUES
      ('ccR1a','ccA','Inventaire existant','u',1,now()),('ccR1b','ccA','Inventaire absent','u',1,now()),
      ('ccR1c','ccA','Inventaire contre sortie','u',1,now()),('ccR1d','ccA','Inventaire contre entrée','u',1,now()),
      ('ccR1e','ccA','Inventaires différents','u',1,now()),('ccR2','ccA','Réceptions','u',1,now())`,
    `INSERT INTO suppliers(id,"companyId",name,"updatedAt") VALUES ('ccSup','ccA','Fournisseur concurrence',now())`,
  ]) await db.$executeRawUnsafe(sqlText)
  supplier = "ccSup"
  wh = ok(await svc.createWarehouse(db, A, { name: "Dépôt concurrence" })).id
  for (const a of ["ccR1a", "ccR1c", "ccR1d", "ccR1e"]) ok(await svc.recordMovement(db, A, { type: "RECEIPT", articleId: a, quantityMilli: 10_000, toWarehouseId: wh }))
})
after(() => db.$disconnect())

describe("diagnostic", () => {
  it("isolation par défaut ET effective (le raisonnement des verrous suppose READ COMMITTED)", async () => {
    const def = (await db.$queryRaw<{ v: string }[]>`SELECT current_setting('default_transaction_isolation') AS v`)[0].v
    const eff = await db.$transaction(async (tx) => (await tx.$queryRaw<{ v: string }[]>`SELECT current_setting('transaction_isolation') AS v`)[0].v)
    console.log(`DIAGNOSTIC default_transaction_isolation=${def} transaction_isolation=${eff}`)
    assert.equal(eff, "read committed")
  })
})

describe("R1 — inventaire sérialisé par (dépôt, article)", () => {
  it("niveau existant 10, deux inventaires simultanés à 12 ⇒ 12 (jamais 14), un seul ajustement, un seul audit", async () => {
    const audit0 = await audits("StockMovement")
    const [r1, r2] = await contended("R1-existant", lockLevel("ccR1a"), [inventory("ccR1a", 12_000), inventory("ccR1a", 12_000)])
    const values = [ok(r1), ok(r2)]
    assert.equal(values.filter((v) => v !== null).length, 1, "un ajustement, l'autre inventaire constate la conformité")
    assert.equal(await level("ccR1a"), 12_000)
    const adj = (await movements("ccR1a")).filter((m) => m.type === "ADJUSTMENT")
    assert.deepEqual(adj.map((m) => m.signed), [2_000])
    assert.equal(await audits("StockMovement"), audit0 + 1)
  })
  it("niveau existant 10, inventaires simultanés à 12 et à 7 ⇒ résultat SÉRIEL (12 ou 7), écarts calculés chacun sur la valeur courante", async () => {
    const [r1, r2] = await contended("R1-differents", lockLevel("ccR1e"), [inventory("ccR1e", 12_000), inventory("ccR1e", 7_000)])
    ok(r1); ok(r2)
    const final = await level("ccR1e")
    const adj = (await movements("ccR1e")).filter((m) => m.type === "ADJUSTMENT").map((m) => m.signed)
    assert.ok(final === 12_000 || final === 7_000, `final ${final}`)
    // Ordre 12 puis 7 : +2 puis −5 ; ordre 7 puis 12 : −3 puis +5. Jamais +2 et −3 (deux écarts calculés sur 10).
    assert.deepEqual([...adj].sort((x, y) => x - y), final === 7_000 ? [-5_000, 2_000] : [-3_000, 5_000])
    assert.equal(10_000 + adj.reduce((s, v) => s + v, 0), final)
  })
  it("niveau ABSENT, deux inventaires simultanés à 5 ⇒ une seule ligne de stock, 5 (jamais 10), un seul ajustement", async () => {
    const audit0 = await audits("StockMovement")
    // T0 insère la ligne SANS la valider : les créations concurrentes attendent sur la contrainte unique, puis T0 annule.
    const [r1, r2] = await contended("R1-absent", (tx) => tx.$executeRaw`INSERT INTO stock_levels(id,"companyId","warehouseId","articleId","quantityMilli","updatedAt") VALUES ('cc-t0-level','ccA',${wh},'ccR1b',0,now())`,
      [inventory("ccR1b", 5_000), inventory("ccR1b", 5_000)])
    assert.equal([ok(r1), ok(r2)].filter((v) => v !== null).length, 1)
    assert.equal(await db.stockLevel.count({ where: { warehouseId: wh, articleId: "ccR1b" } }), 1)
    assert.equal(await level("ccR1b"), 5_000)
    assert.deepEqual((await movements("ccR1b")).map((m) => [m.type, m.signed]), [["ADJUSTMENT", 5_000]])
    assert.equal(await audits("StockMovement"), audit0 + 1)
    assert.equal(await db.stockLevel.count({ where: { id: "cc-t0-level" } }), 0, "la ligne de T0 a bien été annulée")
  })
  it("inventaire à 12 contre sortie de 5 simultanée ⇒ 7 (inventaire puis sortie) ou 12 (sortie puis inventaire), cohérent", async () => {
    const [inv, out] = await contended("R1-sortie", lockLevel("ccR1c"), [inventory("ccR1c", 12_000), () => svc.recordMovement(db, A, { type: "ISSUE", articleId: "ccR1c", quantityMilli: 5_000, fromWarehouseId: wh })])
    ok(inv); ok(out)
    const final = await level("ccR1c")
    const adj = (await movements("ccR1c")).filter((m) => m.type === "ADJUSTMENT").map((m) => m.signed)
    assert.ok(final === 7_000 || final === 12_000, `final ${final}`)
    assert.deepEqual(adj, [final === 7_000 ? 2_000 : 7_000])
  })
  it("inventaire à 12 contre entrée de 5 simultanée ⇒ 17 (inventaire puis entrée) ou 12 (entrée puis inventaire), cohérent", async () => {
    const [inv, inn] = await contended("R1-entree", lockLevel("ccR1d"), [inventory("ccR1d", 12_000), () => svc.recordMovement(db, A, { type: "RECEIPT", articleId: "ccR1d", quantityMilli: 5_000, toWarehouseId: wh })])
    ok(inv); ok(inn)
    const final = await level("ccR1d")
    const adj = (await movements("ccR1d")).filter((m) => m.type === "ADJUSTMENT").map((m) => m.signed)
    assert.ok(final === 17_000 || final === 12_000, `final ${final}`)
    assert.deepEqual(adj, [final === 17_000 ? 2_000 : -3_000])
  })
  it("inventaire refusé (dépôt d'une autre entreprise, comptage négatif) : aucune ligne de stock créée, aucune trace", async () => {
    const lv = await db.stockLevel.count(), mv = await db.stockMovement.count(), au = await db.historyLog.count()
    assert.deepEqual(await svc.recordInventoryCount(db, B, { warehouseId: wh, articleId: "ccR2", countedMilli: 1_000, reason: "x" }), { ok: false, error: STOCK_ERRORS.notFound })
    assert.deepEqual(await svc.recordInventoryCount(db, A, { warehouseId: wh, articleId: "ccR2", countedMilli: -1, reason: "x" }), { ok: false, error: STOCK_ERRORS.invalidMovement })
    assert.equal(await db.stockLevel.count(), lv); assert.equal(await db.stockMovement.count(), mv); assert.equal(await db.historyLog.count(), au)
  })
})

describe("R2 — réceptions sérialisées par commande", () => {
  it("commande PARTIALLY_RECEIVED, deux réceptions simultanées des DEUX lignes restantes ⇒ RECEIVED, quantités soldées", async () => {
    const po = await orderedPo([{ articleId: "ccR2", quantityMilli: 1_000 }, { articleId: "ccR2", quantityMilli: 2_000 }, { articleId: null, quantityMilli: 3_000 }])
    ok(await receive(po.id, po.lines[0], 1_000)())
    assert.equal((await orderState(po.id)).status, "PARTIALLY_RECEIVED")
    const audit0 = await audits("GoodsReceipt")
    const [r1, r2] = await contended("R2-partielle", lockOrder(po.id), [receive(po.id, po.lines[1], 2_000), receive(po.id, po.lines[2], 3_000)])
    const statuses = [ok(r1).status, ok(r2).status].sort()
    assert.deepEqual(statuses, ["PARTIALLY_RECEIVED", "RECEIVED"], "la seconde réception voit la première validée")
    assert.deepEqual(await orderState(po.id), { status: "RECEIVED", received: [1_000, 2_000, 3_000], ordered: [1_000, 2_000, 3_000], receipts: 3 })
    assert.equal(await audits("GoodsReceipt"), audit0 + 2)
  })
  it("commande ORDERED, deux réceptions simultanées de lignes distinctes ⇒ les deux acceptées (aucun refus indu), RECEIVED", async () => {
    const po = await orderedPo([{ articleId: "ccR2", quantityMilli: 1_000 }, { articleId: null, quantityMilli: 1_000 }])
    const [r1, r2] = await contended("R2-commandee", lockOrder(po.id), [receive(po.id, po.lines[0], 1_000), receive(po.id, po.lines[1], 1_000)])
    assert.deepEqual([ok(r1).status, ok(r2).status].sort(), ["PARTIALLY_RECEIVED", "RECEIVED"])
    assert.deepEqual(await orderState(po.id), { status: "RECEIVED", received: [1_000, 1_000], ordered: [1_000, 1_000], receipts: 2 })
  })
  it("même ligne reçue deux fois en même temps (dépassement) ⇒ une seule acceptée, la perdante sans aucune trace", async () => {
    const po = await orderedPo([{ articleId: "ccR2", quantityMilli: 4_000 }])
    const stock0 = (await level("ccR2")) ?? 0, mv0 = await db.stockMovement.count(), au0 = await audits("GoodsReceipt"), rl0 = await db.goodsReceiptLine.count()
    const res = await contended("R2-meme-ligne", lockOrder(po.id), [receive(po.id, po.lines[0], 4_000), receive(po.id, po.lines[0], 4_000)])
    assert.equal(res.filter((r) => r.ok).length, 1)
    assert.deepEqual(res.find((r) => !r.ok), { ok: false, error: STOCK_ERRORS.orderNotReceivable })
    assert.deepEqual(await orderState(po.id), { status: "RECEIVED", received: [4_000], ordered: [4_000], receipts: 1 })
    assert.equal(await level("ccR2"), stock0 + 4_000)
    assert.equal(await db.stockMovement.count(), mv0 + 1)
    assert.equal(await db.goodsReceiptLine.count(), rl0 + 1)
    assert.equal(await audits("GoodsReceipt"), au0 + 1)
  })
  it("réception contre annulation simultanées ⇒ exclusion mutuelle et atomicité (une seule réussit, aucune trace de l'autre)", async () => {
    const po = await orderedPo([{ articleId: "ccR2", quantityMilli: 2_000 }])
    const mv0 = await db.stockMovement.count(), stock0 = (await level("ccR2")) ?? 0, gr0 = await audits("GoodsReceipt"), po0 = await audits("PurchaseOrder")
    // v4 (tsc VM A r3) : deux opérations de types de résultat différents ; type commun explicite, typage seul.
    const [rec, can] = await contended<svc.StockResult<unknown>>("R2-annulation", lockOrder(po.id), [receive(po.id, po.lines[0], 1_000), () => svc.cancelOrder(db, A, po.id)])
    assert.equal([rec.ok, can.ok].filter(Boolean).length, 1, "exactement une opération réussit")
    const st = await orderState(po.id)
    if (rec.ok) {
      assert.deepEqual(st, { status: "PARTIALLY_RECEIVED", received: [1_000], ordered: [2_000], receipts: 1 })
      assert.deepEqual(can, { ok: false, error: STOCK_ERRORS.orderNotReceivable })
      assert.equal(await db.stockMovement.count(), mv0 + 1)
      assert.equal(await level("ccR2"), stock0 + 1_000)
      assert.equal(await audits("GoodsReceipt"), gr0 + 1)
      assert.equal(await audits("PurchaseOrder"), po0, "aucun audit d'annulation")
    } else {
      assert.deepEqual(st, { status: "CANCELLED", received: [0], ordered: [2_000], receipts: 0 })
      assert.deepEqual(rec, { ok: false, error: STOCK_ERRORS.orderNotReceivable })
      assert.equal(await db.stockMovement.count(), mv0)
      assert.equal(await level("ccR2"), stock0)
      assert.equal(await audits("GoodsReceipt"), gr0, "aucun audit de réception")
      assert.equal(await audits("PurchaseOrder"), po0 + 1, "un audit d'annulation")
    }
  })
})
