/**
 * SPEC-WORKSITE-PHOTOS-001 Lot 2 — handlers OAuth Drive : drapeau, autorité administrateur relue (démarrage, callback,
 * persistance, déconnexion), state signé expirant corrélé au navigateur (cookie) et à la session, usage unique,
 * échange de code, scope, stockage chiffré, déconnexion locale (origine contrôlée, aucune révocation, journal).
 * Base factice : la sérialisation réelle des courses (verrous) est prouvée par drive-oauth.pg.test.ts.
 */
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { describe, it } from "node:test"
import {
  DRIVE_OAUTH_COOKIE, DRIVE_OAUTH_STATE_TTL_SECONDS, DRIVE_SCOPE_FILE, decodeDriveOAuthState, encodeDriveOAuthState,
  handleDriveConnectStart, handleDriveDisconnect, handleDriveOAuthCallback, resolveDriveAdmin,
  type DriveOAuthDb, type DriveOAuthSession,
} from "@/lib/worksite-photos/drive/drive-oauth"

const SECRET = "test-cron-secret-for-oauth-state"
const ENV = {
  PLANIFICATOR_WORKSITE_PHOTOS_ENABLED: "true", CRON_SECRET: SECRET, GOOGLE_CLIENT_ID: "cid", GOOGLE_CLIENT_SECRET: "csecret",
  DRIVE_OAUTH_REDIRECT_URI: "https://app.example.test/api/auth/drive/callback", NEXTAUTH_URL: "https://app.example.test",
}
const crypto = { encrypt: (s: string) => `enc(${s})`, decrypt: (s: string) => s.replace(/^enc\((.*)\)$/, "$1") }
const admin: DriveOAuthSession = { user: { id: "u1", role: "ADMIN", companyId: "c1" } }
const T0 = new Date("2026-10-30T12:00:00.000Z")
const NONCE = "n".repeat(43)
const sha = (v: string) => createHash("sha256").update(v).digest("hex")

type UserRow = { id: string; role: string; companyId: string | null; active: boolean }
type EmployeeRow = { id: string; role: string; active: boolean; userId: string; companyId: string }

function fakeDb(options: { user?: UserRow | null; company?: { id: string; active: boolean } | null; employee?: EmployeeRow | null } = {}) {
  const state = {
    row: null as Record<string, unknown> | null, upserts: [] as unknown[], updates: [] as unknown[], events: [] as Record<string, unknown>[],
    user: options.user === undefined ? { id: "u1", role: "ADMIN", companyId: "c1", active: true } as UserRow | null : options.user,
    company: options.company === undefined ? { id: "c1", active: true } as { id: string; active: boolean } | null : options.company,
    employee: options.employee ?? null as EmployeeRow | null,
    locks: 0, transactions: 0,
  }
  const db: DriveOAuthDb = {
    $queryRaw: (async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const sql = strings.join("?")
      if (sql.includes("FOR SHARE") || sql.includes("pg_advisory_xact_lock")) { state.locks++; return [] }
      if (sql.includes(`"worksite_photo_events"`)) {
        const nonceHash = values[values.length - 1]
        return state.events.filter((e) => e.action === "DRIVE_OAUTH_STATE_CONSUMED" && (e.detail as Record<string, unknown>).nonceHash === nonceHash).map(() => ({ found: 1 }))
      }
      return []
    }) as DriveOAuthDb["$queryRaw"],
    $transaction: async (fn) => { state.transactions++; return fn(db) },
    worksitePhotoDriveConnection: {
      findUnique: async () => state.row as never,
      update: async (args: { data: Record<string, unknown> }) => { state.updates.push(args.data); if (state.row) Object.assign(state.row, args.data); return null },
      updateMany: async (args: { data: Record<string, unknown> }) => { state.updates.push(args.data); return { count: 1 } },
      upsert: async (args: unknown) => { state.upserts.push(args); return null },
    },
    worksitePhotoEvent: { create: async (args: { data: Record<string, unknown> }) => { state.events.push(args.data); return null } },
    user: { findFirst: async (args: { where: { id: string } }) => (state.user && state.user.id === args.where.id ? state.user : null) },
    company: { findFirst: async (args: { where: { id: string } }) => (state.company && state.company.id === args.where.id ? state.company : null) },
    employee: { findFirst: async (args: { where: { userId: string; companyId: string } }) => (state.employee && state.employee.userId === args.where.userId && state.employee.companyId === args.where.companyId ? state.employee : null) },
  }
  return { db, state }
}

