/**
 * Tests de la véritable action serveur deleteClient (import réel, pas copie).
 *
 * Patron : harness `tests/chantiers/parity/harness.ts` — mock.module + import dynamique.
 * Doubles : @/auth, @/lib/prisma, next/cache (déjà présents dans le dépôt).
 * L'action réelle `src/lib/actions/client.actions.ts` est importée après installation des doubles.
 *
 * Couverture :
 *  - deleteClient : suppression légitime, étranger, sans entreprise, TEAM_LEADER, P2003, P2025, bornage id+companyId
 *  - createClient/updateClient/toggleClientActive : conservation des droits (TEAM_LEADER accepté)
 *  - 5 cas de blocage : worksites, quotes, invoices, acquisitionPartners, clientProfile liés → refus
 *  - verrou FOR UPDATE (tx.$queryRaw) avant lecture et suppression ; P2028 (transaction expirée)
 *  - revalidation : revalidatePath présent après succès, absent après refus/erreur
 *  - démonstration : enlever companyId du delete réel fait échouer un test
 *
 * Exécution : npm run test:clients (node --import tsx --experimental-test-module-mocks --test …)
 *
 * Aucune suppression réelle : Prisma est doublé — aucune requête n'atteint la base.
 */
import assert from "node:assert/strict"
import { describe, it, mock } from "node:test"
import { Prisma } from "@prisma/client"
import { installModuleDoubles } from "../chantiers/parity/harness"

// ---- Types locaux -----------------------------------------------------------

// ---- Doubles spécifiques aux actions client ---------------------------------

/** Double Prisma : enregistreur client + transaction. */
function makeClientDb() {
  const calls: { key: string; args: unknown; nth: number }[] = []
  const txCalls: { event: string; error?: { name: string; message: string } }[] = []
  // Erreur injectée au niveau client.delete (chemin réel emprunté dans la transaction)
  let deleteError: { code: string; message: string; meta?: Record<string, unknown> } | null = null
  // Surcharge de findFirst pour les cas de blocage (worksites, quotes, etc.)
  let findFirstOverride: ((args: unknown) => unknown) | null = null

  // Verrou FOR UPDATE (tx.$queryRaw) : journalisé comme "client.lock" ; [] pour un client étranger/inexistant
  function makeLock() {
    return async (_strings: TemplateStringsArray, ...values: unknown[]) => {
      const [id, companyId] = values as [string, string]
      calls.push({ key: "client.lock", args: { where: { id, companyId } }, nth: calls.filter(c => c.key === "client.lock").length + 1 })
      return id === "client-foreign" ? [] : [{ id }]
    }
  }

  function makeModelProxy(inTx: boolean) {
    return new Proxy({}, {
      get(_t, method) {
        if (typeof method !== "string") return undefined
        if (method === "then") return undefined
        return async (args: unknown) => {
          const key = `client.${method}`
          calls.push({ key, args, nth: calls.filter(c => c.key === key).length + 1 })
          // Injection au niveau client.delete — chemin réel emprunté par tx.client.delete
          if (inTx && method === "delete" && deleteError) {
            throw new (Prisma as any).PrismaClientKnownRequestError(
              deleteError.message,
              { code: deleteError.code, clientVersion: "5.22.0", meta: deleteError.meta },
            )
          }
          if (method === "findFirst") {
            if (findFirstOverride) return findFirstOverride(args)
            const where = (args as { where: { id: string; companyId: string } }).where
            return where.id === "client-foreign" ? null : {
              id: where.id,
              name: "Test Client",
              email: null,
              phone: null,
              address: null,
              notes: null,
              companyId: where.companyId,
              active: true,
              createdAt: new Date("2026-01-01"),
              updatedAt: new Date("2026-01-01"),
              _count: {
                worksites: 0,
                quotes: 0,
                invoices: 0,
                acquisitionPartners: 0,
              },
              clientProfile: null,
            }
          }
          return undefined
        }
      },
    })
  }

  const txRootClient = new Proxy({}, {
    get(_t, model) {
      if (typeof model !== "string") return undefined
      if (model === "then") return undefined
      if (model === "$queryRaw") return makeLock()
      if (model === "$executeRawUnsafe") {
        return async (sql: string) => {
          calls.push({ key: "tx.set_lock_timeout", args: sql, nth: calls.filter(c => c.key === "tx.set_lock_timeout").length + 1 })
          return 0
        }
      }
      if (model === "$transaction") {
        return async (fn: unknown) => {
          txCalls.push({ event: "begin" })
          try {
            const result = await (fn as (tx: unknown) => Promise<unknown>)(txRootClient)
            txCalls.push({ event: "commit" })
            return result
          } catch (err) {
            txCalls.push({ event: "rollback", error: err instanceof Error ? { name: err.name, message: err.message } : { name: "NonError", message: String(err) } })
            throw err
          }
        }
      }
      return makeModelProxy(true)
    },
  })
  const rootClient = new Proxy({}, {
    get(_t, model) {
      if (typeof model !== "string") return undefined
      if (model === "then") return undefined
      if (model === "$transaction") {
        return async (fn: unknown) => {
          txCalls.push({ event: "begin" })
          try {
            const result = await (fn as (tx: unknown) => Promise<unknown>)(txRootClient)
            txCalls.push({ event: "commit" })
            return result
          } catch (err) {
            txCalls.push({ event: "rollback", error: err instanceof Error ? { name: err.name, message: err.message } : { name: "NonError", message: String(err) } })
            throw err
          }
        }
      }
      return makeModelProxy(false)
    },
  })

  return {
    rootClient,
    calls,
    txCalls,
    get deleteError() { return deleteError },
    set deleteError(v: { code: string; message: string; meta?: Record<string, unknown> } | null) { deleteError = v },
    get findFirstOverride() { return findFirstOverride },
    set findFirstOverride(v: ((args: unknown) => unknown) | null) { findFirstOverride = v },
  }
}

