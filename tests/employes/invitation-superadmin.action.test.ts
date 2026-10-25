/**
 * Invitation supervisée — tests de l'ACTION RÉELLE `inviterMembre` (src/lib/actions/invitation.actions.ts).
 *
 * Patron : mock.module + import dynamique (cf. tests/clients/client-delete.test.ts). Doubles : `@/auth` (session),
 * `@/lib/prisma` (client enregistreur dont `$transaction(fn)` exécute `fn` avec un `tx` journalisé et simule le
 * rollback en propageant l'erreur), `next/cache` (revalidatePath), `@/lib/email` (sendInvitationEmail enregistré,
 * aucun envoi). Le cœur et l'adaptateur Prisma sont réels.
 *
 * Exécution : npm run test:invitations
 */
process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test"
process.env.RESEND_API_KEY = "re_test_dummy"
process.env.NEXTAUTH_URL = "http://127.0.0.1:3100"

import assert from "node:assert/strict"
import { before, beforeEach, describe, it, mock } from "node:test"

const GALYA = "cogalya000000000000000001"
const NOISAC = "cmpzbd1m70001nd28kse0vsw8"
const INACTIVE = "coinactive00000000000001"
const COMPANIES: Record<string, { id: string; name: string; active: boolean }> = {
  [GALYA]: { id: GALYA, name: "GALYA EVENTS", active: true },
  [NOISAC]: { id: NOISAC, name: "Nohisac structure", active: true },
  [INACTIVE]: { id: INACTIVE, name: "Tenant de test", active: false },
}

type Call = { key: string; args: unknown; inTx: boolean }
const state = {
  calls: [] as Call[],
  tx: [] as string[],
  session: null as unknown,
  users: [] as unknown[],
  auditFails: false,
  revalidated: [] as string[],
  emails: [] as unknown[],
}

function model(name: string, inTx: boolean) {
  return new Proxy({}, {
    get(_t, method) {
      if (typeof method !== "string" || method === "then") return undefined
      return async (args: unknown) => {
        state.calls.push({ key: `${name}.${method}`, args, inTx })
        if (name === "company" && method === "findUnique") return COMPANIES[(args as { where: { id: string } }).where.id] ?? null
        if (name === "user" && method === "findMany") return state.users
        if (name === "invitation" && method === "create") return { id: "inv-1" }
        if (name === "historyLog" && method === "create" && state.auditFails) throw new Error("journal indisponible")
        return { count: 0 }
      }
    },
  })
}
const client = (inTx: boolean) => ({
  company: model("company", inTx), user: model("user", inTx), invitation: model("invitation", inTx), historyLog: model("historyLog", inTx),
})
const prismaDouble = {
  ...client(false),
  $transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
    state.tx.push("begin")
    try { const r = await fn(client(true)); state.tx.push("commit"); return r }
    catch (e) { state.tx.push("rollback"); throw e }
  },
}

let actions: typeof import("@/lib/actions/invitation.actions")
before(async () => {
  mock.module("@/auth", { namedExports: { auth: async () => state.session } })
  mock.module("@/lib/prisma", { namedExports: { prisma: prismaDouble } })
  mock.module("next/cache", { namedExports: { revalidatePath: (p: string) => { state.revalidated.push(p) } } })
  mock.module("@/lib/email", { namedExports: { sendInvitationEmail: async (a: unknown) => { state.emails.push(a) } } })
  actions = await import("@/lib/actions/invitation.actions")
})
beforeEach(() => { state.calls = []; state.tx = []; state.users = []; state.auditFails = false; state.revalidated = []; state.emails = [] })

const fd = (o: Record<string, string>) => { const f = new FormData(); for (const [k, v] of Object.entries(o)) f.set(k, v); return f }
const keys = () => state.calls.map((c) => `${c.inTx ? "tx:" : ""}${c.key}`)
const call = (key: string) => state.calls.find((c) => c.key === key)?.args as any
const superAdmin = (companyId: string | null) => ({ user: { id: "sa-galya", role: "SUPER_ADMIN", companyId, email: "contactgalyaprod@example.com", name: "Galya" } })
const admin = { user: { id: "admin-makram", role: "ADMIN", companyId: NOISAC, email: "makram@example.com", name: "Makram" } }

