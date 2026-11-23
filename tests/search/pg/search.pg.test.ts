/**
 * Lot D Planificator V2 : recherche globale sur une base PostgreSQL JETABLE. Aucune fuite entre entreprises (même
 * terme, identifiants forgés), refus par rôle, groupes soumis aux drapeaux de leurs modules, champs affichés minimaux.
 * Réconciliation 12/11 : aucune donnée RH (un salarié homonyme n'apparaît jamais) ; identifiants propres à ce fichier
 * (coSA, coSB…) car les trois fichiers PG du lot D partagent la même base jetable.
 * Exécution : TEST_PG_ADMIN_URL=postgresql://postgres@127.0.0.1:5432/postgres \
 *   sh tests/billing/pg/with-disposable-db.sh search npm run test:search:pg
 */
import assert from "node:assert/strict"
import { after, before, describe, it } from "node:test"
import { PrismaClient } from "@prisma/client"
import { globalSearch } from "@/lib/search/search.service"

const db = new PrismaClient()
const ALL = { billing: true, equipment: true, reserves: true }
const NONE = { billing: false, equipment: false, reserves: false }
const ids = (r: Awaited<ReturnType<typeof globalSearch>>) => r.groups.flatMap((g) => g.hits.map((h) => `${g.group}:${h.id}`)).sort()

before(async () => {
  for (const sqlText of [
    `INSERT INTO companies(id,name,slug,"updatedAt") VALUES ('coSA','A','sa',now()),('coSB','B','sb',now())`,
    `INSERT INTO users(id,email,password,"updatedAt") VALUES ('uSA','sa@search.test','x',now()),('uSB','sb@search.test','x',now())`,
    `INSERT INTO clients(id,"companyId",name,email,"updatedAt") VALUES ('clSA','coSA','Durand Rénovation','contact@durand.test',now()),('clSB','coSB','Durand Bâtiment','b@durand.test',now())`,
    `INSERT INTO worksites(id,"companyId","clientId","createdById",name,address,"updatedAt") VALUES ('wSA','coSA','clSA','uSA','Maison Durand','12 rue des Lilas',now()),('wSB','coSB','clSB','uSB','Atelier Durand','3 rue des Lilas',now())`,
    `INSERT INTO employees(id,"userId","companyId","firstName","lastName","updatedAt") VALUES ('eSA','uSA','coSA','Paul','Durand',now()),('eSB','uSB','coSB','Pierre','Durand',now())`,
    `INSERT INTO articles(id,"companyId",designation,reference,"unitPrice","updatedAt") VALUES ('aSA','coSA','Enduit Durand','DUR-1',10,now()),('aSB','coSB','Enduit Durand B','DUR-1',10,now())`,
    `INSERT INTO quotes(id,"companyId","worksiteId","clientId",number,subject,"createdById","updatedAt") VALUES ('qSA','coSA','wSA','clSA','DEV-2026-0001','Durand façade','uSA',now()),('qSB','coSB','wSB','clSB','DEV-2026-0001','Durand toiture','uSB',now())`,
    `INSERT INTO equipment(id,"companyId",number,name,category,"updatedAt") VALUES ('mSA','coSA','MAT-DUR','Échafaudage Durand','Accès',now()),('mSB','coSB','MAT-DUR','Échafaudage Durand B','Accès',now())`,
  ]) await db.$executeRawUnsafe(sqlText)
})
after(() => db.$disconnect())

describe("recherche globale", () => {
  it("même terme dans deux entreprises : chaque entreprise ne voit que ses lignes", async () => {
    const a = await globalSearch(db, { companyId: "coSA", role: "ADMIN" }, "durand", ALL)
    assert.deepEqual(ids(a), ["articles:aSA", "clients:clSA", "equipment:mSA", "quotes:qSA", "worksites:wSA"])
    const b = await globalSearch(db, { companyId: "coSB", role: "SUPER_ADMIN" }, "DURAND", ALL)
    assert.deepEqual(ids(b), ["articles:aSB", "clients:clSB", "equipment:mSB", "quotes:qSB", "worksites:wSB"])
  })
  it("identifiant ou numéro d'une autre entreprise : introuvable", async () => {
    assert.deepEqual(ids(await globalSearch(db, { companyId: "coSA", role: "ADMIN" }, "Atelier", ALL)), [])
    assert.deepEqual(ids(await globalSearch(db, { companyId: "coSA", role: "ADMIN" }, "toiture", ALL)), [])
    assert.deepEqual(ids(await globalSearch(db, { companyId: "coSZ", role: "ADMIN" }, "durand", ALL)), [])
  })
  it("rôles autres qu'ADMIN / SUPER_ADMIN : aucun résultat, aucune requête", async () => {
    for (const role of ["TEAM_LEADER", "EMPLOYEE", "CLIENT", ""]) assert.deepEqual((await globalSearch(db, { companyId: "coSA", role }, "durand", ALL)).groups, [], role)
  })
  it("drapeaux : devis, matériel et réserves absents si leur module est désactivé", async () => {
    const r = await globalSearch(db, { companyId: "coSA", role: "ADMIN" }, "durand", NONE)
    assert.deepEqual(ids(r), ["articles:aSA", "clients:clSA", "worksites:wSA"])
  })
  it("aucune donnée RH : un salarié nommé « Durand » n'apparaît dans aucun groupe, quels que soient les drapeaux", async () => {
    for (const flags of [ALL, NONE]) {
      const r = await globalSearch(db, { companyId: "coSA", role: "ADMIN" }, "durand", flags)
      assert.ok(r.groups.every((g) => (g.group as string) !== "employees"))
      assert.ok(!ids(r).some((x) => x.endsWith(":eSA") || x.endsWith(":eSB")))
    }
  })
  it("requête trop courte ou réduite à des jokers : aucune requête ; jokers neutralisés", async () => {
    assert.deepEqual((await globalSearch(db, { companyId: "coSA", role: "ADMIN" }, " d ", ALL)).groups, [])
    assert.deepEqual((await globalSearch(db, { companyId: "coSA", role: "ADMIN" }, "%%__", ALL)), { query: null, groups: [] })
    assert.deepEqual(ids(await globalSearch(db, { companyId: "coSA", role: "ADMIN" }, "Du%and", ALL)), [], "le % n'est pas un joker")
  })
  it("résultats : champs d'affichage seulement, liens internes", async () => {
    const r = await globalSearch(db, { companyId: "coSA", role: "ADMIN" }, "durand", ALL)
    for (const g of r.groups) for (const h of g.hits) {
      assert.deepEqual(Object.keys(h).sort(), ["group", "href", "id", "subtitle", "title"])
      assert.match(h.href, /^\/[a-z-]+(\/[A-Za-z0-9_-]+)?$/)
    }
    assert.equal(r.groups.find((g) => g.group === "clients")!.hits[0].subtitle, null, "l'adresse électronique du client n'est pas affichée")
  })
})