/** État mutable partagé par les doubles. */
const db: any = makeClientDb()
let revalidatedPaths: string[] = []
let installed = false
let sessionKind = "admin"

/** Sessions simulées. */
const SESSIONS: Record<string, unknown> = {
  admin: { user: { id: "u1", role: "ADMIN", companyId: "company-A", email: "a@t.t", name: "A" } },
  none: null,
  employee: { user: { id: "u2", role: "EMPLOYEE", companyId: "company-A", email: "e@t.t", name: "E" } },
  noCompany: { user: { id: "u3", role: "ADMIN", companyId: null, email: "a2@t.t", name: "A2" } },
  teamLeader: { user: { id: "u4", role: "TEAM_LEADER", companyId: "company-A", email: "t@t.t", name: "T" } },
  superAdmin: { user: { id: "u5", role: "SUPER_ADMIN", companyId: "company-A", email: "s@t.t", name: "S" } },
}

/** Pose les doubles de modules. À appeler AVANT tout import de client.actions. */
function installClientDoubles() {
  if (installed) return
  installed = true

  mock.module("@/auth", { namedExports: { auth: async () => SESSIONS[sessionKind] ?? null } })
  mock.module("@/lib/prisma", { namedExports: { prisma: db.rootClient } })
  mock.module("next/cache", {
    namedExports: {
      revalidatePath: (path: string) => { revalidatedPaths.push(path) },
    },
  })
}

/** Importe le module réel des actions client (après doubles). */
async function loadClientActions(): Promise<typeof import("@/lib/actions/client.actions")> {
  return import("@/lib/actions/client.actions")
}

// ---- Helpers ---------------------------------------------------------------

function resetState() {
  db.calls.length = 0
  db.txCalls.length = 0
  revalidatedPaths.length = 0
  db.deleteError = null
  db.findFirstOverride = null
}

// ---- Tests deleteClient (action réelle) ----------------------------------

