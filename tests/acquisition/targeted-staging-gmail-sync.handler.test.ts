/**
 * Harness sync Gmail ciblée — toutes les deps injectées (auth, env, DB, sync, adaptateurs).
 * Aucun accès réel DB / Gmail / OAuth : les deps non attendues sont des « bombes » qui lèvent.
 */
process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test"

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import path from "node:path"
import {
  GMAIL_SYNC_ALLOWED_VERCEL_PROJECT_ID,
  TARGETED_GMAIL_SYNC_CHECK_CONFIRMATION,
  TARGETED_GMAIL_SYNC_RUN_CONFIRMATION,
  handleTargetedStagingGmailSync,
  type GmailSyncConnectionTarget,
  type GmailSyncInvocation,
  type GmailSyncSession,
  type TargetedGmailSyncHandlerDeps,
} from "@/lib/acquisition/connector/targeted-staging-gmail-sync.handler"
import type { MailSyncResult } from "@/lib/acquisition/connector/connector.types"
import type { MailProviderPort } from "@/lib/acquisition/ports/mail-provider.port"

const ROOT = path.resolve(__dirname, "../..")
const HANDLER_PATH = "src/lib/acquisition/connector/targeted-staging-gmail-sync.handler.ts"
const ROUTE_PATH = "src/app/api/acquisition/targeted-staging-gmail-sync/route.ts"

const COMPANY = "co-fict-sync"
const CONNECTION = "conn-fict-sync"
const OTHER_CONNECTION = "conn-fict-other"
const SECRET_TOKEN = "ya29.FICT-SECRET-ACCESS-TOKEN"
const SECRET_REFRESH = "1//FICT-SECRET-REFRESH"
const HISTORY_ID = "9876543210"

const ENV = {
  VERCEL_ENV: "preview",
  VERCEL_PROJECT_ID: GMAIL_SYNC_ALLOWED_VERCEL_PROJECT_ID,
  TARGETED_STAGING_GMAIL_SYNC_ENABLED: "true",
  TARGETED_STAGING_GMAIL_SYNC_COMPANY_ID: COMPANY,
  TARGETED_STAGING_GMAIL_SYNC_CONNECTION_ID: CONNECTION,
}
const ADMIN: GmailSyncSession = { user: { id: "u1", role: "ADMIN", companyId: COMPANY } }
const CHECK = { confirmation: TARGETED_GMAIL_SYNC_CHECK_CONFIRMATION }
const RUN = { confirmation: TARGETED_GMAIL_SYNC_RUN_CONFIRMATION }

/** Sentinelles d'identité : prouvent que le handler transmet exactement les adaptateurs attendus. */
const PROVIDER = { source: "GMAIL", __sentinel: "provider" } as unknown as MailProviderPort
const INGESTION = { __sentinel: "ingestion" } as unknown as GmailSyncInvocation["ingestion"]
const CURSOR = { __sentinel: "cursor" } as unknown as GmailSyncInvocation["cursorRepository"]

function syncResult(over: Partial<MailSyncResult> = {}): MailSyncResult {
  return {
    companyId: COMPANY,
    source: "GMAIL",
    status: "SUCCESS",
    stats: { fetched: 3, ingested: 1, skippedDuplicate: 2, rejected: 0, failed: 0 },
    nextHistoryId: HISTORY_ID,
    ...over,
  }
}

function bomb(name: string) {
  return async (): Promise<never> => {
    throw new Error(`${name} MUST NOT BE CALLED`)
  }
}

function deps(over: Partial<TargetedGmailSyncHandlerDeps> = {}) {
  const calls = { load: [] as unknown[], sync: [] as GmailSyncInvocation[], provider: 0 }
  const d: TargetedGmailSyncHandlerDeps = {
    auth: async () => ADMIN,
    env: { ...ENV },
    loadConnection: async (input) => {
      calls.load.push(input)
      return { id: CONNECTION, companyId: COMPANY, active: true }
    },
    sync: async (input) => {
      calls.sync.push(input)
      return syncResult()
    },
    createProvider: () => {
      calls.provider++
      return PROVIDER
    },
    ingestion: INGESTION,
    cursorRepository: CURSOR,
    ...over,
  }
  return { d, calls }
}

