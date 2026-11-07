// V2 06/11/2026 — actions serveur des devis (import réel, doubles @/auth, @/lib/prisma, next/cache, next/headers) :
// refus d'une session NON administrateur, du module désactivé et d'une saisie invalide AVANT tout accès à la base.
// Même patron que tests/clients/client-partners.actions.test.ts. Écrit sur le VPS, NON EXÉCUTÉ sur le VPS :
// environnement isolé autorisé uniquement (npm run test:devis-v2:actions).
import assert from "node:assert/strict"
import { beforeEach, describe, it, mock } from "node:test"

let session: unknown = null
const dbCalls: string[] = []
// Double Prisma : TOUTE lecture/écriture est journalisée ; les cas de refus exigent zéro appel.
const db = new Proxy({}, {
  get: (_t, model: string) => (model === "$transaction"
    ? async () => { dbCalls.push("$transaction"); throw new Error("accès base inattendu") }
    : new Proxy({}, { get: (_m, op: string) => async () => { dbCalls.push(`${model}.${op}`); throw new Error("accès base inattendu") } })),
})
mock.module("@/auth", { namedExports: { auth: async () => session } })
mock.module("@/lib/prisma", { namedExports: { prisma: db } })
mock.module("next/cache", { namedExports: { revalidatePath: () => undefined } })
mock.module("next/headers", { namedExports: { headers: async () => new Headers() } })

type Actions = typeof import("@/lib/actions/quote.actions")
let actions: Actions
const recipient = { name: "Carline Bourguine", email: "c.bourguine@chayou.example", source: "CONSULTATION" }
const as = (role: string | null, companyId: string | null = "coA") => { session = role === null ? null : { user: { id: "u1", role, companyId, email: "u@t.local", name: "U" } } }

beforeEach(async () => {
  dbCalls.length = 0
  process.env.BILLING_COMPLETE_ENABLED = "true"
  actions ??= await import("@/lib/actions/quote.actions")
})

describe("actions devis : droits et validation avant toute écriture", () => {
  it("session NON administrateur (TEAM_LEADER, EMPLOYEE) : envoi, statut et conversion refusés, aucun accès base", async () => {
    for (const role of ["TEAM_LEADER", "EMPLOYEE", "CLIENT"]) {
      as(role)
      assert.deepEqual(await actions.sendQuoteAction("q1", recipient), { ok: false, error: "Accès refusé." }, role)
      assert.deepEqual(await actions.convertQuoteAction("q1", "BC-1"), { ok: false, error: "Accès refusé." }, role)
      assert.deepEqual(await actions.quoteStatusAction("q1", "ACCEPTED"), { ok: false, error: "Accès refusé." }, role)
    }
    assert.deepEqual(dbCalls, [])
  })
  it("non connecté, ou administrateur sans société : refusés, aucun accès base", async () => {
    as(null)
    assert.deepEqual(await actions.sendQuoteAction("q1", recipient), { ok: false, error: "Non authentifié." })
    as("ADMIN", null)
    assert.deepEqual(await actions.convertQuoteAction("q1"), { ok: false, error: "Accès refusé." })
    assert.deepEqual(dbCalls, [])
  })
  it("module désactivé : refus sans révéler le module, aucun accès base", async () => {
    process.env.BILLING_COMPLETE_ENABLED = "false"
    as("ADMIN")
    assert.deepEqual(await actions.sendQuoteAction("q1", recipient), { ok: false, error: "Fonctionnalité indisponible." })
    assert.deepEqual(dbCalls, [])
  })
  it("administrateur : destinataire absent ou invalide et bon de commande hors encodage refusés AVANT la session et la base", async () => {
    as("ADMIN")
    assert.deepEqual(await actions.sendQuoteAction("q1", undefined), { ok: false, error: "Destinataire invalide." })
    assert.deepEqual(await actions.sendQuoteAction("q1", { ...recipient, email: "carline@" }), { ok: false, error: "Adresse e-mail du destinataire invalide." })
    assert.deepEqual(await actions.sendQuoteAction("q1", { ...recipient, companyId: "coB" }), { ok: false, error: "Destinataire invalide." })
    const r = await actions.convertQuoteAction("q1", "BC-Ж"); assert.equal(r.ok, false)
    if (!r.ok) assert.match(r.error, /non pris en charge/)
    assert.deepEqual(dbCalls, [])
  })
})