describe("deleteClient — action réelle", () => {
  let actions: Awaited<ReturnType<typeof loadClientActions>>

  it.before(async () => {
    installClientDoubles()
    actions = await loadClientActions()
  })

  it("suppression légitime → success + revalidation", async () => {
    resetState()
    sessionKind = "admin"
    const result = await actions.deleteClient("client-1")
    assert.equal(result.success, true)
    const deleteCall = db.calls.find((c: { key: string }) => c.key === "client.delete")
    assert.ok(deleteCall, "client.delete doit être appelé")
    const where = (deleteCall.args as { where: { id: string; companyId: string } }).where
    assert.equal(where.id, "client-1")
    assert.equal(where.companyId, "company-A")
    assert.ok(revalidatedPaths.includes("/clients"), "revalidatePath(/clients) doit être appelé après succès")
  })

  it("client étranger → refus, pas de revalidation", async () => {
    resetState()
    sessionKind = "admin"
    const result = await actions.deleteClient("client-foreign")
    assert.equal(result.error, "Client introuvable.")
    assert.equal(db.calls.filter((c: { key: string }) => c.key === "client.lock").length, 1, "verrou tenté une fois, borné id+companyId")
    assert.equal(db.calls.filter((c: { key: string }) => c.key === "client.findFirst").length, 0, "aucune lecture sans verrou")
    assert.equal(db.calls.filter((c: { key: string }) => c.key === "client.delete").length, 0)
    assert.equal(revalidatedPaths.length, 0, "pas de revalidatePath après refus")
  })

  it("session sans entreprise → throw, pas de revalidation", async () => {
    resetState()
    sessionKind = "noCompany"
    await assert.rejects(() => actions.deleteClient("client-1"), /Entreprise introuvable/)
    assert.equal(db.calls.length, 0)
    assert.equal(revalidatedPaths.length, 0, "pas de revalidatePath après erreur")
  })

  it("TEAM_LEADER → refus par requireDeleteAdmin, pas de revalidation", async () => {
    resetState()
    sessionKind = "teamLeader"
    await assert.rejects(() => actions.deleteClient("client-1"), /Accès refusé/)
    assert.equal(db.calls.length, 0)
    assert.equal(revalidatedPaths.length, 0)
  })

  it("SUPER_ADMIN → autorisé + revalidation", async () => {
    resetState()
    sessionKind = "superAdmin"
    const result = await actions.deleteClient("client-3")
    assert.equal(result.success, true)
    assert.ok(revalidatedPaths.includes("/clients"))
  })

  it("session non authentifié → throw, pas de revalidation", async () => {
    resetState()
    sessionKind = "none"
    await assert.rejects(() => actions.deleteClient("client-1"), /Non authentifié/)
    assert.equal(db.calls.length, 0)
    assert.equal(revalidatedPaths.length, 0)
  })

  // ---- 4 cas de blocage : relations liées → refus --------------------------------

  it("client avec chantiers liés → refus, delete non appelé", async () => {
    resetState()
    sessionKind = "admin"
    db.findFirstOverride = (args: unknown) => ({
      id: "client-2",
      name: "Test Client",
      email: null, phone: null, address: null, notes: null,
      companyId: "company-A", active: true,
      createdAt: new Date("2026-01-01"), updatedAt: new Date("2026-01-01"),
      _count: { worksites: 3, quotes: 0, invoices: 0, acquisitionPartners: 0 },
    })
    const result = await actions.deleteClient("client-2")
    assert.match(result.error ?? "", /3 chantiers/)
    assert.equal(db.calls.filter((c: { key: string }) => c.key === "client.delete").length, 0)
    assert.equal(revalidatedPaths.length, 0)
  })

  it("client avec devis liés → refus, delete non appelé", async () => {
    resetState()
    sessionKind = "admin"
    db.findFirstOverride = (args: unknown) => ({
      id: "client-4", name: "Test Client", email: null, phone: null, address: null, notes: null,
      companyId: "company-A", active: true,
      createdAt: new Date("2026-01-01"), updatedAt: new Date("2026-01-01"),
      _count: { worksites: 0, quotes: 2, invoices: 0, acquisitionPartners: 0 },
    })
    const result = await actions.deleteClient("client-4")
    assert.match(result.error ?? "", /2 devis(?!s)/, "« devis » est invariant : « 2 deviss » est refusé")
    assert.doesNotMatch(result.error ?? "", /deviss/)
    assert.equal(db.calls.filter((c: { key: string }) => c.key === "client.delete").length, 0)
    assert.equal(revalidatedPaths.length, 0)
  })

  it("client avec factures liées → refus, delete non appelé", async () => {
    resetState()
    sessionKind = "admin"
    db.findFirstOverride = (args: unknown) => ({
      id: "client-5", name: "Test Client", email: null, phone: null, address: null, notes: null,
      companyId: "company-A", active: true,
      createdAt: new Date("2026-01-01"), updatedAt: new Date("2026-01-01"),
      _count: { worksites: 0, quotes: 0, invoices: 5, acquisitionPartners: 0 },
    })
    const result = await actions.deleteClient("client-5")
    assert.match(result.error ?? "", /5 factures/)
    assert.equal(db.calls.filter((c: { key: string }) => c.key === "client.delete").length, 0)
    assert.equal(revalidatedPaths.length, 0)
  })

  it("client avec partenaires liés → refus, delete non appelé", async () => {
    resetState()
    sessionKind = "admin"
    db.findFirstOverride = (args: unknown) => ({
      id: "client-6", name: "Test Client", email: null, phone: null, address: null, notes: null,
      companyId: "company-A", active: true,
      createdAt: new Date("2026-01-01"), updatedAt: new Date("2026-01-01"),
      _count: { worksites: 0, quotes: 0, invoices: 0, acquisitionPartners: 1 },
    })
    const result = await actions.deleteClient("client-6")
    assert.match(result.error ?? "", /1 partenaire/)
    assert.equal(db.calls.filter((c: { key: string }) => c.key === "client.delete").length, 0)
    assert.equal(revalidatedPaths.length, 0)
  })

  it("client avec accès portail (ClientProfile) → refus, delete non appelé, rien modifié", async () => {
    resetState()
    sessionKind = "admin"
    db.findFirstOverride = () => ({
      id: "client-8", name: "Test Client", email: null, phone: null, address: null, notes: null,
      companyId: "company-A", active: true,
      createdAt: new Date("2026-01-01"), updatedAt: new Date("2026-01-01"),
      _count: { worksites: 0, quotes: 0, invoices: 0, acquisitionPartners: 0 },
      clientProfile: { id: "profile-1" },
    })
    const result = await actions.deleteClient("client-8")
    assert.match(result.error ?? "", /1 accès portail lié à ce client/)
    assert.equal(db.calls.filter((c: { key: string }) => c.key === "client.delete").length, 0)
    assert.equal(db.txCalls.at(-1)?.event, "commit", "transaction close sans erreur, sans écriture")
    assert.equal(revalidatedPaths.length, 0)
  })

  it("ordre dans la transaction : verrou FOR UPDATE → lecture des relations → delete, tous bornés id+companyId", async () => {
    resetState()
    sessionKind = "admin"
    await actions.deleteClient("client-1")
    assert.deepEqual(db.txCalls.map((t: { event: string }) => t.event), ["begin", "commit"])
    assert.deepEqual(db.calls.map((c: { key: string }) => c.key), ["tx.set_lock_timeout", "client.lock", "client.findFirst", "client.delete"])
    assert.equal(db.calls[0].args, "SET LOCAL lock_timeout = '4000ms'")
    for (const call of db.calls.slice(1)) {
      assert.deepEqual((call.args as { where: unknown }).where, { id: "client-1", companyId: "company-A" }, call.key)
    }
  })

  it("attente de verrou dépassée (P2010 / SQLSTATE 55P03) → message explicite, pas de revalidation", async () => {
    resetState()
    sessionKind = "admin"
    db.deleteError = { code: "P2010", message: "Raw query failed", meta: { code: "55P03", message: "canceling statement due to lock timeout" } }
    const result = await actions.deleteClient("client-11")
    assert.match(result.error ?? "", /Une autre opération est en cours/)
    assert.equal(revalidatedPaths.length, 0)
  })

  it("transaction expirée (P2028, rival gardant la ligne) → message explicite, pas de revalidation", async () => {
    resetState()
    sessionKind = "admin"
    db.deleteError = { code: "P2028", message: "Transaction API error: timeout" }
    const result = await actions.deleteClient("client-10")
    assert.match(result.error ?? "", /Une autre opération est en cours/)
    assert.equal(revalidatedPaths.length, 0)
  })

  // ---- P2003/P2025 : injection au niveau client.delete (chemin réel, défense en profondeur) -------------------

  it("rattachement concurrent (P2003) → erreur, pas de revalidation", async () => {
    resetState()
    sessionKind = "admin"
    // Injection au niveau client.delete — chemin réel emprunté dans la transaction
    db.deleteError = { code: "P2003", message: "Foreign key constraint failed" }
    const result = await actions.deleteClient("client-7")
    assert.match(result.error ?? "", /rattachement concurrent/)
    assert.equal(revalidatedPaths.length, 0, "pas de revalidatePath après erreur")
  })

  it("client disparu (P2025) → erreur distincte, pas de revalidation", async () => {
    resetState()
    sessionKind = "admin"
    db.deleteError = { code: "P2025", message: "Record not found" }
    const result = await actions.deleteClient("client-9")
    assert.match(result.error ?? "", /n'existe plus ou n'appartient plus/)
    assert.doesNotMatch(result.error ?? "", /rattachement concurrent/)
    assert.equal(revalidatedPaths.length, 0)
  })
})