async function call(body: unknown, d: TargetedGmailSyncHandlerDeps) {
  const res = await handleTargetedStagingGmailSync(
    new Request("http://localhost/api/acquisition/targeted-staging-gmail-sync", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
    d
  )
  const text = await res.text()
  return { status: res.status, json: JSON.parse(text) as Record<string, unknown>, text, cache: res.headers.get("cache-control") }
}

const NO_IO = {
  loadConnection: bomb("loadConnection"),
  sync: bomb("sync"),
  createProvider: () => {
    throw new Error("createProvider MUST NOT BE CALLED")
  },
}

describe("gardes — refus avant toute lecture DB, Gmail ou sync", () => {
  const cases: Array<[string, Partial<TargetedGmailSyncHandlerDeps>, unknown, number, string]> = [
    ["surface : VERCEL_ENV production", { env: { ...ENV, VERCEL_ENV: "production" } }, RUN, 403, "HARNESS_SURFACE_FORBIDDEN"],
    ["surface : VERCEL_ENV absent", { env: { ...ENV, VERCEL_ENV: undefined } }, RUN, 403, "HARNESS_SURFACE_FORBIDDEN"],
    ["mauvais VERCEL_PROJECT_ID", { env: { ...ENV, VERCEL_PROJECT_ID: "prj_other" } }, RUN, 403, "HARNESS_SURFACE_FORBIDDEN"],
    ["VERCEL_PROJECT_ID absent", { env: { ...ENV, VERCEL_PROJECT_ID: undefined } }, RUN, 403, "HARNESS_SURFACE_FORBIDDEN"],
    ["flag off (absent)", { env: { ...ENV, TARGETED_STAGING_GMAIL_SYNC_ENABLED: undefined } }, RUN, 403, "HARNESS_DISABLED"],
    ["flag ≠ \"true\"", { env: { ...ENV, TARGETED_STAGING_GMAIL_SYNC_ENABLED: "TRUE" } }, RUN, 403, "HARNESS_DISABLED"],
    ["non authentifié", { auth: async () => null }, RUN, 401, "UNAUTHORIZED"],
    ["auth lève", { auth: async () => { throw new Error(SECRET_TOKEN) } }, RUN, 401, "UNAUTHORIZED"],
    ["rôle USER", { auth: async () => ({ user: { id: "u", role: "USER", companyId: COMPANY } }) }, RUN, 403, "FORBIDDEN"],
    ["JSON invalide", {}, "{bad", 400, "INVALID_BODY"],
    ["body tableau", {}, [RUN], 400, "INVALID_BODY"],
    ["champ inconnu", {}, { ...RUN, dryRun: true }, 400, "UNKNOWN_FIELD"],
    ["confirmation absente", {}, {}, 400, "CONFIRMATION_REQUIRED"],
    ["confirmation fausse", {}, { confirmation: `${TARGETED_GMAIL_SYNC_RUN_CONFIRMATION} ` }, 400, "CONFIRMATION_REQUIRED"],
    ["confirmation minuscule", {}, { confirmation: TARGETED_GMAIL_SYNC_RUN_CONFIRMATION.toLowerCase() }, 400, "CONFIRMATION_REQUIRED"],
    ["confirmation d'un autre harness", {}, { confirmation: "RUN_TARGETED_STAGING_GMAIL_MIME_DIAGNOSTIC" }, 400, "CONFIRMATION_REQUIRED"],
    ["cible env company absente", { env: { ...ENV, TARGETED_STAGING_GMAIL_SYNC_COMPANY_ID: undefined } }, RUN, 403, "HARNESS_TARGET_UNSET"],
    ["cible env connexion blanche", { env: { ...ENV, TARGETED_STAGING_GMAIL_SYNC_CONNECTION_ID: "  " } }, RUN, 403, "HARNESS_TARGET_UNSET"],
    ["tenant mismatch", { auth: async () => ({ user: { id: "u", role: "ADMIN", companyId: "co-other" } }) }, RUN, 403, "TENANT_MISMATCH"],
    ["session sans companyId", { auth: async () => ({ user: { id: "u", role: "SUPER_ADMIN", companyId: null } }) }, RUN, 403, "TENANT_MISMATCH"],
  ]
  for (const [label, over, body, status, code] of cases) {
    it(`${label} → ${status} ${code}`, async () => {
      const { d } = deps({ ...NO_IO, ...over })
      const r = await call(body, d)
      assert.equal(r.status, status)
      assert.equal(r.json.ok, false)
      assert.equal(r.json.code, code)
      assert.equal(r.cache, "no-store")
      assert.deepEqual(Object.keys(r.json).sort(), ["code", "message", "ok"])
    })
  }

  for (const key of [
    "companyId", "company_id", "COMPANY-ID",
    "connectionId", "connection_id", "acquisitionGmailConnectionId", "gmail_connection_id",
    "mailboxKey", "mailbox_key", "sourceMailboxKey", "source-mailbox-key", "mailbox",
    "email", "EMAIL", "emailAddress", "email_address", "address",
    "messageId", "message_id", "externalMessageId", "acquisitionMessageId",
    "draftId", "draft_id", "target", "TARGET",
  ]) {
    it(`override cible « ${key} » (avec confirmation valide) → TARGET_OVERRIDE_FORBIDDEN`, async () => {
      const { d } = deps(NO_IO)
      const r = await call({ ...RUN, [key]: OTHER_CONNECTION }, d)
      assert.equal(r.status, 400)
      assert.equal(r.json.code, "TARGET_OVERRIDE_FORBIDDEN")
    })
  }

  it("SUPER_ADMIN du tenant cible → autorisé (CHECK)", async () => {
    const { d } = deps({
      auth: async () => ({ user: { id: "u", role: "SUPER_ADMIN", companyId: COMPANY } }),
      sync: bomb("sync"),
    })
    assert.equal((await call(CHECK, d)).status, 200)
  })
})

describe("connexion cible — lue par id + companyId exacts, fail-closed", () => {
  const cases: Array<[string, GmailSyncConnectionTarget | null, number, string]> = [
    ["connexion absente", null, 404, "CONNECTION_NOT_FOUND"],
    ["id retourné ≠ cible", { id: OTHER_CONNECTION, companyId: COMPANY, active: true }, 404, "CONNECTION_NOT_FOUND"],
    ["companyId retourné ≠ cible", { id: CONNECTION, companyId: "co-other", active: true }, 404, "CONNECTION_NOT_FOUND"],
    ["connexion inactive", { id: CONNECTION, companyId: COMPANY, active: false }, 409, "CONNECTION_INACTIVE"],
    ["active non booléen", { id: CONNECTION, companyId: COMPANY, active: "true" as unknown as boolean }, 409, "CONNECTION_INACTIVE"],
  ]
  for (const mode of [CHECK, RUN]) {
    for (const [label, row, status, code] of cases) {
      it(`${label} (${mode === CHECK ? "CHECK" : "RUN"}) → ${status} ${code}, aucune sync`, async () => {
        const loads: unknown[] = []
        const { d } = deps({
          loadConnection: async (input) => {
            loads.push(input)
            return row
          },
          sync: bomb("sync"),
          createProvider: NO_IO.createProvider,
        })
        const r = await call(mode, d)
        assert.equal(r.status, status)
        assert.equal(r.json.code, code)
        assert.deepEqual(loads, [{ companyId: COMPANY, connectionId: CONNECTION }])
      })
    }
  }

  it("lecture connexion en erreur → CONNECTION_LOAD_FAILED sans fuite, aucune sync", async () => {
    const { d } = deps({
      loadConnection: async () => {
        throw new Error(`prisma error ${SECRET_REFRESH}`)
      },
      sync: bomb("sync"),
    })
    const r = await call(RUN, d)
    assert.equal(r.status, 500)
    assert.equal(r.json.code, "CONNECTION_LOAD_FAILED")
    assert.ok(!r.text.includes(SECRET_REFRESH))
    assert.ok(!r.text.includes("prisma"))
  })
})

describe("CHECK — lecture seule", () => {
  it("CHECK valide → réponse minimale exacte ; aucune sync, aucun provider Gmail créé", async () => {
    const { d, calls } = deps({ sync: bomb("sync"), createProvider: NO_IO.createProvider })
    const r = await call(CHECK, d)
    assert.equal(r.status, 200, r.text)
    assert.equal(r.cache, "no-store")
    assert.deepEqual(r.json, {
      ok: true,
      harness: "targeted-staging-gmail-sync",
      mode: "CHECK",
      checks: {
        surfaceAllowed: true,
        flagEnabled: true,
        authorized: true,
        tenantMatch: true,
        targetConfigured: true,
        connectionFound: true,
        connectionActive: true,
      },
      gmailCalled: false,
      syncCalled: false,
    })
    assert.deepEqual(calls.load, [{ companyId: COMPANY, connectionId: CONNECTION }])
    assert.deepEqual(calls.sync, [])
    assert.equal(calls.provider, 0)
  })
})

describe("RUN — un seul appel au service normal, connexion configurée uniquement", () => {
  it("sync appelée exactement une fois : companyId + connectionId env, provider/ingestion/curseur normaux, mailShadow false", async () => {
    const { d, calls } = deps()
    const r = await call(RUN, d)
    assert.equal(r.status, 200, r.text)
    assert.equal(calls.sync.length, 1)
    assert.equal(calls.provider, 1)
    const input = calls.sync[0]!
    assert.deepEqual(Object.keys(input).sort(), [
      "companyId", "connectionId", "cursorRepository", "ingestion", "mailShadow", "provider",
    ])
    assert.equal(input.companyId, COMPANY)
    assert.equal(input.connectionId, CONNECTION)
    assert.equal(input.provider, PROVIDER)
    assert.equal(input.ingestion, INGESTION)
    assert.equal(input.cursorRepository, CURSOR)
    assert.equal(input.mailShadow, false)
  })

  it("RUN ne peut pas cibler une deuxième connexion : body refusé, connexion lue ≠ cible refusée, sync toujours sur la cible env", async () => {
    const viaBody = deps({ ...NO_IO })
    assert.equal((await call({ ...RUN, connectionId: OTHER_CONNECTION }, viaBody.d)).json.code, "TARGET_OVERRIDE_FORBIDDEN")

    const viaDb = deps({
      loadConnection: async () => ({ id: OTHER_CONNECTION, companyId: COMPANY, active: true }),
      sync: bomb("sync"),
    })
    assert.equal((await call(RUN, viaDb.d)).json.code, "CONNECTION_NOT_FOUND")

    const ok = deps()
    await call(RUN, ok.d)
    assert.deepEqual(ok.calls.sync.map((s) => s.connectionId), [CONNECTION])
  })

  it("réponse RUN : statut + compteurs + présence nextHistoryId uniquement", async () => {
    const { d } = deps({
      sync: async () =>
        syncResult({
          status: "PARTIAL",
          partialReason: "MESSAGE_INGESTION_FAILED",
          stats: { fetched: 5, ingested: 2, skippedDuplicate: 1, rejected: 1, failed: 1 },
        }),
    })
    const r = await call(RUN, d)
    assert.deepEqual(r.json, {
      ok: true,
      harness: "targeted-staging-gmail-sync",
      mode: "RUN",
      syncCalled: true,
      result: {
        status: "PARTIAL",
        skipReason: null,
        partialReason: "MESSAGE_INGESTION_FAILED",
        stats: { fetched: 5, ingested: 2, skippedDuplicate: 1, rejected: 1, failed: 1 },
        hasNextHistoryId: true,
        errorCode: null,
      },
    })
    assert.ok(!r.text.includes(HISTORY_ID))
    assert.ok(!r.text.includes(COMPANY))
    assert.ok(!r.text.includes(CONNECTION))
  })

  it("résultat FAILED : code sûr exposé, message d'erreur jamais exposé", async () => {
    const { d } = deps({
      sync: async () =>
        syncResult({
          status: "FAILED",
          nextHistoryId: null,
          error: { code: "GMAIL_TOKEN_REFRESH_FAILED", message: `invalid_grant ${SECRET_REFRESH} Bearer ${SECRET_TOKEN}`, retryable: false },
        }),
    })
    const r = await call(RUN, d)
    const result = r.json.result as Record<string, unknown>
    assert.equal(result.status, "FAILED")
    assert.equal(result.errorCode, "GMAIL_TOKEN_REFRESH_FAILED")
    assert.equal(result.hasNextHistoryId, false)
    for (const s of [SECRET_REFRESH, SECRET_TOKEN, "invalid_grant", "Bearer", '"message"']) {
      assert.ok(!r.text.includes(s), s)
    }
  })

  it("code d'erreur au format non sûr → null (jamais renvoyé tel quel)", async () => {
    const { d } = deps({
      sync: async () =>
        syncResult({ status: "FAILED", error: { code: `x ${SECRET_TOKEN}`, message: "m", retryable: false } }),
    })
    const r = await call(RUN, d)
    assert.equal((r.json.result as Record<string, unknown>).errorCode, null)
    assert.ok(!r.text.includes(SECRET_TOKEN))
  })

  it("sync qui lève (message contenant des secrets) → 500 SYNC_FAILED sans fuite, un seul appel, aucun retry", async () => {
    let n = 0
    const { d } = deps({
      sync: async () => {
        n++
        throw new Error(`Gmail 401 Authorization: Bearer ${SECRET_TOKEN} refresh=${SECRET_REFRESH}`)
      },
    })
    const r = await call(RUN, d)
    assert.equal(r.status, 500)
    assert.equal(r.json.code, "SYNC_FAILED")
    assert.equal(n, 1)
    for (const s of [SECRET_TOKEN, SECRET_REFRESH, "Bearer", "Gmail 401", "stack"]) {
      assert.ok(!r.text.includes(s), s)
    }
  })

  it("aucun message Gmail, sujet, snippet ou shadowStats dans la réponse même si le résultat en contient", async () => {
    const { d } = deps({
      sync: async () =>
        ({
          ...syncResult(),
          shadowStats: { secretShadow: "SHADOW-SENSITIVE" },
          messages: [{ subject: "SUBJECT-SENSITIVE", snippet: "SNIPPET-SENSITIVE" }],
        }) as unknown as MailSyncResult,
    })
    const r = await call(RUN, d)
    for (const s of ["SHADOW-SENSITIVE", "SUBJECT-SENSITIVE", "SNIPPET-SENSITIVE", "shadowStats", "messages"]) {
      assert.ok(!r.text.includes(s), s)
    }
  })
})

describe("source", () => {
  const src = readFileSync(path.join(ROOT, HANDLER_PATH), "utf8")
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")

  it("aucun cron global, listing de connexions, driver, boucle, getValidAccessToken direct ni log", () => {
    for (const forbidden of [
      /listActiveAcquisitionGmailConnections/,
      /runAcquisitionGmailSyncDriver/,
      /acquisitionGmailConnectionListingAdapter/,
      /acquisition-gmail-sync\.handler/,
      /getValidAccessToken/,
      /console\./,
      /\.findMany\(/,
      /\bfor\s*\(/,
      /\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\(/,
      /\$executeRaw|\$queryRaw|\$transaction/,
    ]) {
      assert.ok(!forbidden.test(code), String(forbidden))
    }
  })

  it("un seul appel sync, câblé sur les adaptateurs normaux, mailShadow false", () => {
    assert.equal((code.match(/await sync\(/g) ?? []).length, 1)
    assert.match(code, /deps\.sync \?\? syncAcquisitionMailForCompany/)
    assert.match(code, /deps\.createProvider \?\? createGmailMailProviderAdapter/)
    assert.match(code, /deps\.ingestion \?\? acquisitionIngestionAdapter/)
    assert.match(code, /deps\.cursorRepository \?\? acquisitionScanCursorRepository/)
    assert.match(code, /mailShadow: false/)
    assert.match(code, /select: \{ id: true, companyId: true, active: true \}/)
    assert.match(code, /where: \{ id: input\.connectionId, companyId: input\.companyId \}/)
  })

  it("route mince : POST uniquement", () => {
    const route = readFileSync(path.join(ROOT, ROUTE_PATH), "utf8")
    assert.match(route, /return handleTargetedStagingGmailSync\(req\)/)
    assert.ok(!/export async function (GET|PUT|PATCH|DELETE)/.test(route))
  })
})
