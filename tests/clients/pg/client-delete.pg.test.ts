/**
 * deleteClient contre une vraie base PostgreSQL jetable : contraintes FK réelles, verrou FOR UPDATE réel,
 * courses réelles entre deux connexions. AUCUNE erreur injectée : les refus et les erreurs viennent de PostgreSQL.
 *
 * Lancé UNIQUEMENT par `tests/clients/pg/client-delete-run.ts test` (CLIENT_DELETE_RUNNER=1, DATABASE_URL
 * transmise explicitement). Doubles : `@/auth` (session simulée), `next/cache` (revalidatePath enregistré),
 * `@/lib/prisma` = le VRAI PrismaClient enveloppé pour poser une barrière juste après la lecture sous verrou
 * (entre l'étape 2 et l'étape 3 de l'action). L'action `src/lib/actions/client.actions.ts` est réelle.
 *
 * Rivaux (chacun sur sa propre connexion/transaction) : rattachement d'un accès portail (ClientProfile, FK
 * CASCADE), rattachement d'un chantier (FK RESTRICT), suppression du client, transfert à une autre entreprise.
 * Deux ordres pour chaque rival :
 *   A. le rival commence AVANT l'action et ne valide qu'après que l'action a demandé le verrou
 *      → l'action doit attendre (vérifié par délai borné), puis voir le rattachement et refuser ;
 *   B. l'action tient le verrou, le rival commence pendant la fenêtre lecture→suppression
 *      → le rival doit attendre (vérifié par délai borné) ; l'action supprime ; le rival échoue (FK / ligne absente).
 * Dans les deux ordres : jamais de profil créé puis cascadé en silence.
 */
import assert from "node:assert/strict"
import { after, before, beforeEach, describe, it, mock } from "node:test"
import { Prisma, PrismaClient } from "@prisma/client"

if (process.env.CLIENT_DELETE_RUNNER !== "1") {
  throw new Error("REFUS — à lancer via client-delete-run.ts test (base jetable identifiée)")
}

/** Délai borné (ms) pendant lequel une promesse « bloquée » ne doit PAS se résoudre. */
const HOLD_MS = 400
/** Délai maximal (ms) accordé à toute attente de la suite — au-delà, échec explicite (pas de test qui pend). */
const MAX_WAIT_MS = 8_000

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
/** true si `p` s'est réglée (résolue ou rejetée) avant `ms`. */
async function settledWithin(p: Promise<unknown>, ms: number): Promise<boolean> {
  const marker = Symbol("timeout")
  const r = await Promise.race([p.then(() => "settled", () => "settled"), sleep(ms).then(() => marker)])
  return r !== marker
}
async function withinMax<T>(p: Promise<T>, label: string): Promise<T> {
  const ok = await settledWithin(p, MAX_WAIT_MS)
  assert.ok(ok, `${label} : toujours en attente après ${MAX_WAIT_MS} ms`)
  return p
}
function barrier() {
  let release!: () => void
  const released = new Promise<void>((r) => { release = r })
  return { release, released }
}

const real = new PrismaClient({ transactionOptions: { timeout: 10_000, maxWait: 5_000 } })
/** Connexion séparée pour les rivaux : jamais la même que celle de l'action. */
const rivalDb = new PrismaClient({ transactionOptions: { timeout: 10_000, maxWait: 5_000 } })
let revalidated: string[] = []
let session: unknown = null
/** Appelé une fois, dans la transaction de l'action, juste après la lecture sous verrou (avant le delete). */
let afterLockedRead: (() => Promise<void>) | null = null

function wrapTx(txClient: Prisma.TransactionClient): Prisma.TransactionClient {
  return new Proxy(txClient, {
    get(target, prop, receiver) {
      if (prop !== "client") return Reflect.get(target, prop, receiver)
      const model = target.client
      return new Proxy(model, {
        get(m, method, r) {
          const fn = Reflect.get(m, method, r)
          if (method !== "findFirst" || typeof fn !== "function") return fn
          return async (args: unknown) => {
            const result = await (fn as (a: unknown) => Promise<unknown>).call(m, args)
            if (afterLockedRead) {
              const hook = afterLockedRead
              afterLockedRead = null
              await hook()
            }
            return result
          }
        },
      })
    },
  })
}

