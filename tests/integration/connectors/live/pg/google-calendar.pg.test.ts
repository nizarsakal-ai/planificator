/**
 * PLAN-INTEGRATION-PLATFORM-001 — LOT-8C : Google Agenda (OAuth, lecture seule) sur une base PostgreSQL JETABLE migrée,
 * avec les vrais services du coffre (LOT-8A). Google est un DOUBLE (serveur de jetons et API Agenda) ; `fetch` global
 * est remplacé par un compteur (zéro appel réseau attendu). Jetons construits à l'exécution, sans entropie.
 * Exécution : TEST_PG_ADMIN_URL=postgresql://postgres@127.0.0.1:5432/postgres \
 *   sh tests/billing/pg/with-disposable-db.sh gcal npm run test:google-calendar:pg
 */
import assert from "node:assert/strict"
import { randomBytes } from "node:crypto"
import { after, before, describe, it } from "node:test"
import { PrismaClient } from "@prisma/client"
import * as svc from "@/lib/connectors/connectors.service"
import { SYNC_ERROR_LABEL } from "@/lib/connectors/connectors.core"
import type { FetchLike } from "@/lib/integration/connectors/live/live-http"
import { revokeLiveConnector, type LiveDeps } from "@/lib/integration/connectors/live/live-connection.service"
import { runLiveConnectorSync } from "@/lib/integration/connectors/live/live-sync.service"
import {
  GOOGLE_CALENDAR_SCOPE, GOOGLE_OAUTH_MESSAGES, googleAccessTokenForSync, readGoogleCalendarOAuthConfig, startGoogleCalendarOAuth, type TokenPost,
} from "@/lib/integration/connectors/oauth/google-calendar-oauth"
import { handleGoogleCalendarConnect, handleGoogleCalendarCallback, type GoogleRouteDeps } from "@/lib/integration/connectors/oauth/google-calendar-routes"
import { loadKeyring } from "@/lib/integration/secrets/keyring"

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL requis (base PostgreSQL jetable migrée)")
const db = new PrismaClient()
const A = { companyId: "gcA", userId: "gcUA" }
const B = { companyId: "gcB", userId: "gcUB" }
const ENV = { GOOGLE_CALENDAR_CLIENT_ID: "1234567890-abcdef.apps.googleusercontent.com", GOOGLE_CALENDAR_CLIENT_SECRET: "secret-de-test-" + "x".repeat(8), NEXTAUTH_URL: "https://planificator.test", CONNECTOR_LIVE_ENABLED: "true" }
const CFG = readGoogleCalendarOAuthConfig(ENV)!
const RT1 = "rt-" + "a".repeat(24), RT2 = "rt-" + "d".repeat(24)
const AT = "at-" + "b".repeat(24)
const keyring = loadKeyring({ INTEGRATION_KEK_ACTIVE_ID: "k1", INTEGRATION_KEK_K1: randomBytes(32).toString("base64") })
const secrets = { keyring, environment: "test" as const }
const originalFetch = globalThis.fetch
let networkCalls = 0

