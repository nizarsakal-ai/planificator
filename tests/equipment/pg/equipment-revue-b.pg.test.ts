/**
 * L1b v2 — revue indépendante B (B-R1 sortie anticipée, B-R2 rapprochement contre annulation) : scénarios PostgreSQL
 * ADVERSARIAUX sur une base JETABLE migrée (jamais une base réelle). Écrit sur le VPS, NON EXÉCUTÉ sur le VPS.
 * Exécution : script test:equipment:concurrence:pg (après equipment-concurrence.pg.test.ts, --test-concurrency=1 ;
 * identifiants « rb… » distincts). Les tests d'origine ne sont pas modifiés.
 *
 * B-R2 déterministe : une session témoin T0 écrit l'annulation du contrat SANS la valider (verrou de ligne), le
 * rapprochement est lancé, on attend (borné) qu'il soit en attente de verrou derrière T0 (pg_stat_activity /
 * pg_blocking_pids), puis T0 VALIDE. Sur la v1 (écriture sans condition de statut), le rapprochement aboutissait sur un
 * contrat CANCELLED ; la v2 doit le refuser sans aucune écriture ni audit. Promesses suivies dès leur lancement, attentes
 * bornées, rejets journalisés (méthode du test de concurrence L1a v3).
 */
import assert from "node:assert/strict"
import { after, before, describe, it } from "node:test"
import { PrismaClient, type Prisma } from "@prisma/client"
import * as svc from "@/lib/equipment/equipment.service"
import { EQUIPMENT_ERRORS, parseDay } from "@/lib/equipment/equipment.core"

const RAW_URL = process.env.DATABASE_URL
if (!RAW_URL) throw new Error("DATABASE_URL requis (base PostgreSQL jetable migrée)")
const url = new URL(RAW_URL); url.searchParams.set("connection_limit", "8")
const db = new PrismaClient({ datasources: { db: { url: url.toString() } } })
const A = { companyId: "rbA", userId: "urbA" }
const B = { companyId: "rbB", userId: "urbB" }
const d = (s: string) => parseDay(s)!
const at = (s: string) => new Date(s)
const T0_TX = { timeout: 30_000, maxWait: 10_000 }
const ok = <T>(r: svc.EquipmentResult<T>): T => { assert.ok(r.ok, r.ok ? "" : r.error); return (r as { ok: true; value: T }).value }
const why = (e: unknown) => (e instanceof Error ? `${e.name}: ${e.message}` : String(e))
function tracked<T>(p: Promise<T>): Promise<T> { p.catch(() => {}); return p }
function signal<T = void>() { let resolve!: (v: T) => void, reject!: (e: unknown) => void; const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej }); promise.catch(() => {}); return { promise, resolve, reject } }
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
const waiters = (pid0: number) => withTimeout(db.$queryRaw<{ pid: number; b: number[] }[]>`
  SELECT pid, pg_blocking_pids(pid) AS b FROM pg_stat_activity
  WHERE datname = current_database() AND wait_event_type = 'Lock' AND pid <> pg_backend_pid() AND pid <> ${pid0}::int`, 2_000, "sonde pg_stat_activity")

/**
 * T0 exécute `hold` puis attend ; les opérations sont lancées ; on attend qu'elles soient TOUTES en attente de verrou
 * (au moins une bloquée par T0) ; T0 est alors VALIDÉE (commit = true) ou ANNULÉE ; résultats dans l'ordre de `ops`.
 */
