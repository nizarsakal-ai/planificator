/**
 * Parcours « partenaire d'acquisition bloquant » contre une vraie base PostgreSQL jetable :
 * refus réel de deleteClient (compte réel via _count), réaffectation / détachement par le service
 * d'administration réel, puis suppression effective. Isolation inter-entreprises vérifiée.
 *
 * Lancé UNIQUEMENT par `tests/clients/pg/client-delete-run.ts test tests/clients/pg/client-partners.pg.test.ts`.
 * Doubles : `@/auth`, `next/cache` ; Prisma réel.
 */
import assert from "node:assert/strict"
import { after, before, beforeEach, describe, it, mock } from "node:test"
import { PrismaClient } from "@prisma/client"

if (process.env.CLIENT_DELETE_RUNNER !== "1") {
  throw new Error("REFUS — à lancer via client-delete-run.ts test (base jetable identifiée)")
}

const real = new PrismaClient()
let revalidated: string[] = []
let session: unknown = null
mock.module("@/auth", { namedExports: { auth: async () => session } })
mock.module("next/cache", { namedExports: { revalidatePath: (p: string) => { revalidated.push(p) } } })

type ClientActions = typeof import("@/lib/actions/client.actions")
type PartnerActions = typeof import("@/lib/actions/client-partners.actions")
let clientActions: ClientActions
let partnerActions: PartnerActions
const suffix = `hp_${Date.now()}`
let companyA = ""
let companyB = ""
let adminA = ""
const asAdmin = (companyId: string, role = "ADMIN") => { session = { user: { id: adminA, role, companyId, email: "a@t.local", name: "A" } } }

