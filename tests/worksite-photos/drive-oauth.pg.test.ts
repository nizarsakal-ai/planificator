// Clé de TEST uniquement (même valeur que les tests Acquisition) : jamais la clé de production.
process.env.GMAIL_TOKEN_ENCRYPTION_KEY ??= "test-encryption-key-32chars-min!!"
/**
 * SPEC-WORKSITE-PHOTOS-001 Lot 2 — protocole de connexion Drive contre PostgreSQL RÉEL et JETABLE, avec le vrai Prisma
 * (structure `prisma as DriveOAuthDb` des routes), le VRAI chiffrement AES-256-GCM (clé de test) et Google FACTICE.
 *
 * Couvre les constats Codex : L2-R1 (double callback concurrent sur le même state : un seul passe, sérialisé par le
 * verrou consultatif), L2-R2 (révocation pendant l'échange ; déconnexion par une session ADMIN périmée), L2-R3
 * (refresh de A contre reconnexion à B, invalid_grant tardif, déconnexion pendant le refresh, sur le vrai CAS SQL).
 *
 * Prérequis : WORKSITE_PHOTOS_TEST_DATABASE_URL = base jetable locale migrée (voir migration.pg.test.ts). Données synthétiques.
 */
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { after, before, describe, it } from "node:test"
import { PrismaClient } from "@prisma/client"
import { getValidDriveAccessToken, storeDriveConnection, disconnectDriveLocally } from "@/lib/worksite-photos/drive/drive-connection.client"
import {
  DRIVE_OAUTH_COOKIE, DRIVE_SCOPE_FILE, handleDriveConnectStart, handleDriveDisconnect, handleDriveOAuthCallback,
  type DriveOAuthDb, type DriveOAuthSession,
} from "@/lib/worksite-photos/drive/drive-oauth"

function disposableUrl(): string {
  const url = process.env.WORKSITE_PHOTOS_TEST_DATABASE_URL?.trim()
  if (!url) throw new Error("WORKSITE_PHOTOS_TEST_DATABASE_URL absente : base PostgreSQL jetable requise (voir migration.pg.test.ts).")
  const parsed = new URL(url)
  if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(parsed.hostname)) throw new Error("WORKSITE_PHOTOS_TEST_DATABASE_URL doit viser une base locale jetable.")
  if (process.env.DATABASE_URL && process.env.DATABASE_URL.trim() === url) throw new Error("WORKSITE_PHOTOS_TEST_DATABASE_URL ne doit pas être DATABASE_URL.")
  return url
}

const RUN = randomUUID().slice(0, 8)
const ENV = {
  PLANIFICATOR_WORKSITE_PHOTOS_ENABLED: "true", CRON_SECRET: "test-cron-secret-for-oauth-state", GOOGLE_CLIENT_ID: "cid", GOOGLE_CLIENT_SECRET: "csecret",
  DRIVE_OAUTH_REDIRECT_URI: "https://app.example.test/api/auth/drive/callback", NEXTAUTH_URL: "https://app.example.test",
}
const jsonRes = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })
const settingsParams = (res: Response) => new URL(res.headers.get("location")!).searchParams