async function behindT0<R>(label: string, hold: (tx: Prisma.TransactionClient) => Promise<unknown>, commit: boolean, ops: Array<() => Promise<R>>): Promise<R[]> {
  const ROLLBACK = "rollback-volontaire-T0"
  const held = signal<number>(), release = signal()
  const p0 = tracked(db.$transaction(async (tx) => { const pid = await pidOf(tx); await hold(tx); held.resolve(pid); await release.promise; if (!commit) throw new Error(ROLLBACK) }, T0_TX)
    .then(() => undefined, (e) => { if (!(e instanceof Error && e.message.includes(ROLLBACK))) { held.reject(e); throw e } }))
  const started: Promise<R>[] = []
  try {
    const pid0 = await withTimeout(held.promise, 10_000, `${label} : T0`)
    for (const op of ops) started.push(tracked(Promise.resolve().then(op)))
    await waitFor(`${label} : ${ops.length} opération(s) en attente de verrou`, async () => (await waiters(pid0)).length >= ops.length, 3_000)
    const w = await waiters(pid0)
    assert.ok(w.some((x) => x.b.includes(pid0)), `${label} : au moins une opération bloquée par T0`)
    console.log(`DIAGNOSTIC ${label} pid_T0=${pid0} en_attente=${JSON.stringify(w.map((x) => ({ pid: x.pid, bloqueurs: x.b })))} T0=${commit ? "validée" : "annulée"}`)
    release.resolve()
    await withTimeout(p0, 10_000, `${label} : fin de T0`)
    const settled = await withTimeout(Promise.allSettled(started), 20_000, `${label} : fin des opérations`)
    const rejected = settled.map((r, i) => [i, r] as const).filter(([, r]) => r.status === "rejected")
    if (rejected.length) { for (const [i, r] of rejected) console.error(`DIAGNOSTIC ${label} rejet op${i + 1} = ${why((r as PromiseRejectedResult).reason)}`); throw (rejected[0][1] as PromiseRejectedResult).reason }
    return settled.map((r) => (r as PromiseFulfilledResult<R>).value)
  } catch (e) {
    release.resolve()
    console.error(`DIAGNOSTIC ${label} echec = ${why(e)}`)
    const s = await withTimeout(Promise.allSettled([p0, ...started]), 30_000, `${label} : jonction`).catch((j) => { console.error(`DIAGNOSTIC ${label} jonction_impossible=${why(j)}`); return null })
    s?.forEach((r, i) => { if (r.status === "rejected") console.error(`DIAGNOSTIC ${label} rejet ${i === 0 ? "T0" : `op${i}`} = ${why(r.reason)}`) })
    throw e
  }
}

const audits = (entityType: string, entityId?: string, action?: string) => db.historyLog.count({ where: { companyId: A.companyId, entityType, ...(entityId ? { entityId } : {}), ...(action ? { action: action as never } : {}) } })
const bookingsOf = (equipmentId: string) => db.equipmentBooking.count({ where: { equipmentId } })
const eqState = (id: string) => db.equipment.findUniqueOrThrow({ where: { id }, select: { status: true } })
const contractState = (id: string) => db.equipmentRentalContract.findUniqueOrThrow({ where: { id }, select: { status: true, supplierInvoiceId: true } })
let wh = "", rented = ""
const equipment = async (number: string) => ok(await svc.createEquipment(db, A, { number, name: `Équipement ${number}`, category: "Recette", ownership: "OWNED", warehouseId: wh })).id
const book = (equipmentId: string, a: string, b: string, now: string) => svc.createBooking(db, A, { equipmentId, firstDay: d(a), lastDay: d(b) }, at(now))
const contract = async (a: string, b: string) => ok(await svc.createRentalContract(db, A, { equipmentId: rented, supplierId: "rbSup", startDate: d(a), endDate: d(b), dailyRateCents: 1000 })).id

before(async () => {
  for (const sqlText of [
    `INSERT INTO companies(id,name,slug,"updatedAt") VALUES ('rbA','RB A','rb-a',now()),('rbB','RB B','rb-b',now())`,
    `INSERT INTO users(id,email,password,"updatedAt") VALUES ('urbA','rba@x.test','x',now()),('urbB','rbb@x.test','x',now())`,
    `INSERT INTO warehouses(id,"companyId",name,"updatedAt") VALUES ('rbWh','rbA','Dépôt revue B',now())`,
    `INSERT INTO suppliers(id,"companyId",name,"updatedAt") VALUES ('rbSup','rbA','Loueur revue B',now()),('rbSup2','rbA','Autre loueur revue B',now()),('rbSupB','rbB','Loueur société B',now())`,
    `INSERT INTO supplier_invoices(id,"companyId","supplierId","supplierName",number,date,"totalHTCents","vatCents","totalTTCCents","createdById","updatedAt") VALUES
      ('rbInv1','rbA','rbSup','Loueur revue B','RB-1','2028-11-20',1000,200,1200,'urbA',now()),('rbInv2','rbA','rbSup','Loueur revue B','RB-2','2028-11-20',1000,200,1200,'urbA',now()),
      ('rbInv3','rbA','rbSup','Loueur revue B','RB-3','2028-11-20',1000,200,1200,'urbA',now()),('rbInv4','rbA','rbSup','Loueur revue B','RB-4','2028-11-20',1000,200,1200,'urbA',now()),
      ('rbInvAutre','rbA','rbSup2','Autre loueur revue B','RB-X','2028-11-20',1,0,1,'urbA',now()),('rbInvB','rbB','rbSupB','Loueur société B','RB-B','2028-11-20',1,0,1,'urbB',now())`,
  ]) await db.$executeRawUnsafe(sqlText)
  wh = "rbWh"
  rented = ok(await svc.createEquipment(db, A, { number: "RB-LOC-1", name: "Nacelle revue B", category: "Recette", ownership: "RENTED" })).id
})
after(() => db.$disconnect())