// ---- Tests conservation des droits (actions réelles) -----------------------------

describe("Conservation des droits — actions réelles", () => {
  let actions: Awaited<ReturnType<typeof loadClientActions>>

  it.before(async () => {
    installClientDoubles()
    actions = await loadClientActions()
  })

  it("TEAM_LEADER peut createClient (requireAdmin partagé)", async () => {
    resetState()
    sessionKind = "teamLeader"
    const fd = new FormData()
    fd.set("name", "Client TL")
    fd.set("email", "")
    fd.set("phone", "")
    fd.set("address", "")
    fd.set("notes", "")
    const result = await actions.createClient(fd)
    assert.equal(result.success, true)
    assert.ok(revalidatedPaths.includes("/clients"))
  })

  it("EMPLOYEE rejeté par createClient (requireAdmin)", async () => {
    resetState()
    sessionKind = "employee"
    const fd = new FormData()
    fd.set("name", "Client Emp")
    fd.set("email", "")
    fd.set("phone", "")
    fd.set("address", "")
    fd.set("notes", "")
    await assert.rejects(() => actions.createClient(fd), /Accès refusé/)
    assert.equal(revalidatedPaths.length, 0)
  })

  it("TEAM_LEADER peut updateClient (requireAdmin partagé)", async () => {
    resetState()
    sessionKind = "teamLeader"
    const fd = new FormData()
    fd.set("name", "Client TL Mod")
    fd.set("email", "")
    fd.set("phone", "")
    fd.set("address", "")
    fd.set("notes", "")
    const result = await actions.updateClient("client-1", fd)
    assert.equal(result.success, true)
    assert.ok(revalidatedPaths.includes("/clients"))
  })

  it("TEAM_LEADER peut toggleClientActive (requireAdmin)", async () => {
    resetState()
    sessionKind = "teamLeader"
    const result = await actions.toggleClientActive("client-1", false)
    assert.equal(result.success, true)
    assert.ok(revalidatedPaths.includes("/clients"))
  })

  it("TEAM_LEADER rejeté par deleteClient (requireDeleteAdmin)", async () => {
    resetState()
    sessionKind = "teamLeader"
    await assert.rejects(() => actions.deleteClient("client-1"), /Accès refusé/)
  })

  it("CLIENT_DELETE_ROLES (partagé avec le menu) = exactement les rôles acceptés par deleteClient", async () => {
    const { CLIENT_DELETE_ROLES } = await import("@/lib/clients/client-actions-view")
    assert.deepEqual([...CLIENT_DELETE_ROLES].sort(), ["ADMIN", "SUPER_ADMIN"])
    for (const [kind, role] of [["admin", "ADMIN"], ["superAdmin", "SUPER_ADMIN"], ["teamLeader", "TEAM_LEADER"], ["employee", "EMPLOYEE"]] as const) {
      resetState()
      sessionKind = kind
      const allowed = CLIENT_DELETE_ROLES.includes(role)
      if (allowed) assert.equal((await actions.deleteClient("client-1")).success, true, role)
      else await assert.rejects(() => actions.deleteClient("client-1"), /Accès refusé/, role)
    }
  })
})

