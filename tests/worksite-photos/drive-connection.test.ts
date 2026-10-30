/**
 * SPEC-WORKSITE-PHOTOS-001 Lot 2 — connexion Drive : tokens chiffrés, refresh unique, invalid_grant ⇒ ERROR,
 * classement des autres refus OAuth (L2-R4), publication par CAS sur la génération de connexion (L2-R3),
 * retry sur 401, déconnexion locale sans réseau ni écriture Gmail.
 */
import assert from "node:assert/strict"
import { describe, it } from "node:test"
import {
  classifyTokenRefusal, disconnectDriveLocally, getValidDriveAccessToken, isDriveConnectionUsable, storeDriveConnection, withDriveAccess,
  type DriveConnectionDb, type DriveConnectionRecord,
} from "@/lib/worksite-photos/drive/drive-connection.client"
import { DriveProviderError } from "@/lib/worksite-photos/drive/drive.errors"
import { testEnv } from "./test-env"

const NOW = new Date("2026-10-30T12:00:00.000Z")
const crypto = { encrypt: (s: string) => `enc(${s})`, decrypt: (s: string) => { const m = s.match(/^enc\((.*)\)$/); if (!m) throw new Error("undecryptable"); return m[1] } }
const env = testEnv({ GOOGLE_CLIENT_ID: "cid", GOOGLE_CLIENT_SECRET: "csecret" })

function record(over: Partial<DriveConnectionRecord> = {}): DriveConnectionRecord {
  return {
    id: "conn-1", companyId: "c1", accountEmail: "galya@example.test", accessToken: "enc(access-1)", refreshToken: "enc(refresh-1)",
    tokenExpiry: new Date(NOW.getTime() + 3_600_000), rootFolderId: null, status: "ACTIVE", lastErrorCode: null, lastErrorAt: null,
    connectedById: "u1", connectedAt: NOW, disconnectedAt: null, ...over,
  }
}

function fakeDb(initial: DriveConnectionRecord | null) {
  const state = { row: initial, updates: [] as Record<string, unknown>[], upserts: [] as Record<string, unknown>[] }
  const db: DriveConnectionDb = {
    worksitePhotoDriveConnection: {
      findUnique: async () => state.row,
      update: async (args: { data: Record<string, unknown> }) => { state.updates.push(args.data); if (state.row) state.row = { ...state.row, ...(args.data as Partial<DriveConnectionRecord>) }; return state.row },
      // CAS fidèle à `updateMany` : la ligne n'est modifiée que si chaque champ de la condition correspond.
      updateMany: async (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        const row = state.row as Record<string, unknown> | null
        if (!row || Object.entries(args.where).some(([k, v]) => row[k] !== v)) return { count: 0 }
        state.updates.push(args.data); state.row = { ...state.row!, ...(args.data as Partial<DriveConnectionRecord>) }
        return { count: 1 }
      },
      upsert: async (args: { create: Record<string, unknown>; update: Record<string, unknown> }) => { state.upserts.push(args); return null },
    },
  }
  return { db, state }
}

function fetchResponding(status: number, body: unknown, calls: Array<{ url: string; body: string }> = []) {
  return {
    calls,
    fetchImpl: async (url: string, init?: RequestInit) => { calls.push({ url, body: String(init?.body ?? "") }); return new Response(JSON.stringify(body), { status }) },
  }
}