describe("connexion Drive × PostgreSQL jetable (L2-R1, L2-R2, L2-R3)", () => {
  let prisma: PrismaClient
  let db: DriveOAuthDb
  let seq = 0
  /** Une entreprise et son administrateur, isolés par scénario. */
  async function tenant() {
    const n = `${RUN}-${++seq}`
    const ids = { company: `c-${n}`, admin: `u-${n}` }
    await prisma.$executeRawUnsafe(`INSERT INTO "companies" ("id","name","slug","updatedAt") VALUES ('${ids.company}','C ${n}','c-${n}',now())`)
    await prisma.$executeRawUnsafe(`INSERT INTO "users" ("id","email","password","role","companyId","updatedAt") VALUES ('${ids.admin}','a-${n}@example.test','x','ADMIN','${ids.company}',now())`)
    const session: DriveOAuthSession = { user: { id: ids.admin, role: "ADMIN", companyId: ids.company } }
    return { ids, session }
  }
  async function start(session: DriveOAuthSession) {
    const res = await handleDriveConnectStart(new Request("https://app.example.test/api/auth/drive"), { auth: async () => session, db, env: ENV })
    assert.equal(res.status, 302)
    return { state: new URL(res.headers.get("location")!).searchParams.get("state")!, cookie: res.headers.get("set-cookie")!.split(";")[0] }
  }
  const callback = (state: string, cookie: string, code = "code") => new Request(`https://app.example.test/api/auth/drive/callback?code=${code}&state=${state}`, { headers: { cookie } })
  const connection = (companyId: string) => prisma.worksitePhotoDriveConnection.findUnique({ where: { companyId } })

  before(async () => {
    prisma = new PrismaClient({ datasources: { db: { url: disposableUrl() } } })
    db = prisma as unknown as DriveOAuthDb
  })
  after(async () => { await prisma.$disconnect() })

  it("L2-R1 : deux callbacks concurrents sur le même state (codes distincts) ⇒ un seul échange, une seule connexion, une seule consommation", async () => {
    const { ids, session } = await tenant()
    const { state, cookie } = await start(session)
    assert.ok(cookie.startsWith(`${DRIVE_OAUTH_COOKIE}=`))
    let exchanges = 0
    const fetchImpl = async (url: string) => {
      if (url.includes("/token")) { exchanges++; await new Promise((r) => setTimeout(r, 150)); return jsonRes({ access_token: `A${exchanges}`, refresh_token: `R${exchanges}`, scope: DRIVE_SCOPE_FILE }) }
      return jsonRes({ email: "galya@example.test" })
    }
    const [a, b] = await Promise.all(["c1", "c2"].map((code) => handleDriveOAuthCallback(callback(state, cookie, code), { auth: async () => session, db, env: ENV, fetchImpl })))
    const outcomes = [settingsParams(a), settingsParams(b)].map((p) => p.get("drive") === "connected" ? "connected" : p.get("reason")).sort()
    assert.deepEqual(outcomes, ["connected", "invalid_state"])
    assert.equal(exchanges, 1, "un seul code échangé")
    const consumed = await prisma.worksitePhotoEvent.count({ where: { companyId: ids.company, action: "DRIVE_OAUTH_STATE_CONSUMED" } })
    assert.equal(consumed, 1)
    assert.equal((await connection(ids.company))?.status, "ACTIVE")
  })

  it("L2-R2 : administrateur désactivé PENDANT l'échange réseau ⇒ forbidden, aucune connexion enregistrée", async () => {
    const { ids, session } = await tenant()
    const { state, cookie } = await start(session)
    const fetchImpl = async (url: string) => {
      if (url.includes("/token")) {
        await prisma.$executeRawUnsafe(`UPDATE "users" SET "active"=false WHERE "id"='${ids.admin}'`)
        return jsonRes({ access_token: "A", refresh_token: "R", scope: DRIVE_SCOPE_FILE })
      }
      return jsonRes({})
    }
    const res = await handleDriveOAuthCallback(callback(state, cookie), { auth: async () => session, db, env: ENV, fetchImpl })
    assert.equal(settingsParams(res).get("reason"), "forbidden")
    assert.equal(await connection(ids.company), null)
  })

  it("L2-R2 : déconnexion par une session ADMIN périmée (compte rétrogradé et inactif) ⇒ 401/403, connexion intacte", async () => {
    const { ids, session } = await tenant()
    await storeDriveConnection({ companyId: ids.company, accountEmail: "a@example.test", accessToken: "A", refreshToken: "R", expiresInSeconds: 3600, connectedById: ids.admin }, { db })
    await prisma.$executeRawUnsafe(`UPDATE "users" SET "role"='EMPLOYEE', "active"=false WHERE "id"='${ids.admin}'`)
    const res = await handleDriveDisconnect(new Request("https://app.example.test/api/worksite-photos/drive/disconnect", { method: "POST", headers: { host: "app.example.test", origin: "https://app.example.test" } }), { auth: async () => session, db, env: ENV })
    assert.ok(res.status === 401 || res.status === 403, String(res.status))
    const row = await connection(ids.company)
    assert.equal(row?.status, "ACTIVE")
    assert.notEqual(row?.refreshToken, "")
  })

  /** Refresh suspendu sur le point de jeton factice ; `release` livre la réponse. */
  function pausedTokenEndpoint(body: unknown, status = 200) {
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    let started!: () => void
    const reached = new Promise<void>((r) => { started = r })
    return { release, reached, fetchImpl: async () => { started(); await gate; return jsonRes(body, status) } }
  }
  const expired = async (companyId: string) => prisma.worksitePhotoDriveConnection.update({ where: { companyId }, data: { tokenExpiry: new Date(Date.now() - 1000) } })

  it("L2-R3 : refresh de A suspendu, reconnexion à B, réponse de A livrée ⇒ B intact (compte, jetons), jamais le jeton de A sous B", async () => {
    const { ids } = await tenant()
    await storeDriveConnection({ companyId: ids.company, accountEmail: "a@example.test", accessToken: "access-A", refreshToken: "refresh-A", expiresInSeconds: 3600, connectedById: ids.admin }, { db })
    await expired(ids.company)
    const paused = pausedTokenEndpoint({ access_token: "access-A2", expires_in: 3600 })
    const pending = getValidDriveAccessToken(ids.company, { db, fetchImpl: paused.fetchImpl, env: ENV })
    await paused.reached
    await storeDriveConnection({ companyId: ids.company, accountEmail: "b@example.test", accessToken: "access-B", refreshToken: "refresh-B", expiresInSeconds: 3600, connectedById: ids.admin }, { db })
    paused.release()
    assert.equal(await pending, "access-B")
    const { decrypt } = await import("@/lib/encryption")
    const row = (await connection(ids.company))!
    assert.deepEqual([row.accountEmail, decrypt(row.accessToken), decrypt(row.refreshToken), row.status], ["b@example.test", "access-B", "refresh-B", "ACTIVE"])
  })

  it("L2-R3 : invalid_grant tardif de A après reconnexion à B ⇒ B reste ACTIVE sans erreur", async () => {
    const { ids } = await tenant()
    await storeDriveConnection({ companyId: ids.company, accountEmail: "a@example.test", accessToken: "access-A", refreshToken: "refresh-A", expiresInSeconds: 3600, connectedById: ids.admin }, { db })
    await expired(ids.company)
    const paused = pausedTokenEndpoint({ error: "invalid_grant" }, 400)
    const pending = getValidDriveAccessToken(ids.company, { db, fetchImpl: paused.fetchImpl, env: ENV }).catch((e: unknown) => e)
    await paused.reached
    await storeDriveConnection({ companyId: ids.company, accountEmail: "b@example.test", accessToken: "access-B", refreshToken: "refresh-B", expiresInSeconds: 3600, connectedById: ids.admin }, { db })
    paused.release()
    await pending
    const row = (await connection(ids.company))!
    assert.deepEqual([row.status, row.lastErrorCode], ["ACTIVE", null])
  })

  it("L2-R3 : déconnexion locale pendant le refresh ⇒ aucun jeton réécrit après effacement", async () => {
    const { ids } = await tenant()
    await storeDriveConnection({ companyId: ids.company, accountEmail: "a@example.test", accessToken: "access-A", refreshToken: "refresh-A", expiresInSeconds: 3600, connectedById: ids.admin }, { db })
    await expired(ids.company)
    const paused = pausedTokenEndpoint({ access_token: "access-A2", expires_in: 3600 })
    const pending = getValidDriveAccessToken(ids.company, { db, fetchImpl: paused.fetchImpl, env: ENV }).catch((e: unknown) => e)
    await paused.reached
    assert.equal(await disconnectDriveLocally(ids.company, { db }), true)
    paused.release()
    assert.equal(((await pending) as { code?: string }).code, "DRIVE_NOT_CONNECTED")
    const row = (await connection(ids.company))!
    assert.deepEqual([row.status, row.accessToken, row.refreshToken], ["DISCONNECTED", "", ""])
  })
})
