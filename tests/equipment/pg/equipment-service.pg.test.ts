/**
 * Lot B Planificator V2 : service du matériel et de la location sur une base PostgreSQL JETABLE migrée (jamais une
 * base réelle). Flux complets (réservation, sortie, retour, contrat, clôture, entretien), pas de double réservation
 * (y compris en concurrence), isolation entre deux entreprises (lecture, écriture, identifiant forgé), contraintes de
 * la base (CHECK, clés composites), audit et numérotation.
 * Exécution : TEST_PG_ADMIN_URL=postgresql://postgres@127.0.0.1:5432/postgres \
 *   sh tests/billing/pg/with-disposable-db.sh equipment npm run test:equipment:pg
 */
import assert from "node:assert/strict"
import { after, before, describe, it } from "node:test"
import { PrismaClient } from "@prisma/client"
import * as svc from "@/lib/equipment/equipment.service"
import { EQUIPMENT_ERRORS, parseDay } from "@/lib/equipment/equipment.core"
import { equipmentCostsByWorksite, getEquipment } from "@/lib/equipment/queries"

const db = new PrismaClient()
const A = { companyId: "coA", userId: "uA" }
const B = { companyId: "coB", userId: "uB" }
const NOW = new Date("2026-11-04T09:00:00Z")
const AFTER = new Date("2026-11-13T10:00:00Z")
const d = (s: string) => parseDay(s)!
const ok = <T>(r: svc.EquipmentResult<T>): T => { assert.ok(r.ok, r.ok ? "" : r.error); return (r as { ok: true; value: T }).value }
let owned = "", rented = "", ownedB = "", booking = "", contract = ""

before(async () => {
  for (const sqlText of [
    `INSERT INTO companies(id,name,slug,"updatedAt") VALUES ('coA','A','a',now()),('coB','B','b',now())`,
    `INSERT INTO users(id,email,password,"updatedAt") VALUES ('uA','a@x.test','x',now()),('uB','b@x.test','x',now())`,
    `INSERT INTO clients(id,"companyId",name,"updatedAt") VALUES ('clA','coA','ClA',now()),('clB','coB','ClB',now())`,
    `INSERT INTO worksites(id,"companyId","clientId","createdById",name,"updatedAt") VALUES ('wA','coA','clA','uA','Chantier A',now()),('wB','coB','clB','uB','Chantier B',now())`,
    `INSERT INTO worksites(id,"companyId","clientId","createdById",name,"archivedAt","updatedAt") VALUES ('wArch','coA','clA','uA','Chantier archivé',now(),now())`,
    `INSERT INTO employees(id,"userId","companyId","firstName","lastName","updatedAt") VALUES ('eA','uA','coA','Ana','Martin',now()),('eB','uB','coB','Bob','Durand',now())`,
    `INSERT INTO suppliers(id,"companyId",name,"updatedAt") VALUES ('supA','coA','Loueur A',now()),('supA2','coA','Autre loueur',now()),('supB','coB','Loueur B',now())`,
    `INSERT INTO warehouses(id,"companyId",name,"updatedAt") VALUES ('whA','coA','Dépôt central',now()),('whB','coB','Dépôt B',now())`,
  ]) await db.$executeRawUnsafe(sqlText)
  owned = ok(await svc.createEquipment(db, A, { number: "MAT-001", name: "Bétonnière 350 L", category: "Gros œuvre", ownership: "OWNED", warehouseId: "whA", dailyCostCents: 2500 })).id
  rented = ok(await svc.createEquipment(db, A, { number: "LOC-NAC-1", name: "Nacelle 12 m", category: "Élévation", ownership: "RENTED" })).id
  ownedB = ok(await svc.createEquipment(db, B, { number: "MAT-001", name: "Bétonnière B", category: "Gros œuvre", ownership: "OWNED" })).id
})
after(() => db.$disconnect())

describe("équipements", () => {
  it("numéro unique par entreprise, réutilisable dans une autre ; dépôt d'une autre entreprise refusé", async () => {
    assert.deepEqual(await svc.createEquipment(db, A, { number: "MAT-001", name: "x", category: "y", ownership: "OWNED" }), { ok: false, error: EQUIPMENT_ERRORS.duplicateNumber })
    assert.deepEqual(await svc.createEquipment(db, A, { number: "MAT-099", name: "x", category: "y", ownership: "OWNED", warehouseId: "whB" }), { ok: false, error: EQUIPMENT_ERRORS.notFound })
    assert.equal(await db.historyLog.count({ where: { companyId: "coA", entityType: "Equipment", action: "CREATED" } }), 2)
  })
})

