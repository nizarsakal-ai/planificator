/**
 * Échec réel VM v6 (06/11/2026) : « deux réservations simultanées chevauchantes ⇒ une seule réussit » a donné 2 réussites.
 * Version 2 (revue Codex 301b950d, réserves M1–M3). Base PostgreSQL JETABLE migrée uniquement (jamais une base réelle).
 * Écrite sur le VPS, NON EXÉCUTÉE sur le VPS : exécutée par la phase CONFINÉE du harnais laboratoire matériel (M4).
 *
 * M1 — instrumentation DÉTERMINISTE : aucune conclusion tirée d'un délai. La transaction T1 signale explicitement qu'elle
 * détient le verrou ; T2 n'est lancée qu'après ce signal, signale son identifiant de session, puis demande le verrou ; un
 * observateur (troisième session, hors transaction) attend, dans une limite de temps, que pg_blocking_pids(T2) contienne T1.
 * T1 n'est libérée qu'ensuite. La libération est garantie par `finally` (et le délai maximal des transactions Prisma) :
 * aucune barrière n'exige qu'une transaction acquière un verrou sous un autre, donc pas d'interblocage artificiel.
 * M2 — concurrence directe en base : INSERT/INSERT et UPDATE/UPDATE chevauchants, changement d'equipmentId, réactivation ;
 * refus du service sans écriture ni audit. M3 — sortie EN RETARD : la fin EFFECTIVE (maintenant) est appliquée par le
 * service ; le déclencheur compare les périodes STOCKÉES (limite documentée, assertion explicite ci-dessous).
 * Le test d'origine (equipment-service.pg.test.ts) n'est PAS modifié : aucun invariant n'est affaibli.
 */
import assert from "node:assert/strict"
import { after, before, describe, it } from "node:test"
import { PrismaClient, type Prisma } from "@prisma/client"
import * as svc from "@/lib/equipment/equipment.service"
import { EQUIPMENT_ERRORS, parseDay } from "@/lib/equipment/equipment.core"

const RAW_URL = process.env.DATABASE_URL
if (!RAW_URL) throw new Error("DATABASE_URL requis (base PostgreSQL jetable migrée)")
// Au moins trois sessions simultanées (T1, T2, observateur) : limite de pool explicite, indépendante du nombre de processeurs.
const url = new URL(RAW_URL); url.searchParams.set("connection_limit", "8")
const db = new PrismaClient({ datasources: { db: { url: url.toString() } } })
const A = { companyId: "coA", userId: "uA" }
const B = { companyId: "coB", userId: "uB" }
const NOW = new Date("2026-11-04T09:00:00Z")
const d = (s: string) => parseDay(s)!
const ok = <T>(r: svc.EquipmentResult<T>): T => { assert.ok(r.ok, r.ok ? "" : r.error); return (r as { ok: true; value: T }).value }
const TX = { timeout: 20_000, maxWait: 10_000 }
let eqA = "", eqA2 = "", eqB = ""

/** Signal à usage unique (promesse résolue OU rejetée de l'extérieur ; un second appel est sans effet). */
function signal<T = void>() {
  let resolve!: (v: T) => void, reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}