describe("partenaire bloquant — base PostgreSQL jetable", () => {
  before(async () => {
    clientActions = await import("@/lib/actions/client.actions")
    partnerActions = await import("@/lib/actions/client-partners.actions")
    const a = await real.company.create({ data: { name: `HP A ${suffix}`, slug: `hpa-${suffix}` } })
    const b = await real.company.create({ data: { name: `HP B ${suffix}`, slug: `hpb-${suffix}` } })
    companyA = a.id; companyB = b.id
    adminA = (await real.user.create({ data: { email: `hpa-${suffix}@t.local`, password: "h", role: "ADMIN", companyId: companyA } })).id
  })
  beforeEach(() => { revalidated = [] })
  after(async () => {
    await real.user.deleteMany({ where: { companyId: { in: [companyA, companyB] } } })
    await real.company.deleteMany({ where: { id: { in: [companyA, companyB] } } })
    await real.$disconnect()
  })

  it("deux clients homonymes : seul celui pointé par le partenaire est bloqué ; réaffectation vers l'homonyme puis suppression", async () => {
    asAdmin(companyA)
    const hall1 = await real.client.create({ data: { name: "HALL EXPO", companyId: companyA, email: "contact@hall.test" } })
    const hall2 = await real.client.create({ data: { name: "HALL EXPO", companyId: companyA } })
    const partner = await real.acquisitionPartner.create({ data: { companyId: companyA, name: "Hall Expo", code: `hall-expo-${suffix}`, clientId: hall1.id } })

    // 1. refus réel (FK composite Restrict + _count)
    const refused = await clientActions.deleteClient(hall1.id)
    assert.equal(refused.error, "Impossible de supprimer : 1 partenaire lié à ce client. Réaffectez ou supprimez d'abord ces éléments.")
    assert.equal(await real.client.count({ where: { id: hall1.id } }), 1)

    // 2. retrouver le partenaire bloquant par id (jamais par nom)
    const linked = await partnerActions.listClientLinkedPartners(hall1.id)
    assert.deepEqual(linked, { partners: [{ id: partner.id, name: "Hall Expo", code: partner.code, active: true }] })
    assert.deepEqual(await partnerActions.listClientLinkedPartners(hall2.id), { partners: [] })
    const targets = await partnerActions.listPartnerReassignTargets(hall1.id)
    assert.ok("targets" in targets && targets.targets.some((t) => t.id === hall2.id))

    // 3. réaffecter vers l'homonyme actif
    assert.deepEqual(await partnerActions.reassignClientPartner(partner.id, hall2.id), { success: true, clientId: hall2.id })
    assert.equal((await real.acquisitionPartner.findUnique({ where: { id: partner.id } }))?.clientId, hall2.id)

    // 4. suppression désormais possible ; l'homonyme et le partenaire subsistent
    revalidated = []
    assert.deepEqual(await clientActions.deleteClient(hall1.id), { success: true })
    assert.equal(await real.client.count({ where: { id: hall1.id } }), 0)
    assert.equal(await real.client.count({ where: { id: hall2.id } }), 1)
    assert.equal(await real.acquisitionPartner.count({ where: { id: partner.id } }), 1)
    assert.deepEqual(revalidated, ["/clients"])

    // 5. l'homonyme est maintenant bloqué à son tour (le partenaire n'a pas été perdu)
    assert.match((await clientActions.deleteClient(hall2.id)).error ?? "", /1 partenaire lié/)
  })

  it("détachement : le partenaire, ses identités (domaine, e-mail) et ses consultations sont préservés ; seule clientId passe à null ; puis suppression du client", async () => {
    asAdmin(companyA)
    const c = await real.client.create({ data: { name: "Détaché", companyId: companyA } })
    const partner = await real.acquisitionPartner.create({
      data: { companyId: companyA, name: "P détaché", code: `det-${suffix}`, clientId: c.id, priority: 7, autoApproveEnabled: true, minConfidence: 0.8 },
    })
    const domain = await real.acquisitionPartnerDomain.create({ data: { companyId: companyA, partnerId: partner.id, domainNormalized: `det-${suffix}.test` } })
    const email = await real.acquisitionPartnerEmail.create({ data: { companyId: companyA, partnerId: partner.id, emailNormalized: `x@det-${suffix}.test` } })
    const consultation = await real.acquisitionMessage.create({
      data: {
        companyId: companyA, source: "GMAIL", externalMessageId: `ext-${suffix}`, senderEmail: `x@det-${suffix}.test`,
        senderDomain: `det-${suffix}.test`, subject: "Consultation", receivedAt: new Date(), resolvedPartnerId: partner.id,
      },
    })
    const before = await real.acquisitionPartner.findUnique({ where: { id: partner.id } })

    assert.deepEqual(await partnerActions.reassignClientPartner(partner.id, null), { success: true, clientId: null })

    const after = await real.acquisitionPartner.findUnique({ where: { id: partner.id } })
    assert.ok(before && after)
    assert.equal(after.clientId, null)
    // Tout le reste du partenaire est intact (policies, priorité, activation, identité)
    const { clientId: _b, updatedAt: _bu, ...restBefore } = before
    const { clientId: _a, updatedAt: _au, ...restAfter } = after
    assert.deepEqual(restAfter, restBefore)
    assert.equal(await real.acquisitionPartnerDomain.count({ where: { id: domain.id, partnerId: partner.id } }), 1)
    assert.equal(await real.acquisitionPartnerEmail.count({ where: { id: email.id, partnerId: partner.id } }), 1)
    assert.equal((await real.acquisitionMessage.findUnique({ where: { id: consultation.id } }))?.resolvedPartnerId, partner.id)

    // Suppression du client ensuite : partenaire et consultation toujours là, toujours liés entre eux
    assert.deepEqual(await clientActions.deleteClient(c.id), { success: true })
    assert.equal(await real.acquisitionPartner.count({ where: { id: partner.id, active: true } }), 1)
    assert.equal((await real.acquisitionMessage.findUnique({ where: { id: consultation.id } }))?.resolvedPartnerId, partner.id)
  })

  it("isolation : l'ADMIN de B ne voit pas le partenaire de A et ne peut ni le réaffecter ni cibler un client de A", async () => {
    const cA = await real.client.create({ data: { name: "A cible", companyId: companyA } })
    const pA = await real.acquisitionPartner.create({ data: { companyId: companyA, name: "P A", code: `pa-${suffix}`, clientId: cA.id } })
    const cB = await real.client.create({ data: { name: "B client", companyId: companyB } })
    const pB = await real.acquisitionPartner.create({ data: { companyId: companyB, name: "P B", code: `pb-${suffix}`, clientId: cB.id } })
    asAdmin(companyB)
    assert.deepEqual(await partnerActions.listClientLinkedPartners(cA.id), { error: "Client introuvable." })
    assert.deepEqual(await partnerActions.reassignClientPartner(pA.id, null), { error: "Partenaire introuvable dans cette entreprise." })
    assert.deepEqual(await partnerActions.reassignClientPartner(pB.id, cA.id), { error: "Client cible introuvable, inactif ou hors de cette entreprise." })
    assert.equal((await real.acquisitionPartner.findUnique({ where: { id: pA.id } }))?.clientId, cA.id)
    assert.equal((await real.acquisitionPartner.findUnique({ where: { id: pB.id } }))?.clientId, cB.id)
    assert.deepEqual(revalidated, [])
  })

  it("identité par clientId + companyId : la lecture et l'écriture sont bornées à l'entreprise de la session (jamais par nom)", async () => {
    asAdmin(companyA)
    const a1 = await real.client.create({ data: { name: "HOMONYME", companyId: companyA } })
    const b1 = await real.client.create({ data: { name: "HOMONYME", companyId: companyB } })
    const pA = await real.acquisitionPartner.create({ data: { companyId: companyA, name: "HOMONYME", code: `hom-a-${suffix}`, clientId: a1.id } })
    const pB = await real.acquisitionPartner.create({ data: { companyId: companyB, name: "HOMONYME", code: `hom-b-${suffix}`, clientId: b1.id } })
    const seen = await partnerActions.listClientLinkedPartners(a1.id)
    assert.ok("partners" in seen)
    assert.deepEqual(seen.partners.map((p) => p.id), [pA.id], "un seul partenaire malgré trois homonymes (client, partenaire, autre entreprise)")
    assert.deepEqual(await partnerActions.reassignClientPartner(pB.id, null), { error: "Partenaire introuvable dans cette entreprise." })
    assert.equal((await real.acquisitionPartner.findUnique({ where: { id: pB.id } }))?.clientId, b1.id)
  })

  it("client cible inactif → refus, le lien d'origine est conservé", async () => {
    asAdmin(companyA)
    const src = await real.client.create({ data: { name: "Source", companyId: companyA } })
    const inactive = await real.client.create({ data: { name: "Inactif", companyId: companyA, active: false } })
    const p = await real.acquisitionPartner.create({ data: { companyId: companyA, name: "P src", code: `src-${suffix}`, clientId: src.id } })
    assert.deepEqual(await partnerActions.reassignClientPartner(p.id, inactive.id), { error: "Client cible introuvable, inactif ou hors de cette entreprise." })
    assert.equal((await real.acquisitionPartner.findUnique({ where: { id: p.id } }))?.clientId, src.id)
  })
})
