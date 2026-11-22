/**
 * PLAN-INTEGRATION-PLATFORM-001 — LOT-8C : Google Agenda (OAuth, lecture seule) — règles pures, échanges de jetons,
 * source d'événements et routes. AUCUN réseau : `fetch` et le serveur de jetons sont des doubles. Les jetons de test sont
 * construits à l'exécution, sans entropie (aucune valeur au format d'un vrai jeton dans le dépôt).
 */
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { readFileSync, readdirSync } from "node:fs"
import { describe, it } from "node:test"
import { ConnectorSourceError, LIVE_CONNECTOR_KEYS, OAUTH_LIVE_KEYS, PAGE_SIZE, checkItem, isValidCursor, type SyncErrorCode } from "@/lib/connectors/connectors.core"
import { parseLiveCredentials, readLiveConfig, liveHost } from "@/lib/integration/connectors/live/live-catalog"
import { liveGetJson, type FetchLike } from "@/lib/integration/connectors/live/live-http"
import { GOOGLE_CALENDAR_LOOKBACK_DAYS, createLiveSource } from "@/lib/integration/connectors/live/live-sources"
import {
  GOOGLE_CALENDAR_SCOPE, OAUTH_COOKIE, exchangeCode, hasCalendarScope, nativeTokenPost, pkceChallenge, readGoogleCalendarOAuthConfig,
  refreshAccessToken, sha256Hex, startGoogleCalendarOAuth, type TokenPost,
} from "@/lib/integration/connectors/oauth/google-calendar-oauth"
import { handleGoogleCalendarCallback, handleGoogleCalendarConnect, type GoogleRouteDeps } from "@/lib/integration/connectors/oauth/google-calendar-routes"

const CLIENT_ID = "1234567890-abcdef.apps.googleusercontent.com"
const ENV = { GOOGLE_CALENDAR_CLIENT_ID: CLIENT_ID, GOOGLE_CALENDAR_CLIENT_SECRET: "secret-de-test-" + "x".repeat(8), NEXTAUTH_URL: "https://planificator.test", CONNECTOR_LIVE_ENABLED: "true" }
const CFG = readGoogleCalendarOAuthConfig(ENV)!
const RT = "rt-" + "a".repeat(24)
const AT = "at-" + "b".repeat(24)
const codeOf = async (p: Promise<unknown>): Promise<SyncErrorCode | "NO_ERROR" | "OTHER"> => {
  try { await p; return "NO_ERROR" } catch (e) { return e instanceof ConnectorSourceError ? e.code : "OTHER" }
}
const post = (status: number, body: Record<string, unknown>, calls: { path: string; form: Record<string, string> }[] = []): TokenPost =>
  async (_h, path, form) => { calls.push({ path, form }); return { status, body } }

describe("catalogue et configuration", () => {
  it("Google Agenda rejoint les connexions réelles, par OAuth et sans saisie ; hôte fixe ; agenda principal seulement", () => {
    assert.deepEqual([...LIVE_CONNECTOR_KEYS], ["shopify", "mailchimp", "slack", "google_calendar"])
    assert.deepEqual([...OAUTH_LIVE_KEYS], ["google_calendar"])
    assert.equal(parseLiveCredentials("google_calendar", { anything: "x" }).ok, false)
    assert.deepEqual(readLiveConfig("google_calendar", { calendarId: "primary" }), { calendarId: "primary" })
    assert.equal(readLiveConfig("google_calendar", { calendarId: "autre@group.calendar.google.com" }), null, "aucun agenda arbitraire")
    assert.equal(liveHost("google_calendar", { calendarId: "primary" }), "www.googleapis.com")
  })
  it("client OAuth DÉDIÉ exigé : absent, mal formé, égal au client Gmail/Drive, adresse non HTTPS ⇒ indisponible", () => {
    assert.deepEqual(CFG, { clientId: CLIENT_ID, clientSecret: ENV.GOOGLE_CALENDAR_CLIENT_SECRET, redirectUri: "https://planificator.test/api/connecteurs/google-agenda/callback" })
    assert.equal(readGoogleCalendarOAuthConfig({}), null)
    assert.equal(readGoogleCalendarOAuthConfig({ ...ENV, GOOGLE_CALENDAR_CLIENT_ID: "pas-un-client" }), null)
    assert.equal(readGoogleCalendarOAuthConfig({ ...ENV, GOOGLE_CLIENT_ID: CLIENT_ID }), null, "§16.3 : distinct du client Gmail/Drive")
    assert.equal(readGoogleCalendarOAuthConfig({ ...ENV, NEXTAUTH_URL: "http://planificator.test" }), null)
    assert.equal(readGoogleCalendarOAuthConfig({ ...ENV, NEXTAUTH_URL: "https://planificator.test/sous-chemin" }), null)
    assert.equal(readGoogleCalendarOAuthConfig({ ...ENV, NEXTAUTH_URL: "http://localhost:3000" })?.redirectUri, "http://localhost:3000/api/connecteurs/google-agenda/callback")
    assert.equal(readGoogleCalendarOAuthConfig({ ...ENV, NEXTAUTH_URL: "http://localhost:3000", VERCEL_ENV: "production" }), null)
  })
})