describe("connexion Drive — jeton d'accès", () => {
  it("jeton valide non expiré : déchiffré, aucun appel réseau", async () => {
    const { db } = fakeDb(record())
    const { calls, fetchImpl } = fetchResponding(200, {})
    assert.equal(await getValidDriveAccessToken("c1", { db, fetchImpl, env, clock: () => NOW, crypto }), "access-1")
    assert.equal(calls.length, 0)
  })
  it("expiration proche : refresh, stockage chiffré du nouveau jeton, refresh_token jamais journalisé dans l'URL", async () => {
    const { db, state } = fakeDb(record({ tokenExpiry: new Date(NOW.getTime() + 60_000) }))
    const { calls, fetchImpl } = fetchResponding(200, { access_token: "access-2", expires_in: 3600 })
    assert.equal(await getValidDriveAccessToken("c1", { db, fetchImpl, env, clock: () => NOW, crypto }), "access-2")
    assert.equal(calls.length, 1)
    assert.match(calls[0].url, /oauth2\.googleapis\.com\/token$/)
    assert.match(calls[0].body, /grant_type=refresh_token/)
    assert.match(calls[0].body, /refresh_token=refresh-1/)
    assert.equal(state.updates[0].accessToken, "enc(access-2)")
    assert.equal((state.updates[0].tokenExpiry as Date).getTime(), NOW.getTime() + 3_600_000)
  })
  it("invalid_grant : connexion passée en ERROR avec le code, erreur DRIVE_NOT_CONNECTED non réessayable", async () => {
    const { db, state } = fakeDb(record({ tokenExpiry: NOW }))
    const { fetchImpl } = fetchResponding(400, { error: "invalid_grant", error_description: "Token has been expired or revoked." })
    const error = await getValidDriveAccessToken("c1", { db, fetchImpl, env, clock: () => NOW, crypto }).catch((e: unknown) => e)
    assert.ok(error instanceof DriveProviderError)
    assert.deepEqual([error.code, error.retryable], ["DRIVE_NOT_CONNECTED", false])
    assert.equal(state.updates[0].status, "ERROR")
    assert.equal(state.updates[0].lastErrorCode, "invalid_grant")
    assert.equal(error.message.includes("refresh-1"), false)
  })
  it("5xx et 429 du point de jeton : DRIVE_UNAVAILABLE réessayable, connexion inchangée", async () => {
    for (const status of [503, 500, 429]) {
      const { db, state } = fakeDb(record({ tokenExpiry: NOW }))
      const { fetchImpl } = fetchResponding(status, status === 429 ? { error: "rate_limited" } : {})
      const error = await getValidDriveAccessToken("c1", { db, fetchImpl, env, clock: () => NOW, crypto }).catch((e: unknown) => e)
      assert.ok(error instanceof DriveProviderError)
      assert.deepEqual([error.code, error.retryable], ["DRIVE_UNAVAILABLE", true], String(status))
      assert.equal(state.updates.length, 0)
    }
  })
  it("L2-R4 : 400/401 autres qu'invalid_grant ⇒ erreur technique stable, non réessayable, statut ACTIVE conservé (incident tracé)", async () => {
    const cases: Array<[number, unknown, string]> = [
      [401, { error: "invalid_client" }, "DRIVE_OAUTH_MISCONFIGURED"],
      [400, { error: "unauthorized_client" }, "DRIVE_OAUTH_MISCONFIGURED"],
      [400, { error: "invalid_request" }, "DRIVE_OAUTH_PROTOCOL_ERROR"],
      [400, { error: "unsupported_grant_type" }, "DRIVE_OAUTH_PROTOCOL_ERROR"],
      [400, "pas du JSON", "DRIVE_OAUTH_PROTOCOL_ERROR"],
      [401, {}, "DRIVE_OAUTH_PROTOCOL_ERROR"],
      [200, { expires_in: 3600 }, "DRIVE_OAUTH_PROTOCOL_ERROR"],
    ]
    for (const [status, body, code] of cases) {
      const { db, state } = fakeDb(record({ tokenExpiry: NOW }))
      const fetchImpl = async () => new Response(typeof body === "string" ? body : JSON.stringify(body), { status })
      const error = await getValidDriveAccessToken("c1", { db, fetchImpl, env, clock: () => NOW, crypto }).catch((e: unknown) => e)
      assert.ok(error instanceof DriveProviderError, `${status} ${JSON.stringify(body)}`)
      assert.deepEqual([error.code, error.retryable], [code, false], `${status} ${JSON.stringify(body)}`)
      assert.equal(state.row!.status, "ACTIVE", "la connexion n'est pas condamnée")
      assert.ok(state.row!.lastErrorCode, "incident tracé")
    }
    assert.deepEqual(classifyTokenRefusal(400, "invalid_grant"), { kind: "revoked" })
    assert.deepEqual(classifyTokenRefusal(401, "invalid_grant"), { kind: "revoked" })
  })
  it("absente, ERROR ou DISCONNECTED ⇒ DRIVE_NOT_CONNECTED sans réseau", async () => {
    for (const row of [null, record({ status: "ERROR" }), record({ status: "DISCONNECTED", refreshToken: "" })]) {
      const { db } = fakeDb(row)
      const { calls, fetchImpl } = fetchResponding(200, {})
      const error = await getValidDriveAccessToken("c1", { db, fetchImpl, env, clock: () => NOW, crypto }).catch((e: unknown) => e)
      assert.equal((error as DriveProviderError).code, "DRIVE_NOT_CONNECTED")
      assert.equal(calls.length, 0)
      assert.equal(isDriveConnectionUsable(row), false)
    }
  })
  it("withDriveAccess : un 401 Drive déclenche un seul refresh forcé puis une nouvelle tentative", async () => {
    const { db } = fakeDb(record())
    const { fetchImpl } = fetchResponding(200, { access_token: "access-3", expires_in: 3600 })
    const seen: string[] = []
    const result = await withDriveAccess("c1", { db, fetchImpl, env, clock: () => NOW, crypto }, async (token) => {
      seen.push(token)
      if (seen.length === 1) throw new DriveProviderError("DRIVE_UNAUTHORIZED", 503, true, 401, "authError")
      return "ok"
    })
    assert.equal(result, "ok")
    assert.deepEqual(seen, ["access-1", "access-3"])
    const again = withDriveAccess("c1", { db, fetchImpl, env, clock: () => NOW, crypto }, async () => { throw new DriveProviderError("DRIVE_UNAUTHORIZED", 503, true, 401, null) })
    await assert.rejects(again, (e: unknown) => e instanceof DriveProviderError && e.code === "DRIVE_UNAUTHORIZED")
  })
})