// ---- Tests bornage id + companyId (action réelle) ---------------------------

describe("Bornage id + companyId — action réelle", () => {
  let actions: Awaited<ReturnType<typeof loadClientActions>>

  it.before(async () => {
    installClientDoubles()
    actions = await loadClientActions()
  })

  it("findFirst appelé avec { id, companyId } (bornage double)", async () => {
    resetState()
    sessionKind = "admin"
    await actions.deleteClient("client-1")
    const findFirstCall = db.calls.find((c: { key: string }) => c.key === "client.findFirst")
    assert.ok(findFirstCall, "client.findFirst doit être appelé")
    const where = (findFirstCall.args as { where: { id: string; companyId: string } }).where
    assert.equal(where.id, "client-1")
    assert.equal(where.companyId, "company-A")
  })

  it("delete appelé avec { id, companyId } (bornage double dans l'écriture)", async () => {
    resetState()
    sessionKind = "admin"
    await actions.deleteClient("client-1")
    const deleteCall = db.calls.find((c: { key: string }) => c.key === "client.delete")
    assert.ok(deleteCall, "client.delete doit être appelé")
    const where = (deleteCall.args as { where: { id: string; companyId: string } }).where
    assert.equal(where.id, "client-1")
    assert.equal(where.companyId, "company-A",
      "delete doit être borné par id ET companyId — enlever companyId fait échouer ce test")
  })
})