describe("initiation : état, PKCE, portée minimale", () => {
  it("adresse Google : portée calendar.readonly seule, offline + consent, PKCE S256 ; en base, empreintes seulement", async () => {
    let row: Record<string, unknown> = {}
    const db = { integrationOAuthState: { create: async (a: { data: Record<string, unknown> }) => { row = a.data } } } as never
    let n = 0
    const rng = { bytes: (k: number) => Buffer.alloc(k, ++n) }
    const now = new Date("2026-11-23T10:00:00Z")
    const { authUrl, browserNonce } = await startGoogleCalendarOAuth(db, { companyId: "co", userId: "u" }, CFG, { now, rng })
    const u = new URL(authUrl)
    assert.equal(u.host, "accounts.google.com")
    const p = Object.fromEntries(u.searchParams)
    assert.equal(p.scope, GOOGLE_CALENDAR_SCOPE)
    assert.deepEqual([p.access_type, p.prompt, p.response_type, p.code_challenge_method, p.include_granted_scopes, p.client_id, p.redirect_uri], ["offline", "consent", "code", "S256", "false", CLIENT_ID, CFG.redirectUri])
    assert.equal(p.code_challenge, pkceChallenge(row.codeVerifier as string), "défi = SHA-256 du vérificateur")
    assert.equal(row.stateHash, sha256Hex(p.state), "seule l'empreinte du state est stockée")
    assert.equal(row.browserHash, sha256Hex(browserNonce))
    assert.ok(!JSON.stringify(row).includes(p.state) && !JSON.stringify(row).includes(browserNonce))
    assert.equal((row.expiresAt as Date).getTime() - now.getTime(), 600_000, "10 minutes")
    assert.match(p.state, /^[A-Za-z0-9_-]{43}$/)
    assert.match(row.codeVerifier as string, /^[A-Za-z0-9_-]{64}$/)
    assert.equal(pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"), "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM", "vecteur RFC 7636")
  })
})

describe("serveur de jetons", () => {
  it("échange du code : vérificateur PKCE et adresse de retour envoyés ; refus Google ⇒ codes stables", async () => {
    const calls: { path: string; form: Record<string, string> }[] = []
    const r = await exchangeCode(post(200, { access_token: AT, refresh_token: RT, scope: GOOGLE_CALENDAR_SCOPE }, calls), CFG, "code-1", "v".repeat(64))
    assert.deepEqual(r, { accessToken: AT, refreshToken: RT, scope: GOOGLE_CALENDAR_SCOPE })
    assert.deepEqual(calls[0], { path: "/token", form: { grant_type: "authorization_code", code: "code-1", code_verifier: "v".repeat(64), client_id: CLIENT_ID, client_secret: CFG.clientSecret, redirect_uri: CFG.redirectUri } })
    for (const [status, code] of [[400, "AUTH_FAILED"], [401, "AUTH_FAILED"], [429, "RATE_LIMITED"], [500, "SOURCE_UNAVAILABLE"]] as const)
      assert.equal(await codeOf(exchangeCode(post(status, { error: "invalid_grant" }), CFG, "c", "v".repeat(64))), code)
    assert.equal((await exchangeCode(post(200, { access_token: AT, scope: GOOGLE_CALENDAR_SCOPE }), CFG, "c", "v".repeat(64))).refreshToken, null)
    assert.equal(hasCalendarScope(`openid ${GOOGLE_CALENDAR_SCOPE}`), true)
    assert.equal(hasCalendarScope("https://www.googleapis.com/auth/calendar.events.readonly"), false)
  })
  it("rafraîchissement : jamais de remplacement par une valeur vide ; nouveau jeton retenu seulement s'il diffère ; portée revérifiée", async () => {
    assert.deepEqual(await refreshAccessToken(post(200, { access_token: AT }), CFG, RT), { accessToken: AT, newRefreshToken: null })
    assert.deepEqual(await refreshAccessToken(post(200, { access_token: AT, refresh_token: "" }), CFG, RT), { accessToken: AT, newRefreshToken: null })
    assert.deepEqual(await refreshAccessToken(post(200, { access_token: AT, refresh_token: RT }), CFG, RT), { accessToken: AT, newRefreshToken: null })
    const fresh = "rt-" + "c".repeat(24)
    assert.deepEqual(await refreshAccessToken(post(200, { access_token: AT, refresh_token: fresh }), CFG, RT), { accessToken: AT, newRefreshToken: fresh })
    assert.equal(await codeOf(refreshAccessToken(post(200, { access_token: AT, scope: "openid" }), CFG, RT)), "AUTH_FAILED")
    assert.equal(await codeOf(refreshAccessToken(post(400, { error: "invalid_grant" }), CFG, RT)), "AUTH_FAILED")
  })
  it("POST natif : hôte et chemins fixes, sans redirection ni cache ; réponse trop grande refusée", async () => {
    assert.equal(await codeOf(nativeTokenPost("evil.com", "/token", {})), "SOURCE_UNAVAILABLE")
    assert.equal(await codeOf(nativeTokenPost("oauth2.googleapis.com", "/tokeninfo", {})), "SOURCE_UNAVAILABLE")
    const original = globalThis.fetch
    let seen: { url: string; init: RequestInit } | null = null
    globalThis.fetch = (async (url: string, init: RequestInit) => { seen = { url, init }; return new Response(JSON.stringify({ access_token: AT })) }) as typeof fetch
    try {
      const r = await nativeTokenPost("oauth2.googleapis.com", "/token", { a: "b" })
      assert.equal(r.status, 200)
      assert.equal(seen!.url, "https://oauth2.googleapis.com/token")
      assert.deepEqual([seen!.init.method, seen!.init.redirect, seen!.init.cache, seen!.init.credentials], ["POST", "manual", "no-store", "omit"])
      globalThis.fetch = (async () => new Response("x".repeat(70_000))) as typeof fetch
      assert.equal(await codeOf(nativeTokenPost("oauth2.googleapis.com", "/token", {})), "SOURCE_UNAVAILABLE")
    } finally { globalThis.fetch = original }
  })
})

describe("source Google Agenda (fetch simulé)", () => {
  type Call = { url: URL; headers: Record<string, string> }
  function calendar(handler: (u: URL) => { status?: number; body?: unknown }) {
    const calls: Call[] = []
    const fetch: FetchLike = async (input, init) => {
      const u = new URL(input); calls.push({ url: u, headers: init.headers })
      const r = handler(u)
      return { status: r.status ?? 200, text: async () => JSON.stringify(r.body ?? {}) }
    }
    return { fetch, calls }
  }
  const ev = (i: number, extra: Record<string, unknown> = {}) => ({ id: `ev${i}`, status: "confirmed", summary: `Chantier ${i}`, location: "Lyon", start: { dateTime: "2026-12-01T08:00:00+01:00" }, end: { dateTime: "2026-12-01T10:00:00+01:00" }, attendees: [{ email: "x@exemple.invalid" }], description: "jamais lue", ...extra })
  const now = () => new Date("2026-11-23T10:00:00Z")

  it("première lecture : fenêtre de 30 jours, événements uniques, supprimés inclus, champs listés (aucun participant ni description)", async () => {
    const c = calendar(() => ({ body: { items: [ev(1)], nextSyncToken: "SYNC-1=" } }))
    const src = createLiveSource("google_calendar", AT, { calendarId: "primary" }, c.fetch, { now })
    const p = await src.fetchPage("events", null)
    const u = c.calls[0].url
    assert.equal(u.host, "www.googleapis.com")
    assert.equal(u.pathname, "/calendar/v3/calendars/primary/events")
    assert.equal(u.searchParams.get("timeMin"), new Date(now().getTime() - GOOGLE_CALENDAR_LOOKBACK_DAYS * 86_400_000).toISOString())
    assert.deepEqual([u.searchParams.get("singleEvents"), u.searchParams.get("showDeleted"), u.searchParams.get("maxResults")], ["true", "true", String(PAGE_SIZE)])
    assert.equal(u.searchParams.get("fields"), "items(id,status,summary,location,start,end),nextPageToken,nextSyncToken")
    assert.equal(c.calls[0].headers.authorization, `Bearer ${AT}`)
    assert.deepEqual(p.items[0], { externalId: "ev1", data: { title: "Chantier 1", startsAt: "2026-12-01T08:00:00+01:00", endsAt: "2026-12-01T10:00:00+01:00", allDay: false, location: "Lyon", cancelled: false } })
    assert.doesNotMatch(JSON.stringify(p.items), /exemple\.invalid|jamais lue/)
    for (const it of p.items) checkItem(it)
    assert.equal(p.hasMore, false)
    assert.ok(p.cursor && p.cursor.startsWith("gc:") && isValidCursor(p.cursor))
  })
  it("pages : la suite reprend la même fenêtre ; puis lecture incrémentale par jeton de synchronisation, sans fenêtre", async () => {
    const c = calendar((u) => {
      if (u.searchParams.get("syncToken") === "SYNC-1=") return { body: { items: [ev(3, { status: "cancelled", summary: "secret annulé" })], nextSyncToken: "SYNC-2=" } }
      if (u.searchParams.get("pageToken") === "PAGE-2") return { body: { items: [ev(2)], nextSyncToken: "SYNC-1=" } }
      return { body: { items: [ev(1)], nextPageToken: "PAGE-2" } }
    })
    const src = createLiveSource("google_calendar", AT, { calendarId: "primary" }, c.fetch, { now })
    const p1 = await src.fetchPage("events", null)
    assert.equal(p1.hasMore, true)
    const p2 = await src.fetchPage("events", p1.cursor)
    assert.equal(c.calls[1].url.searchParams.get("pageToken"), "PAGE-2")
    assert.equal(c.calls[1].url.searchParams.get("timeMin"), c.calls[0].url.searchParams.get("timeMin"), "même fenêtre que la première page")
    const p3 = await src.fetchPage("events", p2.cursor)
    assert.equal(c.calls[2].url.searchParams.get("syncToken"), "SYNC-1=")
    assert.equal(c.calls[2].url.searchParams.get("timeMin"), null, "aucune fenêtre avec un jeton de synchronisation")
    assert.deepEqual(p3.items[0].data, { title: null, startsAt: "2026-12-01T08:00:00+01:00", endsAt: "2026-12-01T10:00:00+01:00", allDay: false, location: null, cancelled: true }, "événement supprimé : rien de son contenu")
  })
  it("jeton périmé (410) ⇒ relecture complète ; journée entière ; curseur étranger refusé", async () => {
    const c = calendar((u) => (u.searchParams.get("syncToken") ? { status: 410 } : { body: { items: [ev(4, { start: { date: "2026-12-24" }, end: { date: "2026-12-25" } })], nextSyncToken: "SYNC-9=" } }))
    const src = createLiveSource("google_calendar", AT, { calendarId: "primary" }, c.fetch, { now })
    const first = await src.fetchPage("events", null)
    const again = await src.fetchPage("events", first.cursor)
    assert.ok(c.calls[2].url.searchParams.get("timeMin"), "relecture complète après le 410")
    assert.deepEqual(again.items[0].data, { title: "Chantier 4", startsAt: "2026-12-24", endsAt: "2026-12-25", allDay: true, location: "Lyon", cancelled: false })
    assert.equal(await codeOf(src.fetchPage("events", "sid:12")), "WATERMARK_INVALID")
    assert.equal(await codeOf(src.fetchPage("events", "gc:pasdujson")), "WATERMARK_INVALID")
    assert.equal(await codeOf(src.fetchPage("orders", null)), "SOURCE_ITEM_INVALID")
  })
  it("client HTTP : 410 ⇒ WATERMARK_INVALID (curseur à reprendre), jamais une panne", async () => {
    const f: FetchLike = async () => ({ status: 410, text: async () => "{}" })
    assert.equal(await codeOf(liveGetJson(f, { host: "www.googleapis.com", path: "/x", headers: {} })), "WATERMARK_INVALID")
  })
})

describe("routes OAuth (triple contrôle)", () => {
  const req = (path: string, cookie?: string) => new Request(`https://planificator.test${path}`, { headers: cookie ? { cookie } : {} })
  const deps = (o: Partial<GoogleRouteDeps> = {}): GoogleRouteDeps => ({
    access: async () => ({ ok: true, context: { companyId: "co", userId: "u", role: "ADMIN" } }),
    db: { integrationOAuthState: { create: async () => undefined, count: async () => 0 } } as never, env: ENV, ...o,
  })
  it("module absent ⇒ 404 ; non connecté ⇒ /login ; rôle refusé, drapeau éteint, client absent ⇒ retour avec message", async () => {
    assert.equal((await handleGoogleCalendarConnect(req("/api/connecteurs/google-agenda/connect"), deps({ access: async () => ({ ok: false, reason: "MODULE_DISABLED" }) }))).status, 404)
    const login = await handleGoogleCalendarConnect(req("/x"), deps({ access: async () => ({ ok: false, reason: "UNAUTHENTICATED" }) }))
    assert.equal(new URL(login.headers.get("location")!).pathname, "/login")
    for (const d of [deps({ access: async () => ({ ok: false, reason: "FORBIDDEN" }) }), deps({ env: { ...ENV, CONNECTOR_LIVE_ENABLED: "false" } }), deps({ env: { ...ENV, GOOGLE_CALENDAR_CLIENT_ID: "" } })]) {
      const r = await handleGoogleCalendarConnect(req("/x"), d)
      const loc = new URL(r.headers.get("location")!)
      assert.equal(loc.pathname, "/connecteurs"); assert.ok(loc.searchParams.get("erreur"))
    }
    const cb = await handleGoogleCalendarCallback(req("/x?code=c&state=s"), deps({ env: { ...ENV, CONNECTOR_LIVE_ENABLED: "" } }))
    assert.ok(new URL(cb.headers.get("location")!).searchParams.get("erreur"))
  })
  it("démarrage : redirection vers Google, cookie HttpOnly Secure SameSite=Lax limité au chemin du flux, sans cache", async () => {
    const r = await handleGoogleCalendarConnect(req("/api/connecteurs/google-agenda/connect"), deps())
    assert.equal(r.status, 302)
    assert.equal(new URL(r.headers.get("location")!).host, "accounts.google.com")
    const c = r.headers.get("set-cookie")!
    assert.match(c, new RegExp(`^${OAUTH_COOKIE}=[A-Za-z0-9_-]{43}; Path=/api/connecteurs/google-agenda; HttpOnly; SameSite=Lax; Max-Age=600; Secure$`))
    assert.equal(r.headers.get("cache-control"), "private, no-store")
  })
})

describe("contrôles statiques", () => {
  const oauthDir = "src/lib/integration/connectors/oauth"
  const files = readdirSync(oauthDir).map((f) => `${oauthDir}/${f}`)
  it("seul l'hôte de jetons Google reçoit un POST ; aucun journal ; aucune portée d'écriture", () => {
    for (const f of files) {
      const c = readFileSync(f, "utf8")
      assert.doesNotMatch(c, /console\.(?:log|info|warn|error)/, f)
      assert.doesNotMatch(c, /googleapis\.com\/auth\/(?!calendar\.readonly")[a-z.]+/, f)
      for (const m of c.matchAll(/https:\/\/([a-z0-9.-]+)/g)) assert.ok(["www.googleapis.com", "accounts.google.com", "oauth2.googleapis.com"].includes(m[1]) || m[1] === "${host}", `${f} : ${m[1]}`)
    }
    const o = readFileSync(`${oauthDir}/google-calendar-oauth.ts`, "utf8")
    assert.match(o, /if \(host !== TOKEN_HOST \|\| \(path !== "\/token" && path !== "\/revoke"\)\)/)
    assert.match(o, /runtimeCallerId: "connector-runtime"/)
    assert.match(o, /runtimeCallerId: "revocation-service"/)
    assert.match(o, /pg_advisory_xact_lock/)
  })
  it("migration : états OAuth par empreintes, usage unique, 15 min au plus en base ; LIVE élargi à google_calendar", () => {
    const sql = readFileSync("prisma/migrations/20261123090000_v2_google_calendar_live/migration.sql", "utf8")
    assert.match(sql, /"stateHash" ~ '\^\[0-9a-f\]\{64\}\$'/)
    assert.match(sql, /"expiresAt" <= "createdAt" \+ interval '15 minutes'/)
    assert.match(sql, /\("consumedAt" IS NULL\) = \("codeVerifier" IS NOT NULL\)/)
    assert.match(sql, /oauth state already consumed/)
    assert.match(sql, /"connectorKey" IN \('shopify', 'mailchimp', 'slack', 'google_calendar'\)/)
    assert.doesNotMatch(sql, /DROP TABLE|DROP COLUMN|\bDELETE FROM\b|\bTRUNCATE\b/)
    assert.equal(createHash("sha256").update("x").digest("hex").length, 64)
  })
})