describe("réservations, sortie et retour", () => {
  it("réservation sur un chantier avec responsable et caution ; double réservation refusée ; contiguë acceptée", async () => {
    booking = ok(await svc.createBooking(db, A, { equipmentId: owned, firstDay: d("2026-11-04"), lastDay: d("2026-11-06"), worksiteId: "wA", responsibleEmployeeId: "eA", depositCents: 50000 }, NOW)).id
    assert.deepEqual(await svc.createBooking(db, A, { equipmentId: owned, firstDay: d("2026-11-06"), lastDay: d("2026-11-08") }, NOW), { ok: false, error: EQUIPMENT_ERRORS.overlap })
    ok(await svc.createBooking(db, A, { equipmentId: owned, firstDay: d("2026-11-07"), lastDay: d("2026-11-08") }, NOW))
    const audit = await db.historyLog.findFirst({ where: { entityType: "EquipmentBooking", entityId: booking }, select: { worksiteId: true, actorId: true } })
    assert.deepEqual(audit, { worksiteId: "wA", actorId: "uA" })
  })
  it("chantier archivé, chantier ou responsable d'une autre entreprise : refusés sans écriture", async () => {
    const before = await db.equipmentBooking.count()
    const audits = await db.historyLog.count()
    for (const extra of [{ worksiteId: "wArch" }, { worksiteId: "wB" }, { responsibleEmployeeId: "eB" }]) {
      assert.deepEqual(await svc.createBooking(db, A, { equipmentId: owned, firstDay: d("2026-12-01"), lastDay: d("2026-12-02"), ...extra }, NOW), { ok: false, error: EQUIPMENT_ERRORS.notFound }, JSON.stringify(extra))
    }
    assert.equal(await db.equipmentBooking.count(), before)
    assert.equal(await db.historyLog.count(), audits, "rollback complet : aucun audit d'une écriture refusée")
  })
  it("annulation : la période est libérée et peut être réservée de nouveau ; réservation annulée non sortable", async () => {
    const x = ok(await svc.createBooking(db, A, { equipmentId: owned, firstDay: d("2027-02-01"), lastDay: d("2027-02-03") }, NOW)).id
    ok(await svc.cancelBooking(db, A, x))
    assert.equal((await db.equipmentBooking.findUnique({ where: { id: x }, select: { status: true } }))?.status, "CANCELLED")
    ok(await svc.createBooking(db, A, { equipmentId: owned, firstDay: d("2027-02-02"), lastDay: d("2027-02-04") }, NOW))
    assert.deepEqual(await svc.checkoutBooking(db, A, x, "GOOD", NOW), { ok: false, error: EQUIPMENT_ERRORS.notReserved })
    assert.deepEqual(await svc.cancelBooking(db, A, x), { ok: false, error: EQUIPMENT_ERRORS.notReserved })
  })
  it("concurrence : deux réservations simultanées chevauchantes ⇒ une seule réussit", async () => {
    // v5 (preuve VM B r4, 11-test-equipment-pg:82) : l'ancien comptage « début >= 10/12 » incluait la réservation de février
    // 2027 du test d'annulation. Oracle BORNÉ au scénario : fenêtre exacte [10/12, 14/12[, identifiant du gagnant, aucune
    // écriture ni audit du perdant (totaux avant/après sur toute la table, donc rien n'est exclu).
    const fenetre = { equipmentId: owned, startAt: { lt: d("2026-12-14") }, endAt: { gt: d("2026-12-10") } }
    assert.equal(await db.equipmentBooking.count({ where: fenetre }), 0, "fenêtre du scénario vide au départ")
    const total0 = await db.equipmentBooking.count()
    const audits0 = await db.historyLog.count({ where: { entityType: "EquipmentBooking", action: "CREATED" } })
    const [r1, r2] = await Promise.all([
      svc.createBooking(db, A, { equipmentId: owned, firstDay: d("2026-12-10"), lastDay: d("2026-12-12") }, NOW),
      svc.createBooking(db, A, { equipmentId: owned, firstDay: d("2026-12-11"), lastDay: d("2026-12-13") }, NOW),
    ])
    assert.equal([r1, r2].filter((r) => r.ok).length, 1)
    assert.deepEqual([r1, r2].find((r) => !r.ok), { ok: false, error: EQUIPMENT_ERRORS.overlap })
    const gagnant = ok([r1, r2].find((r) => r.ok)!).id
    const dansFenetre = await db.equipmentBooking.findMany({ where: fenetre, select: { id: true, status: true } })
    assert.deepEqual(dansFenetre, [{ id: gagnant, status: "RESERVED" }], "une seule réservation du scénario : celle du gagnant")
    assert.equal(await db.equipmentBooking.count(), total0 + 1, "aucune écriture du perdant")
    assert.equal(await db.historyLog.count({ where: { entityType: "EquipmentBooking", action: "CREATED" } }), audits0 + 1, "un seul audit de création")
    assert.equal(await db.historyLog.count({ where: { entityType: "EquipmentBooking", action: "CREATED", entityId: gagnant } }), 1)
  })
  it("sortie puis retour endommagé : états constatés, équipement en entretien, audit de chaque étape", async () => {
    ok(await svc.checkoutBooking(db, A, booking, "GOOD", NOW))
    assert.deepEqual(await db.equipment.findUnique({ where: { id: owned }, select: { status: true, condition: true } }), { status: "OUT", condition: "GOOD" })
    assert.deepEqual(await svc.checkoutBooking(db, A, booking, "GOOD", NOW), { ok: false, error: EQUIPMENT_ERRORS.notReserved })
    const back = new Date("2026-11-06T16:00:00Z")
    assert.deepEqual(ok(await svc.returnBooking(db, A, booking, { condition: "DAMAGED", notes: "Cuve fissurée" }, back)), { nextStatus: "MAINTENANCE" })
    const b = await db.equipmentBooking.findUnique({ where: { id: booking }, select: { status: true, checkoutCondition: true, returnCondition: true, returnNotes: true, returnedAt: true } })
    assert.deepEqual(b, { status: "RETURNED", checkoutCondition: "GOOD", returnCondition: "DAMAGED", returnNotes: "Cuve fissurée", returnedAt: back })
    assert.deepEqual(await db.equipment.findUnique({ where: { id: owned }, select: { status: true, condition: true } }), { status: "MAINTENANCE", condition: "DAMAGED" })
    assert.equal(await db.historyLog.count({ where: { entityType: "EquipmentBooking", entityId: booking, action: "STATUS_CHANGED" } }), 2)
  })
  it("en entretien : sortie refusée ; remise en service puis sortie possible", async () => {
    const next = await db.equipmentBooking.findFirst({ where: { equipmentId: owned, status: "RESERVED" }, orderBy: { startAt: "asc" }, select: { id: true } })
    assert.deepEqual(await svc.checkoutBooking(db, A, next!.id, "WORN", NOW), { ok: false, error: EQUIPMENT_ERRORS.unavailable })
    ok(await svc.setEquipmentStatus(db, A, owned, "AVAILABLE"))
    assert.deepEqual(await svc.setEquipmentStatus(db, A, owned, "OUT"), { ok: false, error: EQUIPMENT_ERRORS.invalidStatusChange })
  })
  it("isolation : une autre entreprise ne lit ni n'agit sur les réservations ou équipements de A (identifiant forgé)", async () => {
    assert.equal(await getEquipment(db, "coB", owned), null)
    assert.deepEqual(await svc.cancelBooking(db, B, booking), { ok: false, error: EQUIPMENT_ERRORS.notFound })
    assert.deepEqual(await svc.checkoutBooking(db, B, booking, "GOOD", NOW), { ok: false, error: EQUIPMENT_ERRORS.notFound })
    assert.deepEqual(await svc.setEquipmentStatus(db, B, owned, "RETIRED"), { ok: false, error: EQUIPMENT_ERRORS.notFound })
    assert.deepEqual(await svc.createBooking(db, B, { equipmentId: owned, firstDay: d("2027-01-01"), lastDay: d("2027-01-02") }, NOW), { ok: false, error: EQUIPMENT_ERRORS.notFound })
    assert.deepEqual(await svc.createBooking(db, A, { equipmentId: ownedB, firstDay: d("2027-01-01"), lastDay: d("2027-01-02") }, NOW), { ok: false, error: EQUIPMENT_ERRORS.notFound })
  })
})