/** Réserve v3 (1) : toute attente est BORNÉE ; le dépassement lève une erreur nommée (jamais une attente infinie). */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const guard = new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error(`délai dépassé : ${label}`)), ms) })
  return Promise.race([p, guard]).finally(() => clearTimeout(timer))
}
/** Attente BORNÉE d'une condition (observation, jamais une preuve par délai). */
async function waitFor(label: string, check: () => Promise<boolean>, ms = 10_000) {
  const end = Date.now() + ms
  while (Date.now() < end) { if (await check()) return; await new Promise((r) => setTimeout(r, 25)) }
  throw new Error(`délai dépassé : ${label}`)
}
// Sonde bornée : une requête d'observation suspendue ne peut pas bloquer la suite.
const blockers = async (pid: number) => (await withTimeout(db.$queryRaw<{ b: number[] }[]>`SELECT pg_blocking_pids(${pid}::int) AS b`, 2_000, "sonde pg_blocking_pids"))[0]?.b ?? []
const pidOf = async (tx: Prisma.TransactionClient) => (await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`)[0].pid

/**
 * Exécute T1 (prend le verrou via `hold`, puis attend la libération) et T2 (lancée APRÈS le signal de T1) ; vérifie par
 * pg_blocking_pids que T2 est bloquée par T1, libère T1, puis renvoie les résultats.
 * Réserve v3 (1) : un échec de démarrage de T1 ou de T2 (maxWait, connexion, erreur avant pidOf) REJETTE le signal attendu ;
 * chaque attente est bornée ; les pids sont contrôlés (entiers positifs, distincts). En cas d'échec : libération de T1, puis
 * jonction BORNÉE des deux transactions (allSettled), puis l'erreur d'origine est relevée telle quelle (jamais masquée).
 */
async function serialized<T1, T2>(hold: (tx: Prisma.TransactionClient) => Promise<T1>, second: (tx: Prisma.TransactionClient) => Promise<T2>) {
  const held = signal<number>(), release = signal(), t2pid = signal<number>()
  const p1 = db.$transaction(async (tx) => { const pid = await pidOf(tx); const v = await hold(tx); held.resolve(pid); await release.promise; return v }, TX)
  p1.catch((e) => held.reject(e)) // sans effet si T1 avait déjà signalé
  let p2: Promise<T2> | undefined
  try {
    const pid1 = await withTimeout(held.promise, 15_000, "T1 : prise du verrou")
    assert.ok(Number.isInteger(pid1) && pid1 > 0, `pid de T1 invalide : ${pid1}`)
    p2 = db.$transaction(async (tx) => { t2pid.resolve(await pidOf(tx)); return second(tx) }, TX)
    p2.catch((e) => t2pid.reject(e)) // démarrage échoué AVANT pidOf : le signal est rejeté ; après pidOf : sans effet
    const pid2 = await withTimeout(t2pid.promise, 15_000, "T2 : démarrage de la transaction")
    assert.ok(Number.isInteger(pid2) && pid2 > 0, `pid de T2 invalide : ${pid2}`)
    assert.notEqual(pid1, pid2, "T1 et T2 ouvertes simultanément doivent être deux sessions distinctes")
    await waitFor("T2 bloquée par T1 (pg_blocking_pids)", async () => (await blockers(pid2)).includes(pid1))
    release.resolve()
    return { pid1, pid2, p1, p2 }
  } catch (e) {
    release.resolve()
    const joined = p2 ? [p1, p2] : [p1]
    await withTimeout(Promise.allSettled(joined), 30_000, "jonction des transactions après échec").catch((j) => console.error(`DIAGNOSTIC jonction_apres_echec=${j instanceof Error ? j.message : String(j)}`))
    throw e
  }
}

before(async () => {
  for (const sqlText of [
    `INSERT INTO companies(id,name,slug,"updatedAt") VALUES ('coA','A','a',now()),('coB','B','b',now())`,
    `INSERT INTO users(id,email,password,"updatedAt") VALUES ('uA','a@x.test','x',now()),('uB','b@x.test','x',now())`,
    `INSERT INTO warehouses(id,"companyId",name,"updatedAt") VALUES ('whA','coA','Dépôt A',now()),('whB','coB','Dépôt B',now())`,
  ]) await db.$executeRawUnsafe(sqlText)
  eqA = ok(await svc.createEquipment(db, A, { number: "MAT-C1", name: "Bétonnière", category: "Gros œuvre", ownership: "OWNED", warehouseId: "whA" })).id
  eqA2 = ok(await svc.createEquipment(db, A, { number: "MAT-C2", name: "Compacteur", category: "Gros œuvre", ownership: "OWNED", warehouseId: "whA" })).id
  eqB = ok(await svc.createEquipment(db, B, { number: "MAT-C1", name: "Bétonnière B", category: "Gros œuvre", ownership: "OWNED", warehouseId: "whB" })).id
})
after(() => db.$disconnect())

describe("M1 — diagnostic déterministe (valeurs consignées dans le journal)", () => {
  it("isolation par défaut ET effective d'une transaction interactive", async () => {
    const def = (await db.$queryRaw<{ v: string }[]>`SELECT current_setting('default_transaction_isolation') AS v`)[0].v
    const eff = await db.$transaction(async (tx) => (await tx.$queryRaw<{ v: string }[]>`SELECT current_setting('transaction_isolation') AS v`)[0].v, TX)
    console.log(`DIAGNOSTIC default_transaction_isolation=${def} transaction_isolation=${eff}`)
    assert.equal(eff, "read committed", "le raisonnement du verrou et du déclencheur suppose READ COMMITTED")
  })
  it("le FOR UPDATE du service bloque réellement une seconde session (observé par pg_blocking_pids), qui voit ensuite l'écriture validée", async () => {
    const r = await serialized(
      async (tx) => { await tx.$queryRaw`SELECT "id" FROM "equipment" WHERE "id" = ${eqA} AND "companyId" = 'coA' FOR UPDATE`
        await tx.$executeRawUnsafe(`INSERT INTO equipment_bookings(id,"companyId","equipmentId","startAt","endAt","createdById","updatedAt") VALUES ('m1-a','coA',$1,'2027-10-01','2027-10-03','uA',now())`, eqA) },
      async (tx) => { await tx.$queryRaw`SELECT "id" FROM "equipment" WHERE "id" = ${eqA} AND "companyId" = 'coA' FOR UPDATE`
        return (await tx.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM equipment_bookings WHERE id = 'm1-a'`)[0].n },
    )
    await r.p1
    const seen = await r.p2!
    console.log(`DIAGNOSTIC pid_T1=${r.pid1} pid_T2=${r.pid2} T2_bloquee_par_T1=oui reservation_T1_visible_par_T2=${seen}`)
    assert.equal(seen, 1, "après l'attente, la relecture de T2 doit voir la réservation validée par T1 (READ COMMITTED)")
  })
})

