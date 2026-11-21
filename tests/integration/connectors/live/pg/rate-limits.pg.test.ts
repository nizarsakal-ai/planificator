/**
 * PLAN-INTEGRATION-PLATFORM-001 — LOT-8D : limites de débit des connexions réelles (SECURITY-SPEC §25) sur une base
 * PostgreSQL JETABLE migrée, avec les vrais services du coffre. Services distants simulés ; `fetch` global interdit.
 * Exécution : TEST_PG_ADMIN_URL=… sh tests/billing/pg/with-disposable-db.sh rl npm run test:live-rate-limits:pg
 */
import assert from "node:assert/strict"
import { randomBytes } from "node:crypto"
import { after, before, describe, it } from "node:test"
import { PrismaClient } from "@prisma/client"
import type { FetchLike } from "@/lib/integration/connectors/live/live-http"
import { configureLiveConnector, type LiveDeps } from "@/lib/integration/connectors/live/live-connection.service"
import { RATE_LIMITS, RATE_LIMIT_MESSAGES, checkOAuthStartLimit } from "@/lib/integration/connectors/live/live-rate-limits"
import { handleGoogleCalendarConnect, type GoogleRouteDeps } from "@/lib/integration/connectors/oauth/google-calendar-routes"
import { loadKeyring } from "@/lib/integration/secrets/keyring"

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL requis (base PostgreSQL jetable migrée)")
const db = new PrismaClient()
const A = { companyId: "rlA", userId: "rlUA" }
const A2 = { companyId: "rlA", userId: "rlUA2" }
const B = { companyId: "rlB", userId: "rlUB" }
const keyring = loadKeyring({ INTEGRATION_KEK_ACTIVE_ID: "k1", INTEGRATION_KEK_K1: randomBytes(32).toString("base64") })
const ENV = { GOOGLE_CALENDAR_CLIENT_ID: "1234567890-abcdef.apps.googleusercontent.com", GOOGLE_CALENDAR_CLIENT_SECRET: "secret-de-test-" + "x".repeat(8), NEXTAUTH_URL: "https://planificator.test", CONNECTOR_LIVE_ENABLED: "true" }
const originalFetch = globalThis.fetch
let networkCalls = 0
const token = (c: string) => "shp" + "at_" + c.repeat(32)
const shop = (ok: boolean): FetchLike => async () => ({ status: ok ? 200 : 401, text: async () => JSON.stringify(ok ? { shop: { id: 1 } } : {}) })
const deps = (ok: boolean, now = new Date()): LiveDeps => ({ fetch: shop(ok), secrets: { keyring, environment: "test" }, now: () => now })
const form = (c: string) => ({ shopDomain: "rl-boutique.myshopify.com", accessToken: token(c) })
const connect = (ctx: { companyId: string; userId: string }, now: Date) => {
  const d: GoogleRouteDeps = { access: async () => ({ ok: true, context: { ...ctx, role: "ADMIN" } }), db, env: ENV, now: () => now }
  return handleGoogleCalendarConnect(new Request("https://planificator.test/api/connecteurs/google-agenda/connect"), d)
}
const isGoogle = (r: Response) => new URL(r.headers.get("location")!).host === "accounts.google.com"
const erreur = (r: Response) => new URL(r.headers.get("location")!).searchParams.get("erreur")

before(async () => {
  globalThis.fetch = (async () => { networkCalls++; throw new Error("réseau interdit en test") }) as typeof fetch
  for (const [id, slug, n] of [["rlA", "rl-a", 1], ["rlB", "rl-b", 2]] as const) {
    await db.$executeRawUnsafe(`INSERT INTO companies(id,name,slug,siret,address,"updatedAt") VALUES ('${id}','Société ${id}','${slug}','1112223330001${n}','1 rue',now())`)
  }
  await db.$executeRawUnsafe(`INSERT INTO users(id,email,password,"updatedAt") VALUES ('rlUA','rla@x.test','x',now()),('rlUA2','rla2@x.test','x',now()),('rlUB','rlb@x.test','x',now())`)
})
after(async () => {
  globalThis.fetch = originalFetch
  assert.equal(networkCalls, 0, "aucun appel réseau réel")
  await db.$disconnect()
})