describe("location : contrat, couverture, clôture et imputation au chantier", () => {
  it("équipement loué : réservation refusée sans contrat ; contrat numéroté chez un loueur de l'entreprise", async () => {
    assert.deepEqual(await svc.createBooking(db, A, { equipmentId: rented, firstDay: d("2026-11-10"), lastDay: d("2026-11-12") }, NOW), { ok: false, error: EQUIPMENT_ERRORS.notCovered })
    assert.deepEqual(await svc.createRentalContract(db, A, { equipmentId: rented, supplierId: "supB", startDate: d("2026-11-05"), endDate: d("2026-11-20"), dailyRateCents: 4500 }), { ok: false, error: EQUIPMENT_ERRORS.notFound })
    assert.deepEqual(await svc.createRentalContract(db, A, { equipmentId: owned, supplierId: "supA", startDate: d("2026-11-05"), endDate: d("2026-11-20"), dailyRateCents: 4500 }), { ok: false, error: EQUIPMENT_ERRORS.notRented })
    const c = ok(await svc.createRentalContract(db, A, { equipmentId: rented, supplierId: "supA", worksiteId: "wA", startDate: d("2026-11-05"), endDate: d("2026-11-20"), dailyRateCents: 4500, fixedFeesCents: 8000 }))
    contract = c.id
    assert.match(c.number, /^LOC-\d{4}-0001$/)
    assert.deepEqual(await svc.createRentalContract(db, A, { equipmentId: rented, supplierId: "supA", startDate: d("2026-11-20"), endDate: d("2026-11-25"), dailyRateCents: 1 }), { ok: false, error: EQUIPMENT_ERRORS.contractOverlap })
  })
  it("réservation couverte acceptée ; à cheval sur la fin du contrat refusée", async () => {
    const b = ok(await svc.createBooking(db, A, { equipmentId: rented, firstDay: d("2026-11-06"), lastDay: d("2026-11-08"), worksiteId: "wA" }, NOW)).id
    assert.deepEqual(await svc.createBooking(db, A, { equipmentId: rented, firstDay: d("2026-11-19"), lastDay: d("2026-11-21") }, NOW), { ok: false, error: EQUIPMENT_ERRORS.notCovered })
    ok(await svc.checkoutBooking(db, A, b, "GOOD", new Date("2026-11-06T07:00:00Z")))
    assert.deepEqual(await svc.closeRentalContract(db, A, contract, d("2026-11-12"), AFTER), { ok: false, error: EQUIPMENT_ERRORS.stillOut })
    ok(await svc.returnBooking(db, A, b, { condition: "GOOD" }, new Date("2026-11-08T17:00:00Z")))
  })
  it("clôture : coût figé au centime (jours réels × tarif + frais) et imputé au chantier ; coût visible par chantier", async () => {
    assert.deepEqual(await svc.closeRentalContract(db, A, contract, d("2026-11-12"), NOW), { ok: false, error: EQUIPMENT_ERRORS.returnInFuture })
    const r = ok(await svc.closeRentalContract(db, A, contract, d("2026-11-12"), AFTER))
    assert.equal(r.costCents, BigInt("8") * BigInt("4500") + BigInt("8000"))
    assert.deepEqual(await db.equipmentRentalContract.findUnique({ where: { id: contract }, select: { status: true, costCents: true, worksiteId: true } }), { status: "CLOSED", costCents: BigInt("44000"), worksiteId: "wA" })
    assert.deepEqual(await svc.closeRentalContract(db, A, contract, d("2026-11-13"), AFTER), { ok: false, error: EQUIPMENT_ERRORS.contractNotActive })
    const costs = await equipmentCostsByWorksite(db, "coA")
    const wA = costs.find((c) => c.worksiteId === "wA")!
    assert.equal(wA.rentalActualCents, BigInt("44000"))
    assert.equal(wA.ownedCents, BigInt("3") * BigInt("2500"), "bétonnière propre : sortie le 04 à 9 h, rendue le 06 à 16 h ⇒ 3 jours entamés × 25 €")
    assert.deepEqual(await equipmentCostsByWorksite(db, "coB"), [], "rien de A n'apparaît chez B")
  })
  it("facture du loueur : autre fournisseur refusé, même fournisseur lié ; audit", async () => {
    await db.$executeRawUnsafe(`INSERT INTO supplier_invoices(id,"companyId","supplierId","supplierName",number,date,"totalHTCents","vatCents","totalTTCCents","createdById","updatedAt") VALUES
      ('siA','coA','supA','Loueur A','L-77','2026-11-13',44000,8800,52800,'uA',now()),('siX','coA','supA2','Autre loueur','X-1','2026-11-13',1,0,1,'uA',now())`)
    assert.deepEqual(await svc.linkRentalInvoice(db, A, contract, "siX"), { ok: false, error: EQUIPMENT_ERRORS.supplierInvoiceMismatch })
    ok(await svc.linkRentalInvoice(db, A, contract, "siA"))
    assert.deepEqual(await svc.linkRentalInvoice(db, B, contract, null), { ok: false, error: EQUIPMENT_ERRORS.notFound })
    assert.equal((await db.equipmentRentalContract.findUnique({ where: { id: contract }, select: { supplierInvoiceId: true } }))?.supplierInvoiceId, "siA")
  })
})