describe("M2 — concurrence directe en base (déclencheur)", () => {
  it("INSERT/INSERT chevauchants : le second, bloqué par le premier, est refusé après sa validation", async () => {
    const ins = (id: string, s: string, e: string) => (tx: Prisma.TransactionClient) => tx.$executeRawUnsafe(
      `INSERT INTO equipment_bookings(id,"companyId","equipmentId","startAt","endAt","createdById","updatedAt") VALUES ($1,'coA',$2,$3::timestamp,$4::timestamp,'uA',now())`, id, eqA, s, e)
    const r = await serialized(ins("ii-1", "2027-11-01", "2027-11-04"), ins("ii-2", "2027-11-03", "2027-11-06"))
    await r.p1
    await assert.rejects(r.p2!, /EQUIPMENT_BOOKING_OVERLAP/)
    assert.deepEqual((await db.equipmentBooking.findMany({ where: { id: { in: ["ii-1", "ii-2"] } }, select: { id: true } })).map((x) => x.id), ["ii-1"])
  })
  it("UPDATE/UPDATE vers des périodes chevauchantes : le second est refusé, rien n'est modifié par lui", async () => {
    await db.$executeRawUnsafe(`INSERT INTO equipment_bookings(id,"companyId","equipmentId","startAt","endAt","createdById","updatedAt") VALUES ('uu-x','coA',$1,'2027-12-01','2027-12-03','uA',now()),('uu-y','coA',$1,'2027-12-20','2027-12-22','uA',now())`, eqA)
    const upd = (id: string, s: string, e: string) => (tx: Prisma.TransactionClient) => tx.$executeRawUnsafe(`UPDATE equipment_bookings SET "startAt" = $2::timestamp, "endAt" = $3::timestamp WHERE id = $1`, id, s, e)
    const r = await serialized(upd("uu-x", "2027-12-10", "2027-12-14"), upd("uu-y", "2027-12-12", "2027-12-16"))
    await r.p1
    await assert.rejects(r.p2!, /EQUIPMENT_BOOKING_OVERLAP/)
    const y = await db.equipmentBooking.findUniqueOrThrow({ where: { id: "uu-y" }, select: { startAt: true } })
    assert.equal(y.startAt.toISOString(), "2027-12-20T00:00:00.000Z")
  })
  it("changement d'equipmentId vers un équipement occupé : refusé ; réactivation chevauchante : refusée ; annulée et contiguë : admises", async () => {
    const ins = (id: string, eq: string, s: string, e: string, status = "RESERVED") => db.$executeRawUnsafe(
      `INSERT INTO equipment_bookings(id,"companyId","equipmentId","startAt","endAt",status,"createdById","updatedAt") VALUES ($1,'coA',$2,$3::timestamp,$4::timestamp,$5::"EquipmentBookingStatus",'uA',now())`, id, eq, s, e, status)
    await ins("g1", eqA, "2028-01-01", "2028-01-04")
    await ins("g2", eqA2, "2028-01-02", "2028-01-03")
    await assert.rejects(db.$executeRawUnsafe(`UPDATE equipment_bookings SET "equipmentId" = $1 WHERE id = 'g2'`, eqA), /EQUIPMENT_BOOKING_OVERLAP/)
    await ins("g3", eqA, "2028-01-04", "2028-01-06") // contiguë : [début, fin) semi-ouvert
    await ins("g4", eqA, "2028-01-02", "2028-01-03", "CANCELLED") // annulée : non active
    await assert.rejects(db.$executeRawUnsafe(`UPDATE equipment_bookings SET status = 'RESERVED' WHERE id = 'g4'`), /EQUIPMENT_BOOKING_OVERLAP/)
    assert.equal(await db.equipmentBooking.count({ where: { id: { in: ["g1", "g3"] }, status: "RESERVED" } }), 2)
  })
})