describe("démarrage OAuth (§25)", () => {
  it("5 par utilisateur et par 10 minutes ; un autre utilisateur ou une autre société n'est pas touché ; la fenêtre glisse", async () => {
    const t0 = new Date("2026-12-02T10:00:00Z")
    for (let i = 0; i < RATE_LIMITS.oauthStartPerUser.max; i++) assert.ok(isGoogle(await connect(A, t0)), `démarrage ${i + 1}`)
    const refused = await connect(A, t0)
    assert.equal(erreur(refused), RATE_LIMIT_MESSAGES.oauthStart)
    assert.equal(await db.integrationOAuthState.count({ where: { userId: "rlUA" } }), 5, "aucun état créé par le refus")
    assert.ok(isGoogle(await connect(A2, t0)), "autre utilisateur")
    assert.ok(isGoogle(await connect(B, t0)), "autre société")
    assert.ok(isGoogle(await connect(A, new Date(t0.getTime() + 10 * 60_000 + 1))), "après 10 minutes")
  })
  it("20 par société et par heure, tous utilisateurs confondus", async () => {
    const t0 = new Date("2026-12-03T10:00:00Z")
    await db.integrationOAuthState.createMany({ data: Array.from({ length: 20 }, (_, i) => ({ companyId: "rlB", userId: "rlUB", connectorKey: "google_calendar", stateHash: i.toString(16).padStart(64, "c"), browserHash: "d".repeat(64), codeVerifier: "v".repeat(43), createdAt: new Date(t0.getTime() - 30 * 60_000), expiresAt: new Date(t0.getTime() - 25 * 60_000) })) })
    assert.equal(await checkOAuthStartLimit(db, { companyId: "rlB", userId: "nouvel-utilisateur" }, t0), RATE_LIMIT_MESSAGES.oauthStart)
    assert.equal(await checkOAuthStartLimit(db, { companyId: "rlB", userId: "nouvel-utilisateur" }, new Date(t0.getTime() + 31 * 60_000)), null, "après une heure")
  })
})

describe("identifiants (§25)", () => {
  it("3 refus du service en 15 minutes ⇒ verrou de 15 minutes, sans nouvelle version ni appel au service ; levé ensuite", async () => {
    const now = new Date()
    for (let i = 0; i < RATE_LIMITS.authFailuresLock.max; i++) assert.equal((await configureLiveConnector(db, A, "shopify", form("A"), deps(false, now))).ok, false)
    const versions = await db.integrationCredentialVersion.count({ where: { companyId: "rlA" } })
    let calls = 0
    const counting: FetchLike = async (...a) => { calls++; return shop(true)(...a) }
    assert.deepEqual(await configureLiveConnector(db, A, "shopify", form("B"), { ...deps(true, now), fetch: counting }), { ok: false, error: RATE_LIMIT_MESSAGES.authLocked })
    assert.equal(calls, 0, "aucun appel au service pendant le verrou")
    assert.equal(await db.integrationCredentialVersion.count({ where: { companyId: "rlA" } }), versions, "aucune version créée")
    const later = new Date(now.getTime() + 16 * 60_000)
    assert.equal((await configureLiveConnector(db, A, "shopify", form("B"), deps(true, later))).ok, true, "verrou levé après 15 minutes")
  })
  it("5 enregistrements par connexion et par 10 minutes, même réussis", async () => {
    const base = new Date()
    for (let i = 0; i < RATE_LIMITS.credentialAttemptsPerConnection.max; i++) assert.equal((await configureLiveConnector(db, B, "shopify", form(String.fromCharCode(67 + i)), deps(true, base))).ok, true, `enregistrement ${i + 1}`)
    assert.deepEqual(await configureLiveConnector(db, B, "shopify", form("Z"), deps(true, base)), { ok: false, error: RATE_LIMIT_MESSAGES.credentialAttempts })
  })
})