const wrapped = new Proxy(real, {
  get(target, prop, receiver) {
    if (prop !== "$transaction") return Reflect.get(target, prop, receiver)
    return (fn: (tx: Prisma.TransactionClient) => Promise<unknown>, opts?: unknown) =>
      target.$transaction((tx) => fn(wrapTx(tx)), opts as never)
  },
})

mock.module("@/auth", { namedExports: { auth: async () => session } })
mock.module("next/cache", { namedExports: { revalidatePath: (p: string) => { revalidated.push(p) } } })
mock.module("@/lib/prisma", { namedExports: { prisma: wrapped } })

type Actions = typeof import("@/lib/actions/client.actions")
let actions: Actions
const suffix = `cd_${Date.now()}`
let companyA = ""
let companyB = ""
let adminA = ""
let seq = 0

const asAdmin = (companyId: string, role = "ADMIN") => { session = { user: { id: adminA, role, companyId, email: "a@t.local", name: "A" } } }
const count = (id: string) => real.client.count({ where: { id } })
const newClient = (name: string) => real.client.create({ data: { name, companyId: companyA } })
const newPortalUser = () => real.user.create({ data: { email: `portail-${suffix}-${++seq}@t.local`, password: "h", role: "CLIENT", companyId: companyA } })
/** Attente de verrou maximale des rivaux, bornée côté PostgreSQL (> 4 s de l'action pour que l'action expire d'abord). */
const RIVAL_LOCK_TIMEOUT_SQL = "SET LOCAL lock_timeout = '6000ms'"
/** Opération rivale isolée (ordre B) : transaction courte, attente de verrou bornée par PostgreSQL. */
function rivalOp<T>(work: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  return rivalDb.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(RIVAL_LOCK_TIMEOUT_SQL)
    return work(tx)
  })
}
const isP2003 = (e: unknown) => e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2003"
const isP2025 = (e: unknown) => e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2025"