describe("B-R1 — sortie anticipée : début d'occupation effectif", () => {
  it("prévue 20–22, sortie le 10 ; réservation 12–13 demandée le 11 ⇒ REFUSÉE sans réservation ni audit ; après retour ⇒ acceptée", async () => {
    const eq = await equipment("RB-R1-1")
    const x = ok(await book(eq, "2028-11-20", "2028-11-22", "2028-11-01T09:00:00Z")).id
    ok(await svc.checkoutBooking(db, A, x, "GOOD", at("2028-11-10T09:00:00Z")))
    assert.equal((await eqState(eq)).status, "OUT")
    const n0 = await bookingsOf(eq), a0 = await audits("EquipmentBooking")
    assert.deepEqual(await book(eq, "2028-11-12", "2028-11-13", "2028-11-11T09:00:00Z"), { ok: false, error: EQUIPMENT_ERRORS.overlap })
    assert.equal(await bookingsOf(eq), n0); assert.equal(await audits("EquipmentBooking"), a0)
    ok(await svc.returnBooking(db, A, x, { condition: "GOOD" }, at("2028-11-11T12:00:00Z")))
    assert.ok(ok(await book(eq, "2028-11-12", "2028-11-13", "2028-11-11T13:00:00Z")).id)
  })
  it("pendant la sortie anticipée, une période réellement disjointe (25–26) reste autorisée", async () => {
    const eq = await equipment("RB-R1-2")
    const x = ok(await book(eq, "2028-11-20", "2028-11-22", "2028-11-01T09:00:00Z")).id
    ok(await svc.checkoutBooking(db, A, x, "GOOD", at("2028-11-10T09:00:00Z")))
    assert.ok(ok(await book(eq, "2028-11-25", "2028-11-26", "2028-11-11T09:00:00Z")).id)
  })
  it("sortie anticipée REFUSÉE si une réservation antérieure existe déjà (12–13), sans changement d'état ni audit", async () => {
    const eq = await equipment("RB-R1-3")
    ok(await book(eq, "2028-11-12", "2028-11-13", "2028-11-01T09:00:00Z"))
    const x = ok(await book(eq, "2028-11-20", "2028-11-22", "2028-11-01T09:00:00Z")).id
    const a0 = await audits("EquipmentBooking")
    assert.deepEqual(await svc.checkoutBooking(db, A, x, "GOOD", at("2028-11-10T09:00:00Z")), { ok: false, error: EQUIPMENT_ERRORS.overlap })
    assert.equal((await eqState(eq)).status, "AVAILABLE")
    assert.equal((await db.equipmentBooking.findUniqueOrThrow({ where: { id: x }, select: { status: true } })).status, "RESERVED")
    assert.equal(await audits("EquipmentBooking"), a0)
  })
  it("LIMITE DOCUMENTÉE : le déclencheur compare les périodes STOCKÉES ; une écriture hors service n'est pas couverte par le début effectif", async () => {
    const eq = await equipment("RB-R1-4")
    const x = ok(await book(eq, "2028-11-20", "2028-11-22", "2028-11-01T09:00:00Z")).id
    ok(await svc.checkoutBooking(db, A, x, "GOOD", at("2028-11-10T09:00:00Z")))
    // Hors service, la base accepte 12–13 (périodes stockées disjointes de 20–22) : la règle du début effectif est applicative.
    await db.$executeRawUnsafe(`INSERT INTO equipment_bookings(id,"companyId","equipmentId","startAt","endAt","createdById","updatedAt") VALUES ('rb-limite','rbA',$1,'2028-11-12','2028-11-14','urbA',now())`, eq)
    assert.equal(await db.equipmentBooking.count({ where: { id: "rb-limite" } }), 1)
    await db.$executeRawUnsafe(`DELETE FROM equipment_bookings WHERE id = 'rb-limite'`)
  })
})