describe("M2 — service : concurrence, isolation entre équipements et sociétés, aucun effet d'un refus", () => {
  it("chevauchement concurrent (8 répétitions) : exactement une réussite et un seul audit par répétition", async () => {
    for (let k = 0; k < 8; k++) {
      const base = new Date(Date.UTC(2028, 2, 1 + k * 10)), day = (n: number) => new Date(base.getTime() + n * 86_400_000)
      const audits = await db.historyLog.count({ where: { entityType: "EquipmentBooking", action: "CREATED" } })
      const rs = await Promise.all([
        svc.createBooking(db, A, { equipmentId: eqA, firstDay: day(0), lastDay: day(2) }, NOW),
        svc.createBooking(db, A, { equipmentId: eqA, firstDay: day(1), lastDay: day(3) }, NOW),
      ])
      assert.equal(rs.filter((r) => r.ok).length, 1, `répétition ${k}`)
      assert.deepEqual(rs.find((r) => !r.ok), { ok: false, error: EQUIPMENT_ERRORS.overlap })
      assert.equal(await db.equipmentBooking.count({ where: { equipmentId: eqA, startAt: { gte: day(0), lt: day(4) }, status: "RESERVED" } }), 1)
      assert.equal(await db.historyLog.count({ where: { entityType: "EquipmentBooking", action: "CREATED" } }), audits + 1, "aucun audit pour l'opération refusée")
    }
  })
  it("périodes contiguës, équipements distincts d'une même société, sociétés distinctes : aucune interférence", async () => {
    const rs = await Promise.all([
      svc.createBooking(db, A, { equipmentId: eqA, firstDay: d("2028-07-01"), lastDay: d("2028-07-02") }, NOW),
      svc.createBooking(db, A, { equipmentId: eqA, firstDay: d("2028-07-03"), lastDay: d("2028-07-04") }, NOW),
      svc.createBooking(db, A, { equipmentId: eqA2, firstDay: d("2028-07-01"), lastDay: d("2028-07-04") }, NOW),
      svc.createBooking(db, B, { equipmentId: eqB, firstDay: d("2028-07-01"), lastDay: d("2028-07-04") }, NOW),
    ])
    assert.equal(rs.filter((r) => r.ok).length, 4)
    assert.deepEqual(await svc.createBooking(db, B, { equipmentId: eqA, firstDay: d("2028-08-01"), lastDay: d("2028-08-02") }, NOW), { ok: false, error: EQUIPMENT_ERRORS.notFound })
  })
})

describe("M3 — sortie en retard : fin effective (service) et limite du déclencheur (périodes stockées)", () => {
  it("pendant le retard, le service refuse une période après la fin prévue ; après le retour, elle est acceptée", async () => {
    const late = ok(await svc.createBooking(db, A, { equipmentId: eqA2, firstDay: d("2028-09-01"), lastDay: d("2028-09-02") }, NOW)).id // fin stockée : 2028-09-03
    ok(await svc.checkoutBooking(db, A, late, "GOOD", new Date("2028-09-01T08:00:00Z")))
    const during = new Date("2028-09-05T09:00:00Z") // retour en retard : fin effective = maintenant
    assert.deepEqual(await svc.createBooking(db, A, { equipmentId: eqA2, firstDay: d("2028-09-04"), lastDay: d("2028-09-05") }, during), { ok: false, error: EQUIPMENT_ERRORS.overlap })
    ok(await svc.createBooking(db, A, { equipmentId: eqA2, firstDay: d("2028-09-10"), lastDay: d("2028-09-11") }, during)) // après « maintenant » : admis
    // Limite documentée (réserve v3 (2)) : la MÊME période que le service vient de refuser — 09/04→09/05, soit [09/04, 09/06),
    // située entre la fin stockée de la sortie (09/03) et « maintenant » (09/05 09h) — est ACCEPTÉE par une écriture directe :
    // le déclencheur ne compare que les périodes STOCKÉES, pas la fin effective d'une sortie en retard. Suppression avant le retour.
    await db.$executeRawUnsafe(`INSERT INTO equipment_bookings(id,"companyId","equipmentId","startAt","endAt","createdById","updatedAt") VALUES ('m3-direct','coA',$1,'2028-09-04','2028-09-06','uA',now())`, eqA2)
    assert.equal(await db.equipmentBooking.count({ where: { id: "m3-direct", status: "RESERVED" } }), 1, "écriture directe acceptée : limite constatée")
    await db.$executeRawUnsafe(`DELETE FROM equipment_bookings WHERE id = 'm3-direct'`)
    assert.equal(await db.equipmentBooking.count({ where: { id: "m3-direct" } }), 0)
    ok(await svc.returnBooking(db, A, late, { condition: "GOOD" }, new Date("2028-09-05T10:00:00Z")))
    ok(await svc.createBooking(db, A, { equipmentId: eqA2, firstDay: d("2028-09-04"), lastDay: d("2028-09-05") }, new Date("2028-09-05T11:00:00Z")))
  })
})