describe("connexion Drive — génération de connexion (L2-R3)", () => {
  /** Refresh suspendu : la réponse de Google n'est livrée qu'au signal `release`. */
  function pausedFetch(body: unknown, status = 200) {
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    return { release, fetchImpl: async () => { await gate; return new Response(JSON.stringify(body), { status }) } }
  }
  it("refresh de A suspendu, reconnexion à B, réponse de A livrée ⇒ B intact (jetons, compte), le jeton de A n'est jamais rendu", async () => {
    const { db, state } = fakeDb(record({ tokenExpiry: NOW }))
    const paused = pausedFetch({ access_token: "access-A2", expires_in: 3600 })
    const pending = getValidDriveAccessToken("c1", { db, fetchImpl: paused.fetchImpl, env, clock: () => NOW, crypto })
    state.row = record({ accountEmail: "b@example.test", accessToken: "enc(access-B)", refreshToken: "enc(refresh-B)", tokenExpiry: new Date(NOW.getTime() + 3_600_000) })
    paused.release()
    assert.equal(await pending, "access-B", "seul le jeton de la connexion courante est rendu")
    assert.deepEqual([state.row!.accountEmail, state.row!.accessToken, state.row!.refreshToken], ["b@example.test", "enc(access-B)", "enc(refresh-B)"])
    assert.equal(state.updates.length, 0)
  })
  it("reconnexion à B dont le jeton expire aussi ⇒ refus réessayable, rien d'écrit, jamais le jeton de A", async () => {
    const { db, state } = fakeDb(record({ tokenExpiry: NOW }))
    const paused = pausedFetch({ access_token: "access-A2", expires_in: 3600 })
    const pending = getValidDriveAccessToken("c1", { db, fetchImpl: paused.fetchImpl, env, clock: () => NOW, crypto }).catch((e: unknown) => e)
    state.row = record({ accessToken: "enc(access-B)", refreshToken: "enc(refresh-B)", tokenExpiry: NOW })
    paused.release()
    const error = await pending
    assert.ok(error instanceof DriveProviderError)
    assert.deepEqual([error.code, error.retryable, error.reason], ["DRIVE_UNAVAILABLE", true, "connection_changed_during_refresh"])
    assert.equal(state.row!.accessToken, "enc(access-B)")
  })
  it("déconnexion pendant le refresh ⇒ aucun jeton réécrit après effacement, DRIVE_NOT_CONNECTED", async () => {
    const { db, state } = fakeDb(record({ tokenExpiry: NOW }))
    const paused = pausedFetch({ access_token: "access-A2", expires_in: 3600 })
    const pending = getValidDriveAccessToken("c1", { db, fetchImpl: paused.fetchImpl, env, clock: () => NOW, crypto }).catch((e: unknown) => e)
    await disconnectDriveLocally("c1", { db, clock: () => NOW })
    paused.release()
    assert.equal(((await pending) as DriveProviderError).code, "DRIVE_NOT_CONNECTED")
    assert.deepEqual([state.row!.status, state.row!.accessToken, state.row!.refreshToken], ["DISCONNECTED", "", ""])
  })
  it("invalid_grant tardif de A après reconnexion à B ⇒ B reste ACTIVE, sans erreur", async () => {
    const { db, state } = fakeDb(record({ tokenExpiry: NOW }))
    const paused = pausedFetch({ error: "invalid_grant" }, 400)
    const pending = getValidDriveAccessToken("c1", { db, fetchImpl: paused.fetchImpl, env, clock: () => NOW, crypto }).catch((e: unknown) => e)
    state.row = record({ accessToken: "enc(access-B)", refreshToken: "enc(refresh-B)", tokenExpiry: new Date(NOW.getTime() + 3_600_000) })
    paused.release()
    assert.equal(((await pending) as DriveProviderError).code, "DRIVE_NOT_CONNECTED", "l'appel de A échoue")
    assert.deepEqual([state.row!.status, state.row!.lastErrorCode], ["ACTIVE", null], "la connexion B n'est pas mise en erreur")
  })
  it("deux refresh concurrents de la même génération ⇒ les deux aboutissent, un jeton valide du même compte est publié", async () => {
    const { db, state } = fakeDb(record({ tokenExpiry: NOW }))
    let n = 0
    const fetchImpl = async () => new Response(JSON.stringify({ access_token: `access-${++n}`, expires_in: 3600 }), { status: 200 })
    const [a, b] = await Promise.all([1, 2].map(() => getValidDriveAccessToken("c1", { db, fetchImpl, env, clock: () => NOW, crypto })))
    assert.deepEqual(new Set([a, b]), new Set(["access-1", "access-2"]))
    assert.equal(state.row!.refreshToken, "enc(refresh-1)")
    assert.match(state.row!.accessToken, /^enc\(access-[12]\)$/)
  })
})