describe("inviterMembre (action réelle) — supervision SUPER_ADMIN", () => {
  it("transaction unique (purge PENDING → création → journal INVITED), puis e-mail, puis revalidation", async () => {
    state.session = superAdmin(GALYA)
    const r = await actions.inviterMembre(fd({ email: " NohisacStructures@Gmail.com ", role: "ADMIN", targetCompanyId: NOISAC }))
    assert.equal(r.success, true)
    assert.deepEqual(keys(), ["company.findUnique", "user.findMany", "tx:invitation.deleteMany", "tx:invitation.create", "tx:historyLog.create"])
    assert.deepEqual(state.tx, ["begin", "commit"])
    assert.deepEqual(call("company.findUnique"), { where: { id: NOISAC }, select: { id: true, name: true, active: true } })
    assert.deepEqual(call("user.findMany").where, { email: { equals: "nohisacstructures@gmail.com", mode: "insensitive" } })
    assert.deepEqual(call("invitation.deleteMany"), { where: { email: { equals: "nohisacstructures@gmail.com", mode: "insensitive" }, companyId: NOISAC, status: "PENDING" } })
    const created = call("invitation.create").data
    assert.equal(created.email, "nohisacstructures@gmail.com")
    assert.equal(created.role, "ADMIN")
    assert.equal(created.companyId, NOISAC)
    assert.equal(created.invitedById, "sa-galya")
    assert.equal(created.status, "PENDING")
    assert.match(created.token, /^[0-9a-f]{64}$/)
    const audit = call("historyLog.create").data
    assert.deepEqual({ ...audit, detail: undefined }, { companyId: NOISAC, actorId: "sa-galya", action: "INVITED", entityType: "Invitation", entityId: "inv-1", detail: undefined })
    assert.match(audit.detail, /ADMIN .*nohisacstructures@gmail\.com.*SUPER_ADMIN/)
    assert.ok(!audit.detail.includes(created.token), "le jeton n'est jamais journalisé")
    assert.deepEqual(state.emails, [{ to: "nohisacstructures@gmail.com", token: created.token, companyName: "Nohisac structure", invitedByName: "Galya", role: "ADMIN" }])
    assert.deepEqual(state.revalidated, ["/employes"])
    assert.equal(r.invitationUrl, `http://127.0.0.1:3100/invitation?token=${created.token}`)
  })
  it("échec du journal dans la transaction ⇒ rollback, erreur propagée, ni e-mail, ni revalidation", async () => {
    state.session = superAdmin(GALYA); state.auditFails = true
    await assert.rejects(() => actions.inviterMembre(fd({ email: "nohisacstructures@gmail.com", role: "ADMIN", targetCompanyId: NOISAC })), /journal indisponible/)
    assert.deepEqual(state.tx, ["begin", "rollback"])
    assert.deepEqual(state.emails, [])
    assert.deepEqual(state.revalidated, [])
  })
  it("SUPER_ADMIN sans entreprise de session : accepté avec cible explicite", async () => {
    state.session = superAdmin(null)
    const r = await actions.inviterMembre(fd({ email: "x@example.com", role: "ADMIN", targetCompanyId: NOISAC }))
    assert.equal(r.success, true)
    assert.equal(call("invitation.create").data.companyId, NOISAC)
  })
  it("cible désactivée ⇒ refus avant toute recherche d'identité ou écriture", async () => {
    state.session = superAdmin(GALYA)
    const r = await actions.inviterMembre(fd({ email: "x@example.com", role: "ADMIN", targetCompanyId: INACTIVE }))
    assert.deepEqual(r, { error: "Entreprise cible introuvable ou désactivée." })
    assert.deepEqual(keys(), ["company.findUnique"])
    assert.deepEqual(state.tx, [])
  })
})

