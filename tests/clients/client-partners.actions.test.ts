/**
 * Actions « partenaire d'acquisition bloquant » (import réel, doubles @/auth, @/lib/prisma, next/cache).
 * Le service d'administration partenaires est réel : il reçoit le double Prisma via @/lib/prisma.
 * Exécution : npm run test:clients
 */
import assert from "node:assert/strict"
import { beforeEach, describe, it, mock } from "node:test"

type Partner = { id: string; companyId: string; name: string; code: string; active: boolean; clientId: string | null }
type Client = { id: string; companyId: string; name: string; email: string | null; active: boolean }

const partners: Partner[] = []
const clients: Client[] = []
const calls: { key: string; args: unknown }[] = []
let revalidated: string[] = []
let session: unknown = null

function matches(row: Record<string, unknown>, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([k, v]) => {
    if (k === "NOT") return !matches(row, v as Record<string, unknown>)
    return row[k] === v
  })
}
/** Applique la projection `select` comme Prisma (seules les colonnes demandées). */
function project<T extends Record<string, unknown>>(row: T, select?: Record<string, boolean>): Record<string, unknown> {
  if (!select) return { ...row }
  return Object.fromEntries(Object.keys(select).filter((k) => select[k]).map((k) => [k, row[k]]))
}
type Q = { where: Record<string, unknown>; select?: Record<string, boolean> }
const db = {
  client: {
    findFirst: async (args: Q) => { calls.push({ key: "client.findFirst", args }); const r = clients.find((c) => matches(c, args.where)); return r ? project(r, args.select) : null },
    findMany: async (args: Q) => { calls.push({ key: "client.findMany", args }); return clients.filter((c) => matches(c, args.where)).map((c) => project(c, args.select)) },
  },
  acquisitionPartner: {
    findMany: async (args: Q) => { calls.push({ key: "partner.findMany", args }); return partners.filter((p) => matches(p, args.where)).map((p) => project(p, args.select)) },
    findFirst: async (args: Q) => { calls.push({ key: "partner.findFirst", args }); const r = partners.find((p) => matches(p, args.where)); return r ? project(r, args.select) : null },
    updateMany: async (args: { where: Record<string, unknown>; data: Partial<Partner> }) => {
      calls.push({ key: "partner.updateMany", args })
      const rows = partners.filter((p) => matches(p, args.where))
      rows.forEach((p) => Object.assign(p, args.data))
      return { count: rows.length }
    },
  },
  $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(db),
}

mock.module("@/auth", { namedExports: { auth: async () => session } })
mock.module("@/lib/prisma", { namedExports: { prisma: db } })
mock.module("next/cache", { namedExports: { revalidatePath: (p: string) => { revalidated.push(p) } } })

type Actions = typeof import("@/lib/actions/client-partners.actions")
let actions: Actions
const admin = (companyId = "A", role = "ADMIN") => { session = { user: { id: "u1", role, companyId, email: "a@t.local", name: "A" } } }

function seed() {
  partners.length = 0; clients.length = 0; calls.length = 0; revalidated = []
  clients.push(
    { id: "hall-1", companyId: "A", name: "HALL EXPO", email: "contact@hall.fr", active: true },
    { id: "hall-2", companyId: "A", name: "HALL EXPO", email: null, active: true },
    { id: "inactif", companyId: "A", name: "Ancien", email: null, active: false },
    { id: "b-1", companyId: "B", name: "Client B", email: null, active: true },
  )
  partners.push(
    { id: "p-hall", companyId: "A", name: "Hall Expo partenaire", code: "hall-expo", active: true, clientId: "hall-1" },
    { id: "p-autre", companyId: "A", name: "Autre", code: "autre", active: true, clientId: null },
    { id: "p-b", companyId: "B", name: "Partenaire B", code: "pb", active: true, clientId: "b-1" },
  )
}