describe("fiche et rapprochement", () => {
  it("modification de la fiche (dépôt, coût interne) auditée ; dépôt d'une autre entreprise refusé ; contrat annulé non rapprochable", async () => {
    ok(await svc.updateEquipment(db, A, owned, { name: "Bétonnière 350 L", category: "Gros œuvre", warehouseId: null, dailyCostCents: 3000 }))
    assert.deepEqual(await db.equipment.findUnique({ where: { id: owned }, select: { warehouseId: true, dailyCostCents: true, number: true } }), { warehouseId: null, dailyCostCents: 3000, number: "MAT-001" })
    assert.deepEqual(await svc.updateEquipment(db, A, owned, { name: "x", category: "y", warehouseId: "whB" }), { ok: false, error: EQUIPMENT_ERRORS.notFound })
    assert.deepEqual(await svc.updateEquipment(db, B, owned, { name: "x", category: "y" }), { ok: false, error: EQUIPMENT_ERRORS.notFound })
    const k = ok(await svc.createRentalContract(db, A, { equipmentId: rented, supplierId: "supA", startDate: d("2027-03-01"), endDate: d("2027-03-05"), dailyRateCents: 1000 })).id
    ok(await svc.cancelRentalContract(db, A, k, NOW))
    assert.deepEqual(await svc.linkRentalInvoice(db, A, k, "siA"), { ok: false, error: EQUIPMENT_ERRORS.contractCancelled })
  })
})