describe("inviterMembre (action réelle) — isolation et identités", () => {
  it("ADMIN (Makram) avec champ cible ⇒ refus, aucun accès Prisma", async () => {
    state.session = admin
    assert.deepEqual(await actions.inviterMembre(fd({ email: "x@example.com", role: "ADMIN", targetCompanyId: GALYA })), { error: "Accès refusé" })
    assert.deepEqual(keys(), [])
  })
  it("deux identités ne différant que par la casse ⇒ ambiguïté refusée, aucune écriture", async () => {
    state.session = superAdmin(GALYA)
    state.users = [{ id: "u1", email: "nohisacstructures@gmail.com", active: true, role: "ADMIN", companyId: GALYA, employeeProfiles: [] },
                   { id: "u2", email: "Nohisacstructures@gmail.com", active: true, role: "ADMIN", companyId: "autre", employeeProfiles: [] }]
    const r = await actions.inviterMembre(fd({ email: "nohisacstructures@gmail.com", role: "ADMIN", targetCompanyId: NOISAC }))
    assert.equal((r as { code?: string }).code, "INVITE_IDENTITY_AMBIGUOUS")
    assert.deepEqual(state.tx, [])
  })
  it("une seule identité mais d'une autre casse ⇒ ambiguïté refusée (l'acceptation ne la retrouverait pas)", async () => {
    state.session = superAdmin(GALYA)
    state.users = [{ id: "u2", email: "Nohisacstructures@gmail.com", active: true, role: "ADMIN", companyId: "autre", employeeProfiles: [] }]
    const r = await actions.inviterMembre(fd({ email: "nohisacstructures@gmail.com", role: "ADMIN", targetCompanyId: NOISAC }))
    assert.equal((r as { code?: string }).code, "INVITE_IDENTITY_AMBIGUOUS")
    assert.deepEqual(state.tx, [])
  })
  it("identité unique d'une autre entreprise (même casse) ⇒ invitation émise (rattachement à l'acceptation, comportement #84)", async () => {
    state.session = superAdmin(GALYA)
    state.users = [{ id: "u1", email: "x@example.com", active: true, role: "EMPLOYEE", companyId: GALYA, employeeProfiles: [] }]
    const r = await actions.inviterMembre(fd({ email: "x@example.com", role: "ADMIN", targetCompanyId: NOISAC }))
    assert.equal(r.success, true)
    assert.deepEqual(state.tx, ["begin", "commit"])
  })
  it("identité déjà membre actif de la cible ⇒ refus historique", async () => {
    state.session = superAdmin(GALYA)
    state.users = [{ id: "u-makram", email: "makram@example.com", active: true, role: "ADMIN", companyId: NOISAC, employeeProfiles: [{ id: "e", active: true, companyId: NOISAC, role: "ADMIN" }] }]
    const r = await actions.inviterMembre(fd({ email: "makram@example.com", role: "ADMIN", targetCompanyId: NOISAC }))
    assert.deepEqual(r, { error: "Cet employé fait déjà partie de votre entreprise." })
    assert.deepEqual(state.tx, [])
  })
  it("parcours historique sans champ cible : purge et création séparées, hors transaction, bornées à la session", async () => {
    state.session = admin
    const r = await actions.inviterMembre(fd({ email: "nouveau@example.com", role: "EMPLOYEE" }))
    assert.equal(r.success, true)
    assert.deepEqual(keys(), ["user.findMany", "invitation.deleteMany", "company.findUnique", "invitation.create"])
    assert.deepEqual(call("invitation.deleteMany"), { where: { email: "nouveau@example.com", companyId: NOISAC, status: "PENDING" } })
    assert.equal(call("invitation.create").data.companyId, NOISAC)
    assert.deepEqual(state.tx, [])
    assert.equal(state.calls.some((c) => c.key === "historyLog.create"), false)
  })
})
