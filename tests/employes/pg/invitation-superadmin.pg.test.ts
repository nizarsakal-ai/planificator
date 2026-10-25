/**
 * Invitation supervisée contre une vraie base PostgreSQL jetable : transaction réelle, rollback réel, FK réelles.
 *
 * Lancé UNIQUEMENT par `tests/employes/pg/invitation-superadmin-run.ts test` (INVITATION_SUPERADMIN_RUNNER=1,
 * DATABASE_URL transmise explicitement). Doubles : `@/auth` (session simulée sur des ids réels de la base),
 * `next/cache`, `@/lib/email` (enregistré, aucun envoi). `@/lib/prisma` = le VRAI PrismaClient, enveloppé pour
 * pouvoir faire échouer `tx.historyLog.create` (le rollback est alors celui de PostgreSQL, pas une simulation).
 * L'action `src/lib/actions/invitation.actions.ts` est réelle.
 */
import assert from "node:assert/strict"
import { after, before, beforeEach, describe, it, mock } from "node:test"
import { Prisma, PrismaClient } from "@prisma/client"
import { EMAILS, SLUGS } from "./invitation-superadmin-seed"

if (process.env.INVITATION_SUPERADMIN_RUNNER !== "1") {
  throw new Error("REFUS — à lancer via invitation-superadmin-run.ts test (base jetable identifiée)")
}
process.env.RESEND_API_KEY = "re_test_dummy" // chemin e-mail actif, mais doublé : aucun envoi
process.env.NEXTAUTH_URL = "http://127.0.0.1:3100"

const real = new PrismaClient()
let session: unknown = null
let failAudit = false
let revalidated: string[] = []
let emails: { to: string; token: string }[] = []

function wrapTx(tx: Prisma.TransactionClient): Prisma.TransactionClient {
  return new Proxy(tx, {
    get(target, prop, receiver) {
      if (prop !== "historyLog") return Reflect.get(target, prop, receiver)
      const delegate = target.historyLog
      return new Proxy(delegate, {
        get(d, method, r) {
          const fn = Reflect.get(d, method, r)
          if (method !== "create" || typeof fn !== "function") return fn
          return async (args: unknown) => {
            if (failAudit) throw new Error("journal indisponible (injection PG)")
            return (fn as (a: unknown) => Promise<unknown>).call(d, args)
          }
        },
      })
    },
  })
}
const prismaDouble = new Proxy(real, {
  get(target, prop, receiver) {
    if (prop !== "$transaction") return Reflect.get(target, prop, receiver)
    return (arg: unknown, opts?: unknown) => typeof arg === "function"
      ? real.$transaction((tx) => (arg as (t: Prisma.TransactionClient) => Promise<unknown>)(wrapTx(tx)), opts as never)
      : real.$transaction(arg as never, opts as never)
  },
})

let actions: typeof import("@/lib/actions/invitation.actions")
let ids: { galya: string; nohisac: string; inactive: string; superAdmin: string; makram: string }

before(async () => {
  mock.module("@/auth", { namedExports: { auth: async () => session } })
  mock.module("@/lib/prisma", { namedExports: { prisma: prismaDouble } })
  mock.module("next/cache", { namedExports: { revalidatePath: (p: string) => { revalidated.push(p) } } })
  mock.module("@/lib/email", { namedExports: { sendInvitationEmail: async (a: { to: string; token: string }) => { emails.push(a) } } })
  actions = await import("@/lib/actions/invitation.actions")
  const [galya, nohisac, inactive] = await Promise.all([SLUGS.galya, SLUGS.nohisac, SLUGS.inactive].map((slug) => real.company.findUniqueOrThrow({ where: { slug } })))
  const [sa, makram] = await Promise.all([EMAILS.superAdmin, EMAILS.makram].map((email) => real.user.findUniqueOrThrow({ where: { email } })))
  ids = { galya: galya.id, nohisac: nohisac.id, inactive: inactive.id, superAdmin: sa.id, makram: makram.id }
})
after(async () => { await real.$disconnect() })
beforeEach(() => { failAudit = false; revalidated = []; emails = [] })

const fd = (o: Record<string, string>) => { const f = new FormData(); for (const [k, v] of Object.entries(o)) f.set(k, v); return f }
const asSuperAdmin = (companyId: string | null = null) => { session = { user: { id: ids.superAdmin, role: "SUPER_ADMIN", companyId: companyId ?? ids.galya, email: EMAILS.superAdmin, name: "Supervision fictive" } } }
const asMakram = () => { session = { user: { id: ids.makram, role: "ADMIN", companyId: ids.nohisac, email: EMAILS.makram, name: "Makram fictif" } } }
const snapshot = async () => ({
  invitations: await real.invitation.findMany({ where: { companyId: ids.nohisac }, orderBy: { createdAt: "asc" }, select: { id: true, email: true, role: true, status: true, token: true, invitedById: true } }),
  logs: await real.historyLog.count({ where: { companyId: ids.nohisac, action: "INVITED" } }),
})

