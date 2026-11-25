/**
 * Retrait d'une société qui partage une adresse Gmail avec une autre (cas Noisac / GALYA EVENTS),
 * sur une base PostgreSQL JETABLE migrée, avec boîtes et jetons fictifs. Aucun appel réseau.
 * Exécution : TEST_PG_ADMIN_URL=… sh tests/billing/pg/with-disposable-db.sh removal npm run test:company-removal:pg
 */
import assert from "node:assert/strict"
import { after, before, describe, it } from "node:test"
import { PrismaClient } from "@prisma/client"
import { PrismaAcquisitionGmailConnectionListingAdapter } from "@/lib/acquisition/persistence/acquisition-gmail-connection.listing.adapter"

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL requis (base PostgreSQL jetable migrée)")
const host = new URL(process.env.DATABASE_URL).hostname
if (!["localhost", "127.0.0.1", "[::1]"].includes(host)) throw new Error("base locale jetable uniquement")

const db = new PrismaClient()
const SHARED = "boite-partagee-fictive@example.test"
const A = "rmGalya" // société conservée (rôle de GALYA EVENTS)
const B = "rmNoisacCompta" // société à retirer, avec comptabilité
const C = "rmNoisacVide" // société à retirer, sans données bloquantes
const fetchCalls: string[] = []
const realFetch = globalThis.fetch

async function company(id: string) {
  await db.company.create({ data: { id, name: `Société ${id}`, slug: `slug-${id.toLowerCase()}` } })
}
async function mailbox(companyId: string, gmailAddress: string) {
  return db.acquisitionGmailConnection.create({
    data: { companyId, gmailAddress, accessToken: `acc-${companyId}`, refreshToken: `ref-${companyId}`, tokenExpiry: new Date(), connectedById: "rmUser" },
  })
}
async function message(companyId: string, mailboxKey: string) {
  return db.acquisitionMessage.create({
    data: { companyId, source: "GMAIL", sourceMailboxKey: mailboxKey, externalMessageId: "msg-commun-fictif", senderEmail: "x@partenaire.test", senderDomain: "partenaire.test", subject: "fictif", receivedAt: new Date() },
  })
}

let connA = ""
before(async () => {
  globalThis.fetch = (async (input: unknown) => { fetchCalls.push(String(input)); throw new Error("réseau interdit") }) as typeof fetch
  for (const id of [A, B, C]) await company(id)
  // Super-admin rattaché à A ; administrateur avec profils dans A et C, compte principal sur C.
  await db.user.create({ data: { id: "rmSuper", email: "super@x.test", password: "x", role: "SUPER_ADMIN", companyId: A } })
  await db.user.create({ data: { id: "rmUser", email: "admin@x.test", password: "x", role: "ADMIN", companyId: C } })
  for (const companyId of [A, C]) await db.employee.create({ data: { companyId, userId: "rmUser", firstName: "A", lastName: "B", role: "ADMIN" } })
  connA = (await mailbox(A, SHARED)).id
  for (const companyId of [B, C]) { const c = await mailbox(companyId, SHARED); await message(companyId, c.id) }
  await message(A, connA)
  await db.fiscalYear.create({ data: { companyId: B, startDate: new Date("2026-01-01"), endDate: new Date("2026-12-31") } })
})
after(async () => { globalThis.fetch = realFetch; await db.$disconnect() })

describe("retrait d'une société partageant une adresse Gmail", () => {
  it("désactiver une société ne retire pas ses boîtes de la synchronisation (seul connection.active compte)", async () => {
    await db.company.update({ where: { id: C }, data: { active: false } })
    const listed = await new PrismaAcquisitionGmailConnectionListingAdapter(db).listActiveAcquisitionGmailConnections()
    assert.ok(listed.some((c) => c.companyId === C), "boîte d'une société désactivée toujours listée")
  })

  it("société avec comptabilité : suppression refusée par la base (Restrict), rien n'est supprimé", async () => {
    await assert.rejects(db.company.delete({ where: { id: B } }), (e: { code?: string }) => e.code === "P2003")
    assert.equal(await db.acquisitionGmailConnection.count({ where: { companyId: B } }), 1)
    assert.equal(await db.acquisitionMessage.count({ where: { companyId: B } }), 1)
  })

  it("suppression d'une société sans données bloquantes : ses boîtes et messages partent, ceux de A restent intacts", async () => {
    await db.company.delete({ where: { id: C } })
    assert.equal(await db.acquisitionGmailConnection.count({ where: { companyId: C } }), 0)
    assert.equal(await db.acquisitionMessage.count({ where: { companyId: C } }), 0)
    const kept = await db.acquisitionGmailConnection.findUniqueOrThrow({ where: { id: connA } })
    assert.deepEqual([kept.gmailAddress, kept.refreshToken, kept.active], [SHARED, `ref-${A}`, true])
    assert.equal(await db.acquisitionMessage.count({ where: { companyId: A } }), 1)
  })

  it("comptes : le profil dans la société supprimée part, le compte reste et garde son profil dans A ; super-admin intact", async () => {
    const user = await db.user.findUniqueOrThrow({ where: { id: "rmUser" }, include: { employeeProfiles: true } })
    assert.equal(user.companyId, null, "compte principal remis à vide (SetNull)")
    assert.deepEqual(user.employeeProfiles.map((p) => p.companyId), [A])
    const sup = await db.user.findUniqueOrThrow({ where: { id: "rmSuper" } })
    assert.equal(sup.companyId, A)
  })

  it("aucun appel réseau : la suppression ne révoque aucune autorisation chez Google", () => {
    assert.deepEqual(fetchCalls, [])
  })
})