describe("B-R2 — rapprochement de facture contre annulation", () => {
  it("contrat déjà CANCELLED ⇒ rapprochement refusé, facture inchangée, aucun audit UPDATED", async () => {
    const c = await contract("2028-01-01", "2028-01-10")
    ok(await svc.cancelRentalContract(db, A, c, at("2028-01-02T09:00:00Z")))
    const u0 = await audits("EquipmentRentalContract", c, "UPDATED")
    assert.deepEqual(await svc.linkRentalInvoice(db, A, c, "rbInv1"), { ok: false, error: EQUIPMENT_ERRORS.contractCancelled })
    assert.deepEqual(await contractState(c), { status: "CANCELLED", supplierInvoiceId: null })
    assert.equal(await audits("EquipmentRentalContract", c, "UPDATED"), u0)
  })
  it("annulation VALIDÉE entre la lecture et l'écriture du rapprochement ⇒ rapprochement refusé, aucune écriture ni audit", async () => {
    const c = await contract("2028-02-01", "2028-02-10")
    const u0 = await audits("EquipmentRentalContract", c, "UPDATED")
    // T0 écrit l'annulation (même transition conditionnelle que cancelRentalContract), garde le verrou de ligne, puis VALIDE.
    const [link] = await behindT0("B-R2-annulation-validee", async (tx) => {
      const n = await tx.$executeRaw`UPDATE "equipment_rental_contracts" SET "status" = 'CANCELLED' WHERE "id" = ${c} AND "companyId" = 'rbA' AND "status" = 'ACTIVE'`
      assert.equal(n, 1)
    }, true, [() => svc.linkRentalInvoice(db, A, c, "rbInv2")])
    assert.ok(!link.ok, "le rapprochement ne doit pas aboutir sur un contrat annulé")
    // B-R3 : comparaisons explicites (EQUIPMENT_ERRORS est « as const » : includes sur l'union littérale refuse un string).
    const refus = (link as { ok: false; error: string }).error
    assert.ok(refus === EQUIPMENT_ERRORS.conflict || refus === EQUIPMENT_ERRORS.contractCancelled, JSON.stringify(link))
    assert.deepEqual(await contractState(c), { status: "CANCELLED", supplierInvoiceId: null })
    assert.equal(await audits("EquipmentRentalContract", c, "UPDATED"), u0)
  })
  it("rapprochement et annulation simultanés par le service (verrou d'équipement) ⇒ issue cohérente avec un ordre sériel", async () => {
    const c = await contract("2028-03-01", "2028-03-10")
    const u0 = await audits("EquipmentRentalContract", c, "UPDATED")
    const [link, cancel] = await behindT0("B-R2-service", async (tx) => {
      const r = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "equipment" WHERE "id" = ${rented} AND "companyId" = 'rbA' FOR UPDATE`
      assert.equal(r.length, 1)
    }, false, [() => svc.linkRentalInvoice(db, A, c, "rbInv3"), () => svc.cancelRentalContract(db, A, c, at("2028-03-02T09:00:00Z"))])
    assert.ok(cancel.ok, "l'annulation n'a aucune réservation bloquante : elle aboutit dans les deux ordres")
    const st = await contractState(c)
    assert.equal(st.status, "CANCELLED")
    if (link.ok) {
      assert.equal(st.supplierInvoiceId, "rbInv3", "rapprochement puis annulation : facture conservée")
      assert.equal(await audits("EquipmentRentalContract", c, "UPDATED"), u0 + 1)
    } else {
      assert.deepEqual(link, { ok: false, error: EQUIPMENT_ERRORS.contractCancelled }, "annulation puis rapprochement : refus explicite")
      assert.equal(st.supplierInvoiceId, null)
      assert.equal(await audits("EquipmentRentalContract", c, "UPDATED"), u0)
    }
  })
  it("ordre inverse séquentiel : rapprochement PUIS annulation ⇒ les deux aboutissent (comportement conservé)", async () => {
    const c = await contract("2028-04-01", "2028-04-10")
    ok(await svc.linkRentalInvoice(db, A, c, "rbInv4"))
    ok(await svc.cancelRentalContract(db, A, c, at("2028-04-02T09:00:00Z")))
    assert.deepEqual(await contractState(c), { status: "CANCELLED", supplierInvoiceId: "rbInv4" })
  })
  it("contrat CLOSED : rapprochement toujours admis ; facture d'un autre loueur ou d'une autre société refusée sans écriture", async () => {
    const c = await contract("2028-05-01", "2028-05-03")
    ok(await svc.closeRentalContract(db, A, c, d("2028-05-03"), at("2028-05-04T09:00:00Z")))
    const u0 = await audits("EquipmentRentalContract", c, "UPDATED")
    assert.deepEqual(await svc.linkRentalInvoice(db, A, c, "rbInvAutre"), { ok: false, error: EQUIPMENT_ERRORS.supplierInvoiceMismatch })
    assert.deepEqual(await svc.linkRentalInvoice(db, A, c, "rbInvB"), { ok: false, error: EQUIPMENT_ERRORS.notFound })
    assert.deepEqual(await svc.linkRentalInvoice(db, B, c, null), { ok: false, error: EQUIPMENT_ERRORS.notFound })
    assert.deepEqual(await contractState(c), { status: "CLOSED", supplierInvoiceId: null })
    assert.equal(await audits("EquipmentRentalContract", c, "UPDATED"), u0)
    ok(await svc.linkRentalInvoice(db, A, c, "rbInv1"))
    assert.deepEqual(await contractState(c), { status: "CLOSED", supplierInvoiceId: "rbInv1" })
  })
})