describe("PG — invitation supervisée ADMIN vers l'entreprise exacte", () => {
  it("transaction validée : ancienne PENDING purgée, invitation ADMIN créée, journal INVITED, e-mail après validation", async () => {
    asSuperAdmin()
    const before_ = await snapshot()
    assert.ok(before_.invitations.some((i) => i.email === EMAILS.pending && i.status === "PENDING" && i.token === "seed-pending-token-to-be-purged"), "précondition : invitation PENDING du seed présente")
    const r = await actions.inviterMembre(fd({ email: " Nohisac.Fictif@Invitation-SuperAdmin.local ", role: "ADMIN", targetCompanyId: ids.nohisac }))
    assert.equal(r.success, true)
    const after_ = await snapshot()
    const mine = after_.invitations.filter((i) => i.email === EMAILS.pending)
    assert.equal(mine.length, 1, "une seule invitation pour l'adresse : la PENDING du seed a été purgée dans la transaction")
    assert.deepEqual({ role: mine[0].role, status: mine[0].status, invitedById: mine[0].invitedById }, { role: "ADMIN", status: "PENDING", invitedById: ids.superAdmin })
    assert.equal(r.invitationUrl, `http://127.0.0.1:3100/invitation?token=${mine[0].token}`)
    assert.equal(after_.logs, before_.logs + 1)
    const log = await real.historyLog.findFirstOrThrow({ where: { entityType: "Invitation", entityId: mine[0].id } })
    assert.deepEqual({ companyId: log.companyId, actorId: log.actorId, action: log.action }, { companyId: ids.nohisac, actorId: ids.superAdmin, action: "INVITED" })
    assert.ok(log.detail && !log.detail.includes(mine[0].token), "jeton absent du journal")
    assert.deepEqual(emails.map((e) => e.to), [EMAILS.pending])
    assert.equal(emails[0].token, mine[0].token)
    assert.deepEqual(revalidated, ["/employes"])
  })
  it("rollback réel : le journal échoue ⇒ l'invitation créée et la purge sont annulées par PostgreSQL ; ni e-mail, ni revalidation", async () => {
    asSuperAdmin()
    const before_ = await snapshot()
    failAudit = true
    await assert.rejects(() => actions.inviterMembre(fd({ email: EMAILS.pending, role: "ADMIN", targetCompanyId: ids.nohisac })), /journal indisponible/)
    const after_ = await snapshot()
    assert.deepEqual(after_, before_, "état de la base strictement identique après rollback")
    assert.deepEqual(emails, [])
    assert.deepEqual(revalidated, [])
  })
  it("rollback réel par contrainte FK : acteur inexistant ⇒ aucune invitation, purge annulée, aucun journal", async () => {
    session = { user: { id: "sa-inexistant-00000000000", role: "SUPER_ADMIN", companyId: null, email: "x@invitation-superadmin.local", name: "Fantôme" } }
    const before_ = await snapshot()
    await assert.rejects(() => actions.inviterMembre(fd({ email: EMAILS.pending, role: "ADMIN", targetCompanyId: ids.nohisac })), (e: unknown) => e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2003")
    assert.deepEqual(await snapshot(), before_)
    assert.deepEqual(emails, [])
    assert.deepEqual(revalidated, [])
  })
})

describe("PG — isolation, cibles invalides, identités", () => {
  it("Makram (ADMIN de Nohisac) avec champ cible ⇒ refus, base inchangée", async () => {
    asMakram()
    const before_ = await snapshot()
    assert.deepEqual(await actions.inviterMembre(fd({ email: "autre@invitation-superadmin.local", role: "ADMIN", targetCompanyId: ids.galya })), { error: "Accès refusé" })
    assert.deepEqual(await snapshot(), before_)
  })
  it("tenant désactivé et id inexistant ⇒ refus explicite, base inchangée", async () => {
    asSuperAdmin()
    const before_ = await snapshot()
    for (const target of [ids.inactive, "cinexistant00000000000000"]) {
      assert.deepEqual(await actions.inviterMembre(fd({ email: "autre@invitation-superadmin.local", role: "ADMIN", targetCompanyId: target })), { error: "Entreprise cible introuvable ou désactivée." })
    }
    assert.deepEqual(await snapshot(), before_)
    assert.equal(await real.invitation.count({ where: { email: "autre@invitation-superadmin.local" } }), 0)
  })
  it("deux identités réelles ne différant que par la casse ⇒ ambiguïté refusée, aucune invitation", async () => {
    asSuperAdmin()
    const r = await actions.inviterMembre(fd({ email: EMAILS.dupLower, role: "ADMIN", targetCompanyId: ids.nohisac }))
    assert.equal((r as { code?: string }).code, "INVITE_IDENTITY_AMBIGUOUS")
    assert.equal(await real.invitation.count({ where: { email: { equals: EMAILS.dupLower, mode: "insensitive" } } }), 0)
    assert.deepEqual(emails, [])
  })
  it("Makram invite un EMPLOYEE sans champ cible ⇒ parcours historique, invitation dans Nohisac", async () => {
    asMakram()
    const r = await actions.inviterMembre(fd({ email: "employe.fictif@invitation-superadmin.local", role: "EMPLOYEE" }))
    assert.equal(r.success, true)
    const inv = await real.invitation.findFirstOrThrow({ where: { email: "employe.fictif@invitation-superadmin.local" } })
    assert.deepEqual({ companyId: inv.companyId, role: inv.role, invitedById: inv.invitedById }, { companyId: ids.nohisac, role: "EMPLOYEE", invitedById: ids.makram })
    assert.equal(await real.historyLog.count({ where: { entityType: "Invitation", entityId: inv.id } }), 0, "pas de journal de supervision sur le parcours historique")
  })
})