function fetchByUrl(handlers: Record<string, (init?: RequestInit) => Response>) {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  const fetchImpl = async (url: string, init?: RequestInit) => {
    calls.push({ url, init })
    const key = Object.keys(handlers).find((k) => url.includes(k))
    if (!key) throw new Error(`unexpected fetch ${url}`)
    return handlers[key](init)
  }
  return { calls, fetchImpl }
}
const jsonRes = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })
const okTokens = () => fetchByUrl({
  "oauth2.googleapis.com/token": () => jsonRes({ access_token: "A", refresh_token: "R", expires_in: 3600, scope: `${DRIVE_SCOPE_FILE} https://www.googleapis.com/auth/userinfo.email` }),
  "oauth2/v1/userinfo": () => jsonRes({ email: "Galya@Example.test" }),
})

/** State légitime émis par le démarrage réel, et le cookie que ce démarrage a posé. */
async function startFlow(session: DriveOAuthSession = admin, db = fakeDb().db, at = T0) {
  const res = await handleDriveConnectStart(new Request("https://app.example.test/api/auth/drive"), { auth: async () => session, db, env: ENV, clock: () => at, randomNonce: () => NONCE })
  const state = new URL(res.headers.get("location")!).searchParams.get("state")!
  return { res, state, cookie: `${DRIVE_OAUTH_COOKIE}=${NONCE}` }
}
const callback = (qs: string, cookie?: string) => new Request(`https://app.example.test/api/auth/drive/callback?${qs}`, { headers: cookie ? { cookie } : {} })
const settingsParams = (res: Response) => new URL(res.headers.get("location")!).searchParams

describe("state OAuth Drive", () => {
  it("signé, typé 'drive' v2, porte l'empreinte du nonce et une échéance ; altération, autre type ou ancien format refusés", () => {
    const payload = { companyId: "c1", userId: "u1", nonceHash: sha(NONCE), iat: T0.getTime(), exp: T0.getTime() + 600_000 }
    const state = encodeDriveOAuthState(payload, SECRET)
    assert.deepEqual(decodeDriveOAuthState(state, SECRET), payload)
    assert.equal(decodeDriveOAuthState(state, "autre-secret"), null)
    assert.equal(decodeDriveOAuthState(state.slice(0, -4) + "AAAA", SECRET), null)
    const gmailLike = Buffer.from(JSON.stringify({ payload: JSON.stringify({ companyId: "c1", userId: "u1", nonce: 1 }), sig: "00" })).toString("base64url")
    assert.equal(decodeDriveOAuthState(gmailLike, SECRET), null)
    assert.equal(decodeDriveOAuthState(encodeDriveOAuthState({ ...payload, nonceHash: "court" }, SECRET), SECRET), null)
    assert.equal(decodeDriveOAuthState(encodeDriveOAuthState({ ...payload, exp: payload.iat }, SECRET), SECRET), null)
  })
})

describe("autorité administrateur (L2-R2)", () => {
  const identity = { userId: "u1", companyId: "c1", sessionRole: "ADMIN" }
  it("compte inactif ⇒ 401 ; entreprise inactive ou absente ⇒ 403 ; fiche inactive ou rétrogradée ⇒ 403 ; rôle de session périmé ⇒ 403 ; autre entreprise ⇒ 403", async () => {
    assert.deepEqual(await resolveDriveAdmin(fakeDb({ user: { id: "u1", role: "ADMIN", companyId: "c1", active: false } }).db, identity), { ok: false, status: 401, code: "UNAUTHENTICATED" })
    assert.equal((await resolveDriveAdmin(fakeDb({ company: { id: "c1", active: false } }).db, identity)).ok, false)
    assert.equal((await resolveDriveAdmin(fakeDb({ company: null }).db, identity)).ok, false)
    assert.equal((await resolveDriveAdmin(fakeDb({ employee: { id: "e1", role: "ADMIN", active: false, userId: "u1", companyId: "c1" } }).db, identity)).ok, false)
    assert.equal((await resolveDriveAdmin(fakeDb({ employee: { id: "e1", role: "EMPLOYEE", active: true, userId: "u1", companyId: "c1" } }).db, identity)).ok, false)
    assert.equal((await resolveDriveAdmin(fakeDb({ user: { id: "u1", role: "EMPLOYEE", companyId: "c1", active: true } }).db, identity)).ok, false, "session ADMIN périmée")
    assert.equal((await resolveDriveAdmin(fakeDb({ user: { id: "u1", role: "ADMIN", companyId: "c2", active: true } }).db, identity)).ok, false, "administrateur d'une autre entreprise")
    assert.deepEqual(await resolveDriveAdmin(fakeDb().db, identity), { ok: true, userId: "u1", companyId: "c1", role: "ADMIN" })
    assert.equal((await resolveDriveAdmin(fakeDb({ user: { id: "u1", role: "SUPER_ADMIN", companyId: null, active: true } }).db, { ...identity, sessionRole: "SUPER_ADMIN" })).ok, true, "SUPER_ADMIN global, entreprise active explicite")
  })
  it("avec `lock`, les lignes compte / entreprise / fiche sont verrouillées avant lecture", async () => {
    const { db, state } = fakeDb()
    await resolveDriveAdmin(db, identity, { lock: true })
    assert.equal(state.locks, 3)
  })
})

