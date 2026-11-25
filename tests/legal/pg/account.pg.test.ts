/**
 * Lot 2b juridique : suppression de compte et export « Mes données » sur une base PostgreSQL JETABLE migrée, avec les
 * VRAIES requêtes Prisma. Aucun appel réseau.
 * Exécution : TEST_PG_ADMIN_URL=postgresql://postgres@127.0.0.1:5432/postgres \
 *   sh tests/billing/pg/with-disposable-db.sh legal npm run test:legal:pg
 */
import assert from "node:assert/strict"
import { after, before, describe, it } from "node:test"
import bcrypt from "bcryptjs"
import { PrismaClient } from "@prisma/client"
import { deleteOwnAccountImpl } from "@/lib/account/account-deletion.core"
import { anonymizeAccount, countOtherAdmins, findAccountForDeletion, prismaAccountDeletionDeps } from "@/lib/account/account-deletion.prisma"
import { buildPersonalDataExport } from "@/lib/account/personal-data-export"
import { collectPersonalData } from "@/lib/account/personal-data-export.prisma"

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL requis (base PostgreSQL jetable migrée)")
const db = new PrismaClient()
const DAY = new Date("2026-11-20T00:00:00.000Z")

async function company(id: string, name: string) {
  await db.company.create({ data: { id, name, slug: `legal-${id}` } })
}
async function user(id: string, role: string, companyId: string | null, password = "x") {
  return db.user.create({ data: { id, email: `${id}@legal.test`, name: id, password, role: role as never, companyId } })
}
async function employee(id: string, userId: string, companyId: string, role = "EMPLOYEE") {
  return db.employee.create({ data: { id, userId, companyId, firstName: id, lastName: "Test", role: role as never, phone: "0600000000", avatarUrl: `https://res.cloudinary.com/demo/image/upload/v1/planificator/${companyId}/avatars/employee-${id}.jpg` } })
}
async function clock(employeeId: string, companyId: string, lat: number) {
  await db.timeclock.create({ data: { employeeId, companyId, date: DAY, checkInAt: DAY, checkInLat: lat, checkInLng: 2.3 } })
}

before(async () => {
  await company("A", "Société A"); await company("B", "Société B"); await company("C", "Société C"); await company("D", "Société D")
  // A : admin « historique » sans fiche (adminLegacy) + admin avec fiche (adminA) ; employé présent dans A et B ; client.
  await user("adminLegacy", "ADMIN", "A")
  await user("adminA", "EMPLOYEE", "A"); await employee("e_adminA", "adminA", "A", "ADMIN")
  await user("multi", "EMPLOYEE", "A", await bcrypt.hash("secret-multi", 4))
  await employee("e_multi_A", "multi", "A"); await employee("e_multi_B", "multi", "B")
  await user("adminB", "EMPLOYEE", "B"); await employee("e_adminB", "adminB", "B", "ADMIN")
  await user("cli", "CLIENT", "A")
  await db.client.create({ data: { id: "client_A", name: "Mairie", companyId: "A", email: "cli@legal.test" } })
  await db.clientProfile.create({ data: { clientId: "client_A", userId: "cli" } })
  // C : deux administrateurs (suppression simultanée). D : sert au test de retour arrière.
  await user("adminC1", "EMPLOYEE", "C"); await employee("e_adminC1", "adminC1", "C", "ADMIN")
  await user("adminC2", "EMPLOYEE", "C"); await employee("e_adminC2", "adminC2", "C", "ADMIN")
  await user("rollback", "EMPLOYEE", "D"); await employee("e_rollback", "rollback", "D")

  await clock("e_multi_A", "A", 48.1); await clock("e_multi_B", "B", 45.7); await clock("e_adminA", "A", 43.3); await clock("e_adminB", "B", 44.4)
  await db.notification.createMany({ data: [
    { userId: "multi", companyId: "A", title: "Planning modifié", message: "Remplace Jean Autre sur Vienne", type: "WORKSITE_UPDATED" },
    { userId: "adminA", companyId: "A", title: "Note de frais", message: "Privé adminA", type: "WORKSITE_UPDATED" },
    { userId: "rollback", companyId: "D", title: "Bienvenue", message: "x", type: "WORKSITE_UPDATED" },
  ] })
})
after(async () => { await db.$disconnect() })

describe("export « Mes données » : cloisonnement", () => {
  it("un employé de deux sociétés reçoit ses données des deux, et seulement les siennes", async () => {
    const out = buildPersonalDataExport((await collectPersonalData(db, "multi"))!)
    const lats = (out.pointages as { checkInLat: number }[]).map((p) => p.checkInLat).sort()
    assert.deepEqual(lats, [45.7, 48.1])
    assert.equal((out.fichesEmploye as unknown[]).length, 2)
    assert.ok(!JSON.stringify(out).includes("43.3") && !JSON.stringify(out).includes("44.4"), "aucun pointage d'un autre compte")
  })
  it("l'admin d'une autre société ne voit rien de cet employé", async () => {
    const out = JSON.stringify(buildPersonalDataExport((await collectPersonalData(db, "adminB"))!))
    assert.ok(out.includes("44.4"))
    assert.ok(!out.includes("45.7") && !out.includes("48.1"))
  })
  it("notifications : titre et date seulement (pas le message, qui peut citer un tiers)", async () => {
    const out = buildPersonalDataExport((await collectPersonalData(db, "multi"))!)
    assert.equal(JSON.stringify(out).includes("Jean Autre"), false)
    assert.deepEqual(Object.keys((out.notifications as Record<string, unknown>[])[0]).sort(), ["createdAt", "title"])
    assert.equal(JSON.stringify(out).includes("password"), false)
  })
  it("compte inconnu : rien", async () => {
    assert.equal(await collectPersonalData(db, "inconnu"), null)
  })
})