describe("connexion Drive — stockage et déconnexion locale", () => {
  it("storeDriveConnection : upsert chiffré, statut ACTIVE, erreurs effacées", async () => {
    const { db, state } = fakeDb(null)
    await storeDriveConnection({ companyId: "c1", accountEmail: "galya@example.test", accessToken: "a", refreshToken: "r", expiresInSeconds: 3600, connectedById: "u1" }, { db, clock: () => NOW, crypto })
    const upsert = state.upserts[0] as { create: Record<string, unknown>; update: Record<string, unknown> }
    assert.equal(upsert.create.accessToken, "enc(a)")
    assert.equal(upsert.create.refreshToken, "enc(r)")
    assert.equal(upsert.update.status, "ACTIVE")
    assert.equal(upsert.update.lastErrorCode, null)
    assert.equal(upsert.update.disconnectedAt, null)
    assert.equal(JSON.stringify(upsert).includes('"a"'), false, "jamais de jeton en clair")
  })
  it("disconnectDriveLocally : tokens effacés, DISCONNECTED, aucun appel réseau, aucune autre table touchée", async () => {
    const { db, state } = fakeDb(record())
    const { calls, fetchImpl } = fetchResponding(200, {})
    assert.equal(await disconnectDriveLocally("c1", { db, fetchImpl, clock: () => NOW, crypto }), true)
    assert.equal(calls.length, 0, "aucune révocation Google")
    assert.deepEqual(state.updates[0], { accessToken: "", refreshToken: "", status: "DISCONNECTED", disconnectedAt: NOW, lastErrorCode: null, lastErrorAt: null })
    assert.equal(Object.keys(db).join(","), "worksitePhotoDriveConnection", "la surface base ne contient aucune table Gmail")
    assert.equal(await disconnectDriveLocally("c1", { db, fetchImpl, clock: () => NOW, crypto }), false, "déjà déconnectée : idempotent")
  })
})