describe("GET /api/auth/drive (démarrage)", () => {
  const request = () => new Request("https://app.example.test/api/auth/drive")
  it("404 drapeau absent ; 401 sans session ; 403 non administrateur, sans entreprise, ou session ADMIN périmée en base", async () => {
    const { db } = fakeDb()
    assert.equal((await handleDriveConnectStart(request(), { auth: async () => admin, db, env: { ...ENV, PLANIFICATOR_WORKSITE_PHOTOS_ENABLED: "" } })).status, 404)
    assert.equal((await handleDriveConnectStart(request(), { auth: async () => null, db, env: ENV })).status, 401)
    assert.equal((await handleDriveConnectStart(request(), { auth: async () => ({ user: { id: "u2", role: "EMPLOYEE", companyId: "c1" } }), db, env: ENV })).status, 403)
    assert.equal((await handleDriveConnectStart(request(), { auth: async () => ({ user: { id: "u3", role: "SUPER_ADMIN", companyId: null } }), db, env: ENV })).status, 403)
    assert.equal((await handleDriveConnectStart(request(), { auth: async () => admin, db: fakeDb({ user: { id: "u1", role: "EMPLOYEE", companyId: "c1", active: true } }).db, env: ENV })).status, 403)
    assert.equal((await handleDriveConnectStart(request(), { auth: async () => admin, db: fakeDb({ user: { id: "u1", role: "ADMIN", companyId: "c1", active: false } }).db, env: ENV })).status, 401)
    assert.equal((await handleDriveConnectStart(request(), { auth: async () => admin, db, env: { ...ENV, DRIVE_OAUTH_REDIRECT_URI: "" } })).status, 500)
  })
  it("redirige vers Google (drive.file, offline, consent) ; cookie HttpOnly lié au chemin, SameSite=Lax, Secure, 10 min ; state = empreinte du cookie, échéance bornée", async () => {
    const { res, state } = await startFlow()
    assert.equal(res.status, 302)
    const location = new URL(res.headers.get("location")!)
    assert.equal(location.origin + location.pathname, "https://accounts.google.com/o/oauth2/v2/auth")
    assert.equal(location.searchParams.get("access_type"), "offline")
    assert.equal(location.searchParams.get("prompt"), "consent")
    assert.ok(location.searchParams.get("scope")!.split(" ").includes(DRIVE_SCOPE_FILE))
    const cookie = res.headers.get("set-cookie")!
    assert.match(cookie, new RegExp(`^${DRIVE_OAUTH_COOKIE}=${NONCE}; Path=/api/auth/drive; HttpOnly; SameSite=Lax; Max-Age=${DRIVE_OAUTH_STATE_TTL_SECONDS}; Secure$`))
    const decoded = decodeDriveOAuthState(state, SECRET)!
    assert.deepEqual([decoded.companyId, decoded.userId, decoded.nonceHash, decoded.exp - decoded.iat], ["c1", "u1", sha(NONCE), DRIVE_OAUTH_STATE_TTL_SECONDS * 1000])
    assert.equal(location.searchParams.get("state")!.includes(NONCE), false, "le nonce lui-même ne quitte jamais le cookie")
  })
  it("nonce par défaut : 32 octets aléatoires, distincts d'un démarrage à l'autre", async () => {
    const a = await handleDriveConnectStart(request(), { auth: async () => admin, db: fakeDb().db, env: ENV })
    const b = await handleDriveConnectStart(request(), { auth: async () => admin, db: fakeDb().db, env: ENV })
    const nonce = (r: Response) => r.headers.get("set-cookie")!.split(";")[0].split("=")[1]
    assert.match(nonce(a), /^[A-Za-z0-9_-]{43}$/)
    assert.notEqual(nonce(a), nonce(b))
  })
})