describe("entretien", () => {
  it("planifié puis réalisé ; prestataire d'une autre entreprise refusé", async () => {
    const m = ok(await svc.recordMaintenance(db, A, { equipmentId: owned, description: "Remplacement de la cuve", plannedOn: d("2026-11-09") })).id
    assert.deepEqual(await svc.recordMaintenance(db, A, { equipmentId: owned, description: "x", plannedOn: d("2026-11-09"), supplierId: "supB" }), { ok: false, error: EQUIPMENT_ERRORS.notFound })
    ok(await svc.completeMaintenance(db, A, m, { performedOn: d("2026-11-10"), costCents: 32000 }))
    assert.deepEqual(await svc.completeMaintenance(db, A, m, { performedOn: d("2026-11-11") }), { ok: false, error: "Cet entretien est déjà réalisé." })
    assert.deepEqual(await db.equipmentMaintenance.findUnique({ where: { id: m }, select: { performedOn: true, costCents: true } }), { performedOn: d("2026-11-10"), costCents: 32000 })
  })
})

describe("la base porte les invariants (écriture directe hors service)", () => {
  it("CHECK : période vide, retour sans sortie, contrat clôturé sans coût ⇒ refusés", async () => {
    await assert.rejects(db.$executeRawUnsafe(`INSERT INTO equipment_bookings(id,"companyId","equipmentId","startAt","endAt","createdById","updatedAt") VALUES ('x1','coA','${owned}','2027-01-02','2027-01-02','uA',now())`))
    await assert.rejects(db.$executeRawUnsafe(`INSERT INTO equipment_bookings(id,"companyId","equipmentId","startAt","endAt",status,"returnedAt","returnCondition","createdById","updatedAt") VALUES ('x2','coA','${owned}','2027-01-02','2027-01-03','RETURNED',now(),'GOOD','uA',now())`))
    await assert.rejects(db.$executeRawUnsafe(`UPDATE equipment_rental_contracts SET "costCents" = NULL WHERE id = '${contract}'`))
  })
  it("clés composites : un équipement de B ne peut pas être rattaché à une réservation ou un contrat de A", async () => {
    await assert.rejects(db.$executeRawUnsafe(`INSERT INTO equipment_bookings(id,"companyId","equipmentId","startAt","endAt","createdById","updatedAt") VALUES ('x3','coA','${ownedB}','2027-01-02','2027-01-03','uA',now())`))
    await assert.rejects(db.$executeRawUnsafe(`INSERT INTO equipment_bookings(id,"companyId","equipmentId","worksiteId","startAt","endAt","createdById","updatedAt") VALUES ('x4','coA','${owned}','wB','2027-01-02','2027-01-03','uA',now())`))
    await assert.rejects(db.$executeRawUnsafe(`UPDATE equipment SET "warehouseId" = 'whB' WHERE id = '${owned}'`))
  })
})