describe("deleteClient — base PostgreSQL jetable", () => {
  before(async () => {
    actions = await import("@/lib/actions/client.actions")
    const a = await real.company.create({ data: { name: `CD A ${suffix}`, slug: `cda-${suffix}` } })
    const b = await real.company.create({ data: { name: `CD B ${suffix}`, slug: `cdb-${suffix}` } })
    companyA = a.id
    companyB = b.id
    const ua = await real.user.create({ data: { email: `cda-${suffix}@t.local`, name: "A", password: "h", role: "ADMIN", companyId: companyA } })
    adminA = ua.id
  })
  beforeEach(() => { revalidated = []; afterLockedRead = null })
  after(async () => {
    // Nettoyage des données du test (cascade Company → clients, chantiers, devis, utilisateurs) ; la base est supprimée par « drop ».
    await real.user.deleteMany({ where: { companyId: { in: [companyA, companyB] } } })
    await real.company.deleteMany({ where: { id: { in: [companyA, companyB] } } })
    await real.$disconnect()
    await rivalDb.$disconnect()
  })

  // ---- Sans concurrence -------------------------------------------------------------------------------

  it("client libre (sans profil) → supprimé en base, revalidation /clients", async () => {
    asAdmin(companyA)
    const c = await newClient("Libre")
    assert.deepEqual(await actions.deleteClient(c.id), { success: true })
    assert.equal(await count(c.id), 0)
    assert.deepEqual(revalidated, ["/clients"])
  })

  it("profil portail préexistant → refus explicite ; client, profil et utilisateur conservés ; pas de revalidation", async () => {
    asAdmin(companyA)
    const c = await newClient("Avec portail")
    const u = await newPortalUser()
    const p = await real.clientProfile.create({ data: { clientId: c.id, userId: u.id } })
    const r = await actions.deleteClient(c.id)
    assert.equal(r.error, "Impossible de supprimer : 1 accès portail lié à ce client. Réaffectez ou supprimez d'abord ces éléments.")
    assert.equal(await count(c.id), 1)
    assert.equal(await real.clientProfile.count({ where: { id: p.id } }), 1)
    assert.equal(await real.user.count({ where: { id: u.id } }), 1)
    assert.deepEqual(revalidated, [])
    // la désactivation reste disponible
    assert.deepEqual(await actions.toggleClientActive(c.id, false), { success: true })
    assert.equal((await real.client.findUnique({ where: { id: c.id } }))?.active, false)
  })

  it("client lié à un chantier → refus explicite, ligne conservée, aucune revalidation", async () => {
    asAdmin(companyA)
    const c = await newClient("Avec chantier")
    await real.worksite.create({ data: { name: "W", clientId: c.id, companyId: companyA, createdById: adminA } })
    const r = await actions.deleteClient(c.id)
    assert.match(r.error ?? "", /1 chantier lié à ce client/)
    assert.equal(await count(c.id), 1)
    assert.deepEqual(revalidated, [])
  })

  it("chantier + 2 devis + accès portail → message cumulé, « 2 devis » invariant", async () => {
    asAdmin(companyA)
    const c = await newClient("Avec devis")
    const w = await real.worksite.create({ data: { name: "W2", clientId: c.id, companyId: companyA, createdById: adminA } })
    for (const n of ["0001", "0002"]) {
      await real.quote.create({ data: { companyId: companyA, worksiteId: w.id, clientId: c.id, number: `DEV-${suffix}-${n}`, createdById: adminA } })
    }
    const u = await newPortalUser()
    await real.clientProfile.create({ data: { clientId: c.id, userId: u.id } })
    const r = await actions.deleteClient(c.id)
    assert.equal(r.error, "Impossible de supprimer : 1 chantier, 2 devis, 1 accès portail liés à ce client. Réaffectez ou supprimez d'abord ces éléments.")
    assert.doesNotMatch(r.error ?? "", /deviss/)
    assert.equal(await count(c.id), 1)
  })

  it("isolation : l'ADMIN de B ne voit ni ne supprime un client de A (verrou borné companyId)", async () => {
    const c = await newClient("De A")
    asAdmin(companyB)
    assert.deepEqual(await actions.deleteClient(c.id), { error: "Client introuvable." })
    assert.equal(await count(c.id), 1)
    assert.deepEqual(revalidated, [])
  })

  it("TEAM_LEADER → Accès refusé avant toute lecture, ligne conservée", async () => {
    const c = await newClient("TL")
    asAdmin(companyA, "TEAM_LEADER")
    await assert.rejects(() => actions.deleteClient(c.id), /Accès refusé/)
    assert.equal(await count(c.id), 1)
  })

  // ---- Ordre A : le rival a commencé AVANT l'action et ne valide qu'après la demande de verrou ------------

  /** Lance `work` dans une transaction rivale qui reste ouverte jusqu'à `release()`. */
  function rivalFirst(work: (tx: Prisma.TransactionClient) => Promise<void>) {
    const started = barrier()
    const done = barrier()
    const tx = rivalDb.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(RIVAL_LOCK_TIMEOUT_SQL)
      await work(tx)
      started.release()
      await done.released
    })
    tx.catch(() => {}) // le règlement est toujours attendu dans settle() ; évite un rejet non géré si started échoue
    /** Libère la barrière et attend le règlement de la transaction rivale ; à appeler dans un finally. */
    const settle = async () => {
      done.release()
      await withinMax(tx.then(() => undefined, () => undefined), "règlement de la transaction rivale")
    }
    return { tx, started: started.released, release: done.release, settle }
  }

  it("ordre A — profil rattaché par un rival non validé : l'action attend le verrou, puis refuse ; aucun profil cascadé", async () => {
    asAdmin(companyA)
    const c = await newClient("A profil")
    const u = await newPortalUser()
    const rival = rivalFirst(async (tx) => { await tx.clientProfile.create({ data: { clientId: c.id, userId: u.id } }) })
    try {
      await withinMax(rival.started, "insertion rivale")
      const pending = actions.deleteClient(c.id)
      assert.equal(await settledWithin(pending, HOLD_MS), false, `l'action doit attendre le verrou pendant ${HOLD_MS} ms (KEY SHARE du rival)`)
      await rival.settle() // commit rival
      const r = await withinMax(pending, "action après commit rival")
      assert.match(r.error ?? "", /1 accès portail lié à ce client/)
      assert.equal(await count(c.id), 1)
      assert.equal(await real.clientProfile.count({ where: { clientId: c.id } }), 1)
      assert.equal(await real.user.count({ where: { id: u.id } }), 1)
      assert.deepEqual(revalidated, [])
    } finally {
      await rival.settle() // libère et attend la transaction rivale même si une assertion a échoué
    }
  })

  it("ordre A — chantier rattaché par un rival non validé : l'action attend, puis refuse « 1 chantier »", async () => {
    asAdmin(companyA)
    const c = await newClient("A chantier")
    const rival = rivalFirst(async (tx) => { await tx.worksite.create({ data: { name: "R", clientId: c.id, companyId: companyA, createdById: adminA } }) })
    try {
      await withinMax(rival.started, "insertion rivale")
      const pending = actions.deleteClient(c.id)
      assert.equal(await settledWithin(pending, HOLD_MS), false, "l'action doit attendre le verrou")
      await rival.settle() // commit rival
      const r = await withinMax(pending, "action après commit rival")
      assert.match(r.error ?? "", /1 chantier lié à ce client/)
      assert.equal(await count(c.id), 1)
      assert.equal(await real.worksite.count({ where: { clientId: c.id } }), 1)
    } finally {
      await rival.settle() // libère et attend la transaction rivale même si une assertion a échoué
    }
  })

  it("ordre A — client supprimé par un rival non validé : l'action attend, puis « Client introuvable. »", async () => {
    asAdmin(companyA)
    const c = await newClient("A delete")
    const rival = rivalFirst(async (tx) => { await tx.client.delete({ where: { id: c.id } }) })
    try {
      await withinMax(rival.started, "suppression rivale")
      const pending = actions.deleteClient(c.id)
      assert.equal(await settledWithin(pending, HOLD_MS), false, "l'action doit attendre le verrou")
      await rival.settle() // commit rival
      assert.deepEqual(await withinMax(pending, "action"), { error: "Client introuvable." })
      assert.equal(await count(c.id), 0)
      assert.deepEqual(revalidated, [])
    } finally {
      await rival.settle() // libère et attend la transaction rivale même si une assertion a échoué
    }
  })

  it("ordre A — client transféré à B par un rival non validé : l'action attend, puis « Client introuvable. », ligne conservée chez B", async () => {
    asAdmin(companyA)
    const c = await newClient("A transfert")
    const rival = rivalFirst(async (tx) => { await tx.client.update({ where: { id: c.id }, data: { companyId: companyB } }) })
    try {
      await withinMax(rival.started, "transfert rival")
      const pending = actions.deleteClient(c.id)
      assert.equal(await settledWithin(pending, HOLD_MS), false, "l'action doit attendre le verrou")
      await rival.settle() // commit rival
      assert.deepEqual(await withinMax(pending, "action"), { error: "Client introuvable." })
      assert.equal((await real.client.findUnique({ where: { id: c.id } }))?.companyId, companyB)
      assert.deepEqual(revalidated, [])
    } finally {
      await rival.settle() // libère et attend la transaction rivale même si une assertion a échoué
    }
  })

  // ---- Ordre B : l'action tient le verrou ; le rival arrive entre la lecture et la suppression ---------

  it("ordre B — profil rattaché pendant la fenêtre lecture→suppression : le rival attend, l'action supprime, l'insertion rivale échoue (FK) ; aucun profil créé", async () => {
    asAdmin(companyA)
    const c = await newClient("B profil")
    const u = await newPortalUser()
    let rival: Promise<unknown> | null = null
    let rivalWaited = false
    afterLockedRead = async () => {
      rival = rivalOp((tx) => tx.clientProfile.create({ data: { clientId: c.id, userId: u.id } }))
      rival.catch(() => {}) // règlement attendu plus bas (assert.rejects)
      rivalWaited = !(await settledWithin(rival, HOLD_MS))
    }
    const r = await withinMax(actions.deleteClient(c.id), "action")
    assert.deepEqual(r, { success: true })
    assert.equal(rivalWaited, true, `le rival doit rester bloqué ${HOLD_MS} ms sur le verrou FOR UPDATE`)
    await assert.rejects(withinMax(rival!, "rival"), isP2003)
    assert.equal(await count(c.id), 0)
    assert.equal(await real.clientProfile.count({ where: { userId: u.id } }), 0)
    assert.equal(await real.user.count({ where: { id: u.id } }), 1)
    assert.deepEqual(revalidated, ["/clients"])
  })

  it("ordre B — chantier rattaché pendant la fenêtre : le rival attend, l'action supprime, l'insertion rivale échoue (FK)", async () => {
    asAdmin(companyA)
    const c = await newClient("B chantier")
    let rival: Promise<unknown> | null = null
    let rivalWaited = false
    afterLockedRead = async () => {
      rival = rivalOp((tx) => tx.worksite.create({ data: { name: "R", clientId: c.id, companyId: companyA, createdById: adminA } }))
      rival.catch(() => {}) // règlement attendu plus bas (assert.rejects)
      rivalWaited = !(await settledWithin(rival, HOLD_MS))
    }
    assert.deepEqual(await withinMax(actions.deleteClient(c.id), "action"), { success: true })
    assert.equal(rivalWaited, true, "le rival doit rester bloqué sur le verrou")
    await assert.rejects(withinMax(rival!, "rival"), isP2003)
    assert.equal(await count(c.id), 0)
    assert.equal(await real.worksite.count({ where: { clientId: c.id } }), 0)
  })

  it("ordre B — suppression rivale pendant la fenêtre : le rival attend, l'action supprime, le rival trouve la ligne absente (P2025)", async () => {
    asAdmin(companyA)
    const c = await newClient("B delete")
    let rival: Promise<unknown> | null = null
    let rivalWaited = false
    afterLockedRead = async () => {
      rival = rivalOp((tx) => tx.client.delete({ where: { id: c.id } }))
      rival.catch(() => {}) // règlement attendu plus bas (assert.rejects)
      rivalWaited = !(await settledWithin(rival, HOLD_MS))
    }
    assert.deepEqual(await withinMax(actions.deleteClient(c.id), "action"), { success: true })
    assert.equal(rivalWaited, true, "le rival doit rester bloqué sur le verrou")
    await assert.rejects(withinMax(rival!, "rival"), isP2025)
    assert.equal(await count(c.id), 0)
  })

  it("ordre B — transfert rival pendant la fenêtre : le rival attend, l'action supprime, le transfert échoue (P2025)", async () => {
    asAdmin(companyA)
    const c = await newClient("B transfert")
    let rival: Promise<unknown> | null = null
    let rivalWaited = false
    afterLockedRead = async () => {
      rival = rivalOp((tx) => tx.client.update({ where: { id: c.id }, data: { companyId: companyB } }))
      rival.catch(() => {}) // règlement attendu plus bas (assert.rejects)
      rivalWaited = !(await settledWithin(rival, HOLD_MS))
    }
    assert.deepEqual(await withinMax(actions.deleteClient(c.id), "action"), { success: true })
    assert.equal(rivalWaited, true, "le rival doit rester bloqué sur le verrou")
    await assert.rejects(withinMax(rival!, "rival"), isP2025)
    assert.equal(await count(c.id), 0)
  })

  // ---- Borne temporelle de l'action -------------------------------------------------------------------

  it("rival gardant la ligne au-delà de lock_timeout (4 s) → PostgreSQL 55P03 traduit, rien modifié, pas de revalidation", async () => {
    asAdmin(companyA)
    const c = await newClient("Timeout")
    const u = await newPortalUser()
    const rival = rivalFirst(async (tx) => { await tx.clientProfile.create({ data: { clientId: c.id, userId: u.id } }) })
    try {
      await withinMax(rival.started, "insertion rivale")
      const t0 = Date.now()
      const r = await withinMax(actions.deleteClient(c.id), "action (lock_timeout 4 s)")
      const waited = Date.now() - t0
      assert.ok(waited >= 3_500 && waited < MAX_WAIT_MS, `attente bornée par lock_timeout (mesuré ${waited} ms)`)
      await rival.settle() // commit rival
      assert.match(r.error ?? "", /Une autre opération est en cours sur ce client/)
      assert.equal(await count(c.id), 1)
      assert.equal(await real.clientProfile.count({ where: { clientId: c.id } }), 1)
      assert.deepEqual(revalidated, [])
    } finally {
      await rival.settle() // libère et attend la transaction rivale même si une assertion a échoué
    }
  })
})