/** Double de Google : serveur de jetons (échange, rafraîchissement, révocation) et API Agenda. */
const google = {
  exchange: { status: 200, body: { access_token: AT, refresh_token: RT1, scope: GOOGLE_CALENDAR_SCOPE } as Record<string, unknown> },
  refresh: { status: 200, body: { access_token: AT } as Record<string, unknown> },
  validRefresh: new Set([RT1, RT2]),
  tokenCalls: [] as { path: string; form: Record<string, string> }[],
  inFlight: 0, maxInFlight: 0, refreshDelayMs: 0,
  events: [] as Record<string, unknown>[],
  syncTokenValid: true,
  calendarCalls: [] as URL[],
}
const post: TokenPost = async (_host, path, form) => {
  google.tokenCalls.push({ path, form })
  if (path === "/revoke") return { status: 200, body: {} }
  if (form.grant_type === "authorization_code") return google.exchange
  google.inFlight++; google.maxInFlight = Math.max(google.maxInFlight, google.inFlight)
  try {
    if (google.refreshDelayMs) await new Promise((r) => setTimeout(r, google.refreshDelayMs))
    if (!google.validRefresh.has(form.refresh_token)) return { status: 400, body: { error: "invalid_grant" } }
    return google.refresh
  } finally { google.inFlight-- }
}
const calendarFetch: FetchLike = async (input, init) => {
  const u = new URL(input)
  google.calendarCalls.push(u)
  if (init.headers.authorization !== `Bearer ${AT}`) return { status: 401, text: async () => "{}" }
  if (u.pathname === "/calendar/v3/calendars/primary") return { status: 200, text: async () => JSON.stringify({ id: "primary" }) }
  if (u.searchParams.get("syncToken")) {
    if (!google.syncTokenValid) return { status: 410, text: async () => "{}" }
    return { status: 200, text: async () => JSON.stringify({ items: google.events.filter((e) => e.changed), nextSyncToken: "SYNC-2" }) }
  }
  return { status: 200, text: async () => JSON.stringify({ items: google.events, nextSyncToken: "SYNC-1" }) }
}
const ev = (i: number, extra: Record<string, unknown> = {}) => ({ id: `ev${i}`, status: "confirmed", summary: `Chantier ${i}`, location: "Lyon", start: { dateTime: "2026-12-01T08:00:00+01:00" }, end: { dateTime: "2026-12-01T10:00:00+01:00" }, ...extra })

let clock = Date.parse("2026-12-01T09:00:00Z")
const tick = (ms = 61_000) => { clock += ms; return new Date(clock) }
const now = () => new Date(clock)
const access = (ctx: { companyId: string; userId: string }) => async () => ({ ok: true as const, context: { ...ctx, role: "ADMIN" as const } })
const routeDeps = (ctx = A, o: Partial<GoogleRouteDeps> = {}): GoogleRouteDeps => ({ access: access(ctx), db, env: ENV, now, post, fetch: calendarFetch, secrets, ...o })
const liveDeps = (): LiveDeps => ({ fetch: calendarFetch, tokenPost: post, secrets, env: ENV, now: () => tick(), sleep: async () => undefined })
const ok = <T>(r: { ok: true; value: T } | { ok: false; error: string }): T => { assert.ok(r.ok, r.ok ? "" : r.error); return (r as { ok: true; value: T }).value }

/** Démarre un flux (état en base) et renvoie le `state` et le cookie du navigateur. */
async function start(ctx = A) {
  const { authUrl, browserNonce } = await startGoogleCalendarOAuth(db, ctx, CFG, { now: now() })
  return { state: new URL(authUrl).searchParams.get("state")!, cookie: `gcal_oauth=${browserNonce}` }
}
async function callback(q: Record<string, string>, cookie: string | null, ctx = A) {
  const url = new URL("https://planificator.test/api/connecteurs/google-agenda/callback")
  for (const [k, v] of Object.entries(q)) url.searchParams.set(k, v)
  const r = await handleGoogleCalendarCallback(new Request(url, { headers: cookie ? { cookie } : {} }), routeDeps(ctx))
  const loc = new URL(r.headers.get("location")!)
  return { ok: loc.searchParams.get("ok"), erreur: loc.searchParams.get("erreur"), cookie: r.headers.get("set-cookie") }
}
const connection = async () => {
  const s = await svc.readConnectorSetting(db, A, "google_calendar")
  return s?.connectionId ? db.integrationConnection.findUniqueOrThrow({ where: { id: s.connectionId } }) : null
}