describe("suppression de compte : règles sur la vraie base", () => {
  it("admin historique sans fiche : reconnu admin de sa société, l'autre admin compte", async () => {
    const acc = await findAccountForDeletion(db, "adminLegacy")
    assert.deepEqual(acc?.adminCompanies, [{ id: "A", name: "Société A" }])
    assert.equal(await countOtherAdmins(db, { companyId: "A", userId: "adminLegacy" }), 1)
    assert.equal(await countOtherAdmins(db, { companyId: "A", userId: "adminA" }), 1)
  })
  it("dernier administrateur : refusé, rien n'est écrit", async () => {
    const acc = await findAccountForDeletion(db, "adminB")
    assert.deepEqual(acc?.adminCompanies, [{ id: "B", name: "Société B" }])
    const outcome = await anonymizeAccount(db, "adminB", acc!.adminCompanies)
    assert.deepEqual(outcome, { ok: false, lastAdminCompanies: ["Société B"] })
    const u = await db.user.findUniqueOrThrow({ where: { id: "adminB" } })
    assert.equal(u.active, true); assert.equal(u.email, "adminB@legal.test")
  })
  it("admin historique supprimé, puis l'autre admin devient le dernier et est bloqué", async () => {
    const legacy = await findAccountForDeletion(db, "adminLegacy")
    assert.equal((await anonymizeAccount(db, "adminLegacy", legacy!.adminCompanies)).ok, true)
    assert.equal(await countOtherAdmins(db, { companyId: "A", userId: "adminA" }), 0)
    const a = await findAccountForDeletion(db, "adminA")
    assert.deepEqual(await anonymizeAccount(db, "adminA", a!.adminCompanies), { ok: false, lastAdminCompanies: ["Société A"] })
  })
  it("deux admins qui se suppriment en même temps : un seul y parvient, la société garde un admin", async () => {
    const [c1, c2] = await Promise.all([findAccountForDeletion(db, "adminC1"), findAccountForDeletion(db, "adminC2")])
    const results = await Promise.all([anonymizeAccount(db, "adminC1", c1!.adminCompanies), anonymizeAccount(db, "adminC2", c2!.adminCompanies)])
    assert.equal(results.filter((r) => r.ok).length, 1)
    assert.equal(results.filter((r) => !r.ok).length, 1)
    const activeAdmins = await db.user.count({ where: { active: true, employeeProfiles: { some: { companyId: "C", role: "ADMIN", active: true } } } })
    assert.equal(activeAdmins, 1)
  })
  it("employé de deux sociétés : identité effacée, fiches désactivées, données légales gardées, une trace par société", async () => {
    const deleted: string[][] = []
    const deps = prismaAccountDeletionDeps(db, async () => "multi", async (urls) => { deleted.push(urls) })
    assert.deepEqual((await deleteOwnAccountImpl({ password: "faux", confirmation: "SUPPRIMER" }, deps)).ok, false)
    assert.equal((await db.user.findUniqueOrThrow({ where: { id: "multi" } })).active, true, "mauvais mot de passe : aucun effet")

    assert.deepEqual(await deleteOwnAccountImpl({ password: "secret-multi", confirmation: "SUPPRIMER" }, deps), { ok: true })
    const u = await db.user.findUniqueOrThrow({ where: { id: "multi" } })
    assert.equal(u.active, false); assert.equal(u.name, null); assert.equal(u.email, "compte-supprime-multi@supprime.invalid")
    assert.equal(await bcrypt.compare("secret-multi", u.password), false)
    const emps = await db.employee.findMany({ where: { userId: "multi" }, orderBy: { id: "asc" } })
    assert.deepEqual(emps.map((e) => [e.active, e.phone, e.avatarUrl]), [[false, null, null], [false, null, null]])
    assert.equal(await db.timeclock.count({ where: { employeeId: { in: ["e_multi_A", "e_multi_B"] } } }), 2, "heures gardées pour l'employeur")
    assert.equal(await db.notification.count({ where: { userId: "multi" } }), 0)
    const traces = await db.historyLog.findMany({ where: { entityType: "AccountDeletion", entityId: "multi" }, orderBy: { companyId: "asc" } })
    assert.deepEqual(traces.map((t) => t.companyId), ["A", "B"])
    assert.equal(deleted.length, 1); assert.equal(deleted[0].length, 2, "les deux photos sont envoyées à l'effacement")
  })
  it("compte CLIENT : accès à l'espace client retiré, fiche client de la société conservée", async () => {
    assert.equal((await anonymizeAccount(db, "cli", [])).ok, true)
    assert.equal(await db.clientProfile.count({ where: { userId: "cli" } }), 0)
    assert.equal(await db.client.count({ where: { id: "client_A" } }), 1)
  })
  it("échec en cours de route : retour arrière complet", async () => {
    await assert.rejects(anonymizeAccount(db, "rollback", [], { onStep: (s) => { if (s === "links") throw new Error("panne simulée") } }), /panne simulée/)
    const u = await db.user.findUniqueOrThrow({ where: { id: "rollback" } })
    assert.equal(u.active, true); assert.equal(u.email, "rollback@legal.test"); assert.equal(u.name, "rollback")
    const e = await db.employee.findUniqueOrThrow({ where: { id: "e_rollback" } })
    assert.equal(e.active, true); assert.equal(e.phone, "0600000000")
    assert.equal(await db.notification.count({ where: { userId: "rollback" } }), 1)
    assert.equal(await db.historyLog.count({ where: { entityId: "rollback" } }), 0)
  })
})