describe("GET /api/auth/drive/callback", () => {
  it("refus Google, paramètres manquants, state invalide ⇒ redirections d'erreur sans appel réseau ; le cookie est toujours effacé", async () => {
    const { db } = fakeDb()
    const { calls, fetchImpl } = fetchByUrl({})
    const denied = await handleDriveOAuthCallback(callback("error=access_denied"), { auth: async () => null, db, env: ENV, fetchImpl })
    assert.equal(settingsParams(denied).get("reason"), "access_denied")
    assert.match(denied.headers.get("set-cookie")!, new RegExp(`^${DRIVE_OAUTH_COOKIE}=; .*Max-Age=0`))
    assert.equal(settingsParams(await handleDriveOAuthCallback(callback("code=x"), { auth: async () => null, db, env: ENV, fetchImpl })).get("reason"), "missing_params")
    assert.equal(settingsParams(await handleDriveOAuthCallback(callback("code=x&state=bad"), { auth: async () => null, db, env: ENV, fetchImpl })).get("reason"), "invalid_state")
    assert.equal(calls.length, 0)
  })
  it("parcours nominal : échange du code, scope et refresh_token exigés, stockage chiffré, consommation journalisée, événement sans adresse en clair", async () => {
    const { db, state: dbState } = fakeDb()
    const { state, cookie } = await startFlow(admin, db)
    const { calls, fetchImpl } = okTokens()
    const res = await handleDriveOAuthCallback(callback(`code=the-code&state=${state}`, cookie), { auth: async () => admin, db, env: ENV, fetchImpl, crypto, clock: () => new Date(T0.getTime() + 60_000) })
    assert.equal(settingsParams(res).get("drive"), "connected")
    assert.match(res.headers.get("set-cookie")!, /Max-Age=0/)
    assert.match(String(calls[0].init?.body), /code=the-code/)
    const upsert = dbState.upserts[0] as { where: { companyId: string }; create: Record<string, unknown> }
    assert.deepEqual([upsert.where.companyId, upsert.create.accessToken, upsert.create.refreshToken, upsert.create.accountEmail, upsert.create.connectedById], ["c1", "enc(A)", "enc(R)", "galya@example.test", "u1"])
    assert.deepEqual(dbState.events.map((e) => e.action), ["DRIVE_OAUTH_STATE_CONSUMED", "DRIVE_CONNECTED"])
    assert.equal(JSON.stringify(dbState.events).includes(NONCE), false, "seule l'empreinte du nonce est journalisée")
    assert.equal(JSON.stringify(dbState.events).includes("galya@example.test"), false)
    assert.equal(dbState.transactions, 2, "admission+consommation, puis persistance")
  })
  it("navigateur absent ou différent, state expiré ou venu du futur, session absente ou d'un autre auteur/entreprise ⇒ refus sans échange de code ni écriture", async () => {
    const cases: Array<[string, { cookie?: string; session?: DriveOAuthSession | null; at?: Date; issuedAt?: Date }]> = [
      ["browser_mismatch", { cookie: undefined }],
      ["browser_mismatch", { cookie: `${DRIVE_OAUTH_COOKIE}=autre-nonce` }],
      ["expired_state", { at: new Date(T0.getTime() + DRIVE_OAUTH_STATE_TTL_SECONDS * 1000 + 1) }],
      ["expired_state", { issuedAt: new Date(T0.getTime() + 5 * 60_000) }],
      ["session_mismatch", { session: null }],
      ["session_mismatch", { session: { user: { id: "u9", role: "ADMIN", companyId: "c1" } } }],
      ["session_mismatch", { session: { user: { id: "u1", role: "ADMIN", companyId: "c2" } } }],
    ]
    for (const [reason, c] of cases) {
      const { db, state: dbState } = fakeDb()
      const { state, cookie } = await startFlow(admin, db, c.issuedAt ?? T0)
      const { calls, fetchImpl } = okTokens()
      const res = await handleDriveOAuthCallback(callback(`code=c&state=${state}`, "cookie" in c ? c.cookie : cookie),
        { auth: async () => ("session" in c ? c.session! : admin), db, env: ENV, fetchImpl, crypto, clock: () => c.at ?? T0 })
      assert.equal(settingsParams(res).get("reason"), reason, JSON.stringify(c))
      assert.equal(calls.length, 0, `${reason} : aucun échange de code`)
      assert.equal(dbState.upserts.length + dbState.events.length, 0, `${reason} : aucune écriture`)
    }
  })
  it("rejeu du même state (code distinct) ⇒ invalid_state, aucun second échange ni second stockage", async () => {
    const { db, state: dbState } = fakeDb()
    const { state, cookie } = await startFlow(admin, db)
    const first = okTokens()
    assert.equal(settingsParams(await handleDriveOAuthCallback(callback(`code=c1&state=${state}`, cookie), { auth: async () => admin, db, env: ENV, fetchImpl: first.fetchImpl, crypto, clock: () => T0 })).get("drive"), "connected")
    const second = okTokens()
    const replay = await handleDriveOAuthCallback(callback(`code=c2&state=${state}`, cookie), { auth: async () => admin, db, env: ENV, fetchImpl: second.fetchImpl, crypto, clock: () => T0 })
    assert.equal(settingsParams(replay).get("reason"), "invalid_state")
    assert.equal(second.calls.length, 0)
    assert.equal(dbState.upserts.length, 1)
  })
  it("autorité révoquée avant le retour (compte, entreprise, fiche, rétrogradation) ⇒ forbidden, aucun échange de code, rien stocké ni consommé", async () => {
    const revocations: Array<Parameters<typeof fakeDb>[0]> = [
      { user: { id: "u1", role: "ADMIN", companyId: "c1", active: false } },
      { company: { id: "c1", active: false } },
      { employee: { id: "e1", role: "ADMIN", active: false, userId: "u1", companyId: "c1" } },
      { user: { id: "u1", role: "EMPLOYEE", companyId: "c1", active: true } },
    ]
    for (const revoked of revocations) {
      const { state, cookie } = await startFlow(admin, fakeDb().db)
      const { db, state: dbState } = fakeDb(revoked)
      const { calls, fetchImpl } = okTokens()
      const res = await handleDriveOAuthCallback(callback(`code=c&state=${state}`, cookie), { auth: async () => admin, db, env: ENV, fetchImpl, crypto, clock: () => T0 })
      assert.equal(settingsParams(res).get("reason"), "forbidden", JSON.stringify(revoked))
      assert.equal(calls.length, 0)
      assert.equal(dbState.upserts.length + dbState.events.length, 0)
    }
  })
  it("autorité révoquée PENDANT l'échange réseau ⇒ forbidden à la persistance, rien stocké", async () => {
    const { db, state: dbState } = fakeDb()
    const { state, cookie } = await startFlow(admin, db)
    const { fetchImpl } = fetchByUrl({
      "oauth2.googleapis.com/token": () => { dbState.user!.active = false; return jsonRes({ access_token: "A", refresh_token: "R", scope: DRIVE_SCOPE_FILE }) },
      "oauth2/v1/userinfo": () => jsonRes({}),
    })
    const res = await handleDriveOAuthCallback(callback(`code=c&state=${state}`, cookie), { auth: async () => admin, db, env: ENV, fetchImpl, crypto, clock: () => T0 })
    assert.equal(settingsParams(res).get("reason"), "forbidden")
    assert.equal(dbState.upserts.length, 0)
    assert.deepEqual(dbState.events.map((e) => e.action), ["DRIVE_OAUTH_STATE_CONSUMED"], "le state reste consommé")
  })
  it("scope manquant ou absence de refresh_token ⇒ rien n'est stocké", async () => {
    for (const tokens of [{ access_token: "A", refresh_token: "R", expires_in: 3600, scope: "https://www.googleapis.com/auth/userinfo.email" }, { access_token: "A", expires_in: 3600, scope: DRIVE_SCOPE_FILE }]) {
      const { db, state: dbState } = fakeDb()
      const { state, cookie } = await startFlow(admin, db)
      const { fetchImpl } = fetchByUrl({ "oauth2.googleapis.com/token": () => jsonRes(tokens) })
      const reason = settingsParams(await handleDriveOAuthCallback(callback(`code=c&state=${state}`, cookie), { auth: async () => admin, db, env: ENV, fetchImpl, crypto, clock: () => T0 })).get("reason")
      assert.ok(reason === "scope_missing" || reason === "no_tokens", reason ?? "")
      assert.equal(dbState.upserts.length, 0)
    }
  })
})