before(async () => {
  globalThis.fetch = (async () => { networkCalls++; throw new Error("réseau interdit en test") }) as typeof fetch
  for (const [id, slug, n] of [["gcA", "gc-a", 1], ["gcB", "gc-b", 2]] as const) {
    await db.$executeRawUnsafe(`INSERT INTO companies(id,name,slug,siret,address,"updatedAt") VALUES ('${id}','Société ${id}','${slug}','5556667770001${n}','1 rue',now())`)
  }
  await db.$executeRawUnsafe(`INSERT INTO users(id,email,password,"updatedAt") VALUES ('gcUA','gca@x.test','x',now()),('gcUB','gcb@x.test','x',now()),('gcUA2','gca2@x.test','x',now())`)
})
after(async () => {
  globalThis.fetch = originalFetch
  assert.equal(networkCalls, 0, "aucun appel réseau réel")
  await db.$disconnect()
})

describe("état OAuth à usage unique (§11.2)", () => {
  it("en base : empreintes seulement, 10 minutes ; jamais le state ni le cookie", async () => {
    const { state, cookie } = await start()
    const rows = await db.$queryRawUnsafe<{ t: string }[]>(`SELECT row_to_json(s)::text AS t FROM integration_oauth_states s`)
    assert.equal(rows.length, 1)
    assert.ok(!rows[0].t.includes(state) && !rows[0].t.includes(cookie.split("=")[1]))
    const s = await db.integrationOAuthState.findFirstOrThrow()
    assert.equal(s.expiresAt.getTime() - s.createdAt.getTime(), 600_000)
  })
  it("refus : autre navigateur, autre utilisateur, autre société, sans cookie, state inconnu, expiré ; aucun échange de code", async () => {
    const before = google.tokenCalls.length
    const { state, cookie } = await start()
    assert.equal((await callback({ code: "c", state }, "gcal_oauth=" + "Z".repeat(43))).erreur, GOOGLE_OAUTH_MESSAGES.stateInvalid, "autre navigateur")
    assert.equal((await callback({ code: "c", state }, cookie)).erreur, GOOGLE_OAUTH_MESSAGES.stateInvalid, "déjà consommé par la tentative précédente")
    const s2 = await start()
    assert.equal((await callback({ code: "c", state: s2.state }, s2.cookie, { companyId: "gcA", userId: "gcUA2" })).erreur, GOOGLE_OAUTH_MESSAGES.stateInvalid, "autre utilisateur")
    assert.equal((await callback({ code: "c", state: s2.state }, s2.cookie, B)).erreur, GOOGLE_OAUTH_MESSAGES.stateInvalid, "autre société")
    assert.equal((await callback({ code: "c", state: s2.state }, null)).erreur, GOOGLE_OAUTH_MESSAGES.stateInvalid, "sans cookie")
    assert.equal((await callback({ code: "c", state: "Q".repeat(43) }, s2.cookie)).erreur, GOOGLE_OAUTH_MESSAGES.stateInvalid, "inconnu")
    const s3 = await start()
    tick(601_000)
    assert.equal((await callback({ code: "c", state: s3.state }, s3.cookie)).erreur, GOOGLE_OAUTH_MESSAGES.stateInvalid, "expiré")
    assert.equal(google.tokenCalls.length, before, "aucun échange de code")
  })
  it("refus de l'utilisateur chez Google : message, état consommé ; la base refuse toute réutilisation ou modification", async () => {
    const { state, cookie } = await start()
    const r = await callback({ error: "access_denied", state }, cookie)
    assert.equal(r.erreur, GOOGLE_OAUTH_MESSAGES.denied)
    assert.match(r.cookie!, /^gcal_oauth=; .*Max-Age=0/, "cookie effacé")
    const consumed = await db.integrationOAuthState.findFirstOrThrow({ where: { consumedAt: { not: null } }, orderBy: { createdAt: "desc" } })
    assert.equal(consumed.codeVerifier, null, "vérificateur effacé à la consommation")
    await assert.rejects(db.$executeRawUnsafe(`UPDATE integration_oauth_states SET "consumedAt" = NULL WHERE id = '${consumed.id}'`), /already consumed|values_check/)
    const fresh = await start()
    void fresh
    const open = await db.integrationOAuthState.findFirstOrThrow({ where: { consumedAt: null }, orderBy: { createdAt: "desc" } })
    await assert.rejects(db.$executeRawUnsafe(`UPDATE integration_oauth_states SET "stateHash" = '${"0".repeat(64)}' WHERE id = '${open.id}'`), /oauth state immutable/)
    await assert.rejects(db.$executeRawUnsafe(`INSERT INTO integration_oauth_states(id,"companyId","userId","connectorKey","stateHash","browserHash","codeVerifier","createdAt","expiresAt") VALUES ('x','gcA','gcUA','google_calendar','${"a".repeat(64)}','${"b".repeat(64)}','${"v".repeat(43)}',now(),now() + interval '1 hour')`), /values_check/, "durée de vie bornée en base")
  })
})