describe("client-partners.actions — parcours partenaire bloquant", () => {
  beforeEach(async () => { seed(); actions ??= await import("@/lib/actions/client-partners.actions") })

  it("listClientLinkedPartners : seuls les partenaires de l'entreprise pointant ce client, par id", async () => {
    admin()
    const r = await actions.listClientLinkedPartners("hall-1")
    assert.deepEqual(r, { partners: [{ id: "p-hall", name: "Hall Expo partenaire", code: "hall-expo", active: true }] })
    assert.deepEqual((calls.find((c) => c.key === "partner.findMany")!.args as { where: unknown }).where, { clientId: "hall-1", companyId: "A" })
    assert.deepEqual(await actions.listClientLinkedPartners("hall-2"), { partners: [] })
  })

  it("isolation : client d'une autre entreprise → Client introuvable, aucune lecture de partenaires", async () => {
    admin("B")
    assert.deepEqual(await actions.listClientLinkedPartners("hall-1"), { error: "Client introuvable." })
    assert.equal(calls.filter((c) => c.key === "partner.findMany").length, 0)
  })

  it("droits : TEAM_LEADER et EMPLOYEE refusés avant toute lecture ; SUPER_ADMIN accepté", async () => {
    for (const role of ["TEAM_LEADER", "EMPLOYEE"]) {
      admin("A", role); calls.length = 0
      await assert.rejects(() => actions.listClientLinkedPartners("hall-1"), /Accès refusé/)
      await assert.rejects(() => actions.reassignClientPartner("p-hall", null), /Accès refusé/)
      assert.equal(calls.length, 0, role)
    }
    admin("A", "SUPER_ADMIN")
    assert.ok("partners" in (await actions.listClientLinkedPartners("hall-1")))
    session = null
    await assert.rejects(() => actions.listClientLinkedPartners("hall-1"), /Non authentifié/)
  })

  it("listPartnerReassignTargets : clients actifs de l'entreprise sauf le client courant (homonyme inclus, distingué par id/email)", async () => {
    admin()
    const r = await actions.listPartnerReassignTargets("hall-1")
    assert.deepEqual(r, { targets: [{ id: "hall-2", name: "HALL EXPO", email: null }] })
  })

  it("réaffectation vers l'homonyme actif → partenaire déplacé, revalidation ; le client d'origine n'a plus de partenaire", async () => {
    admin()
    assert.deepEqual(await actions.reassignClientPartner("p-hall", "hall-2"), { success: true, clientId: "hall-2" })
    assert.equal(partners.find((p) => p.id === "p-hall")!.clientId, "hall-2")
    // identité par id + companyId à la lecture du partenaire, à la vérification du client cible et à l'écriture
    const w = (k: string) => (calls.find((c) => c.key === k)!.args as { where: Record<string, unknown> }).where
    assert.deepEqual(w("partner.findFirst"), { id: "p-hall", companyId: "A" })
    assert.deepEqual(w("client.findFirst"), { id: "hall-2", companyId: "A", active: true })
    assert.deepEqual(w("partner.updateMany"), { id: "p-hall", companyId: "A" })
    const data = (calls.find((c) => c.key === "partner.updateMany")!.args as { data: unknown }).data
    assert.deepEqual(data, { clientId: "hall-2" }, "seul clientId est écrit : nom, code, policies, activation intacts")
    assert.deepEqual(revalidated, ["/clients"])
    assert.deepEqual(await actions.listClientLinkedPartners("hall-1"), { partners: [] })
  })

  it("détachement (null) → clientId null, revalidation", async () => {
    admin()
    assert.deepEqual(await actions.reassignClientPartner("p-hall", null), { success: true, clientId: null })
    assert.equal(partners.find((p) => p.id === "p-hall")!.clientId, null)
    assert.deepEqual(revalidated, ["/clients"])
  })

  it("refus : client cible inactif ou d'une autre entreprise → erreur explicite, aucune écriture, pas de revalidation", async () => {
    admin()
    for (const target of ["inactif", "b-1", "inexistant"]) {
      calls.length = 0
      const r = await actions.reassignClientPartner("p-hall", target)
      assert.deepEqual(r, { error: "Client cible introuvable, inactif ou hors de cette entreprise." }, target)
      assert.equal(calls.filter((c) => c.key === "partner.updateMany").length, 0, target)
    }
    assert.equal(partners.find((p) => p.id === "p-hall")!.clientId, "hall-1")
    assert.deepEqual(revalidated, [])
  })

  it("refus : partenaire d'une autre entreprise ou inexistant → Partenaire introuvable, aucune écriture", async () => {
    admin()
    for (const id of ["p-b", "nope"]) {
      assert.deepEqual(await actions.reassignClientPartner(id, "hall-2"), { error: "Partenaire introuvable dans cette entreprise." }, id)
    }
    assert.equal(partners.find((p) => p.id === "p-b")!.clientId, "b-1")
    assert.equal(calls.filter((c) => c.key === "partner.updateMany").length, 0)
    assert.deepEqual(revalidated, [])
  })
})