describe("POST /api/worksite-photos/drive/disconnect", () => {
  const post = (headers: Record<string, string>) => new Request("https://app.example.test/api/worksite-photos/drive/disconnect", { method: "POST", headers })
  const sameOrigin = { host: "app.example.test", origin: "https://app.example.test" }
  const activeRow = () => ({ id: "conn", companyId: "c1", status: "ACTIVE", accessToken: "enc(a)", refreshToken: "enc(r)", tokenExpiry: new Date(), accountEmail: "x@y.z", rootFolderId: null, lastErrorCode: null, lastErrorAt: null, connectedById: "u1", connectedAt: new Date(), disconnectedAt: null })
  it("404 drapeau absent ; 401 ; 403 rôle ; 403 origine étrangère", async () => {
    const { db } = fakeDb()
    assert.equal((await handleDriveDisconnect(post(sameOrigin), { auth: async () => admin, db, env: { ...ENV, PLANIFICATOR_WORKSITE_PHOTOS_ENABLED: "" } })).status, 404)
    assert.equal((await handleDriveDisconnect(post(sameOrigin), { auth: async () => null, db, env: ENV })).status, 401)
    assert.equal((await handleDriveDisconnect(post(sameOrigin), { auth: async () => ({ user: { id: "u", role: "TEAM_LEADER", companyId: "c1" } }), db, env: ENV })).status, 403)
    const foreign = await handleDriveDisconnect(post({ host: "app.example.test", origin: "https://evil.example.test" }), { auth: async () => admin, db, env: ENV })
    assert.equal(foreign.status, 403)
    assert.equal(((await foreign.json()) as { code: string }).code, "INVALID_ORIGIN")
  })
  it("session ADMIN périmée (compte rétrogradé et inactif), entreprise inactive, fiche inactive ⇒ refus, AUCUNE écriture (sonde Codex L2-R2)", async () => {
    for (const revoked of [
      { user: { id: "u1", role: "EMPLOYEE", companyId: "c1", active: false } },
      { user: { id: "u1", role: "EMPLOYEE", companyId: "c1", active: true } },
      { company: { id: "c1", active: false } },
      { employee: { id: "e1", role: "ADMIN", active: false, userId: "u1", companyId: "c1" } },
    ] as Array<Parameters<typeof fakeDb>[0]>) {
      const { db, state: dbState } = fakeDb(revoked)
      dbState.row = activeRow()
      const res = await handleDriveDisconnect(post(sameOrigin), { auth: async () => admin, db, env: ENV })
      assert.ok(res.status === 401 || res.status === 403, `${JSON.stringify(revoked)} ⇒ ${res.status}`)
      assert.equal(dbState.updates.length + dbState.events.length, 0)
      assert.equal(dbState.row!.status, "ACTIVE")
    }
  })
  it("déconnexion locale : autorité relue sous verrous, tokens effacés, événement DRIVE_DISCONNECTED, aucun appel réseau, rejeu idempotent", async () => {
    const { db, state: dbState } = fakeDb()
    dbState.row = activeRow()
    const { calls, fetchImpl } = fetchByUrl({})
    const res = await handleDriveDisconnect(post(sameOrigin), { auth: async () => admin, db, env: ENV, fetchImpl, crypto })
    assert.equal(res.status, 200)
    assert.deepEqual(await res.json(), { status: "DISCONNECTED", changed: true })
    assert.equal(calls.length, 0, "aucune révocation Google")
    assert.equal(dbState.locks, 3)
    assert.equal((dbState.updates[0] as Record<string, unknown>).status, "DISCONNECTED")
    assert.deepEqual(dbState.events.map((e) => [e.action, e.detail]), [["DRIVE_DISCONNECTED", { local: true, revokedAtGoogle: false }]])
    const again = await handleDriveDisconnect(post(sameOrigin), { auth: async () => admin, db, env: ENV, fetchImpl, crypto })
    assert.deepEqual(await again.json(), { status: "DISCONNECTED", changed: false })
    assert.equal(dbState.events.length, 1)
  })
})