describe("retour Google et coffre", () => {
  it("portée insuffisante ⇒ refus, rien n'est stocké", async () => {
    google.exchange = { status: 200, body: { access_token: AT, refresh_token: RT1, scope: "openid" } }
    const { state, cookie } = await start()
    assert.equal((await callback({ code: "c", state }, cookie)).erreur, GOOGLE_OAUTH_MESSAGES.scope)
    assert.equal(await db.integrationCredentialVersion.count(), 0)
  })
  it("aucun refresh token ⇒ connexion PENDING_AUTH, reconnexion demandée, rien n'est stocké", async () => {
    google.exchange = { status: 200, body: { access_token: AT, scope: GOOGLE_CALENDAR_SCOPE } }
    const { state, cookie } = await start()
    assert.equal((await callback({ code: "c", state }, cookie)).erreur, GOOGLE_OAUTH_MESSAGES.noRefreshToken)
    assert.equal((await connection())?.status, "PENDING_AUTH")
    assert.equal(await db.integrationCredentialVersion.count(), 0)
  })
  it("succès : PKCE envoyé, refresh token chiffré (OAUTH_REFRESH_TOKEN) PENDING → vérification → ACTIVE ; connexion ACTIVE", async () => {
    google.exchange = { status: 200, body: { access_token: AT, refresh_token: RT1, scope: GOOGLE_CALENDAR_SCOPE } }
    const { state, cookie } = await start()
    const r = await callback({ code: "code-ok", state }, cookie)
    assert.equal(r.ok, GOOGLE_OAUTH_MESSAGES.connected)
    const ex = google.tokenCalls.at(-1)!
    assert.equal(ex.form.grant_type, "authorization_code")
    assert.match(ex.form.code_verifier, /^[A-Za-z0-9_-]{64}$/)
    assert.equal(ex.form.redirect_uri, CFG.redirectUri)
    const c = (await connection())!
    assert.deepEqual([c.status, c.credentialStatus, c.secretBackend, c.connectorType], ["ACTIVE", "ACTIVE", "PLATFORM_ENCRYPTED", "google_calendar"])
    assert.deepEqual(c.config, { calendarId: "primary" })
    const v = await db.integrationCredentialVersion.findMany({ where: { connectionId: c.id } })
    assert.deepEqual(v.map((x) => [x.secretKind, x.status]), [["OAUTH_REFRESH_TOKEN", "ACTIVE"]])
  })
  it("Preview conserve le domaine fixe et ne consomme pas un état reçu sur un autre hôte", async () => {
    const origin = "https://preview.test"
    const env = { ...ENV, VERCEL_ENV: "preview", GOOGLE_CALENDAR_PREVIEW_ORIGIN: origin }
    const d = routeDeps(B, { env })
    const connect = await handleGoogleCalendarConnect(new Request(origin + "/api/connecteurs/google-agenda/connect"), d)
    const authorize = new URL(connect.headers.get("location")!)
    const redirect = origin + "/api/connecteurs/google-agenda/callback"
    assert.equal(authorize.searchParams.get("redirect_uri"), redirect)
    const cookie = connect.headers.get("set-cookie")!.split(";")[0]
    const q = new URLSearchParams({ code: "code-preview", state: authorize.searchParams.get("state")! })
    const callsBefore = google.tokenCalls.length
    const wrong = await handleGoogleCalendarCallback(new Request("https://branch-preview.test/api/connecteurs/google-agenda/callback?" + q, { headers: { cookie } }), d)
    assert.ok(new URL(wrong.headers.get("location")!).searchParams.get("erreur"))
    assert.equal(google.tokenCalls.length, callsBefore)
    const callback = await handleGoogleCalendarCallback(new Request(redirect + "?" + q, { headers: { cookie } }), d)
    const destination = new URL(callback.headers.get("location")!)
    assert.equal(destination.origin, origin)
    assert.equal(destination.searchParams.get("ok"), GOOGLE_OAUTH_MESSAGES.connected)
    assert.equal(google.tokenCalls.at(-1)?.form.redirect_uri, redirect)
  })
  it("aucun jeton en clair en base (versions, audit, historique, connexions, états)", async () => {
    for (const t of ["integration_credential_versions", "integration_secret_audit_logs", "history_logs", "integration_connections", "integration_oauth_states", "connector_settings"]) {
      const rows = await db.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*) AS n FROM ${t} x WHERE row_to_json(x)::text LIKE '%' || $1 || '%' OR row_to_json(x)::text LIKE '%' || $2 || '%'`, "a".repeat(24), "b".repeat(24))
      assert.equal(Number(rows[0].n), 0, t)
    }
  })
})

describe("synchronisation réelle (lecture seule)", () => {
  it("jeton d'accès par rafraîchissement, événements en zone de transit, curseur de synchronisation", async () => {
    ok(await svc.setConnectorMode(db, A, "google_calendar", "LIVE", undefined, { liveAllowed: true }))
    google.events = [ev(1), ev(2, { start: { date: "2026-12-24" }, end: { date: "2026-12-25" } })]
    const r = ok(await runLiveConnectorSync(db, A, "google_calendar", liveDeps()))
    assert.deepEqual({ received: r.received, created: r.created }, { received: 2, created: 2 })
    assert.ok(google.tokenCalls.some((c) => c.form.grant_type === "refresh_token" && c.form.refresh_token === RT1), "refresh avec le jeton du coffre")
    assert.match(r.watermark!, /^\{"events":"gc:[A-Za-z0-9_-]+"\}$/)
    const run = await db.connectorSyncRun.findUniqueOrThrow({ where: { id: r.runId } })
    assert.deepEqual([run.mode, run.status], ["LIVE", "SUCCEEDED"])
  })
  it("lecture incrémentale : seules les modifications ; événement supprimé ⇒ nouvelle version sans contenu", async () => {
    google.events = [ev(1), ev(2, { changed: true, status: "cancelled" })]
    const r = ok(await runLiveConnectorSync(db, A, "google_calendar", liveDeps()))
    assert.deepEqual({ received: r.received, updated: r.updated }, { received: 1, updated: 1 })
    assert.ok(google.calendarCalls.at(-1)!.searchParams.get("syncToken"))
    const rec = await db.connectorStagedRecord.findFirstOrThrow({ where: { companyId: A.companyId, connectorKey: "google_calendar", externalId: "ev2" } })
    assert.deepEqual([rec.version, (rec.payload as Record<string, unknown>).cancelled, (rec.payload as Record<string, unknown>).title], [2, true, null])
  })
  it("jeton de synchronisation périmé (410) ⇒ relecture complète, rien n'est doublé", async () => {
    google.syncTokenValid = false
    try {
      const r = ok(await runLiveConnectorSync(db, A, "google_calendar", liveDeps()))
      assert.deepEqual({ received: r.received, created: r.created, unchanged: r.unchanged }, { received: 2, created: 0, unchanged: 2 })
    } finally { google.syncTokenValid = true }
  })
  it("Google renouvelle le refresh token ⇒ nouvelle version ACTIVE, l'ancienne RETIRED ; jamais remplacé par du vide", async () => {
    google.refresh = { status: 200, body: { access_token: AT, refresh_token: RT2 } }
    ok(await runLiveConnectorSync(db, A, "google_calendar", liveDeps()))
    google.refresh = { status: 200, body: { access_token: AT, refresh_token: "" } }
    ok(await runLiveConnectorSync(db, A, "google_calendar", liveDeps()))
    google.refresh = { status: 200, body: { access_token: AT } }
    const c = (await connection())!
    const v = await db.integrationCredentialVersion.findMany({ where: { connectionId: c.id }, orderBy: { secretVersion: "asc" } })
    assert.deepEqual(v.map((x) => x.status), ["RETIRED", "ACTIVE"])
    google.tokenCalls = []
    ok(await runLiveConnectorSync(db, A, "google_calendar", liveDeps()))
    assert.equal(google.tokenCalls.find((x) => x.form.grant_type === "refresh_token")!.form.refresh_token, RT2)
  })
  it("rafraîchissements concurrents de la même connexion : sérialisés (jamais deux en vol)", async () => {
    const c = (await connection())!
    google.maxInFlight = 0; google.refreshDelayMs = 150
    try {
      const tokens = await Promise.all([1, 2, 3].map(() => googleAccessTokenForSync(db, A, c.id, { post, secrets, env: ENV })))
      assert.deepEqual(tokens, [AT, AT, AT])
      assert.equal(google.maxInFlight, 1)
    } finally { google.refreshDelayMs = 0 }
  })
  it("autorisation retirée chez Google (invalid_grant) ⇒ échec AUTH_FAILED journalisé, curseur intact", async () => {
    const before = (await svc.readConnectorSetting(db, A, "google_calendar"))!.watermark
    google.validRefresh.delete(RT2)
    try {
      assert.deepEqual(await runLiveConnectorSync(db, A, "google_calendar", liveDeps()), { ok: false, error: SYNC_ERROR_LABEL.AUTH_FAILED })
    } finally { google.validRefresh.add(RT2) }
    const last = await db.connectorSyncRun.findFirstOrThrow({ where: { companyId: A.companyId, connectorKey: "google_calendar" }, orderBy: { startedAt: "desc" } })
    assert.deepEqual([last.status, last.errorCode, last.mode], ["FAILED", "AUTH_FAILED", "LIVE"])
    assert.equal((await svc.readConnectorSetting(db, A, "google_calendar"))!.watermark, before)
  })
  it("client OAuth retiré du serveur ⇒ échec sans appel à Google", async () => {
    google.tokenCalls = []
    const r = await runLiveConnectorSync(db, A, "google_calendar", { ...liveDeps(), env: {} })
    assert.equal(r.ok, false)
    assert.equal(google.tokenCalls.length, 0)
  })
})

describe("révocation", () => {
  it("autorisation retirée chez Google (au mieux) PUIS révoquée dans le coffre ; mode réel arrêté", async () => {
    google.tokenCalls = []
    ok(await revokeLiveConnector(db, A, "google_calendar", { tokenPost: post, secrets, now }))
    assert.deepEqual(google.tokenCalls.map((c) => [c.path, c.form.token]), [["/revoke", RT2]])
    const c = (await connection())!
    assert.deepEqual([c.status, c.credentialStatus], ["DISABLED", "REVOKED"])
    assert.equal((await svc.readConnectorSetting(db, A, "google_calendar"))!.mode, "DISABLED")
  })
  it("reconnexion possible avec un nouveau flux complet", async () => {
    google.exchange = { status: 200, body: { access_token: AT, refresh_token: RT1, scope: GOOGLE_CALENDAR_SCOPE } }
    const { state, cookie } = await start()
    assert.equal((await callback({ code: "c2", state }, cookie)).ok, GOOGLE_OAUTH_MESSAGES.connected)
    const c = (await connection())!
    assert.deepEqual([c.status, c.credentialStatus], ["ACTIVE", "ACTIVE"])
  })
})
