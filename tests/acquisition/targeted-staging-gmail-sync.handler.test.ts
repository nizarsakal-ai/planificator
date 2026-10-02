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
  TARGETED_GMAIL_SYNC_INSPECT_CONFIRMATION,
  INSPECT_MAX_MESSAGES,
  INSPECT_RECEIVED_SINCE,
  buildInspectFindManyArgs,
  isPenvenCandidateSubject,
  handleTargetedStagingGmailSync,
  type GmailSyncInspectArgs,
  type GmailSyncInspectRow,
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
    // INSPECT uniquement : toute lecture hors INSPECT est une faute (prouve CHECK / RUN inchangés).
    findMessages: bomb("findMessages"),
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
      /\bfor\s*\(/,
      /\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\(/,
      /\$executeRaw|\$queryRaw|\$transaction/,
    ]) {
      assert.ok(!forbidden.test(code), String(forbidden))
    }
    // INSPECT : exactement une lecture findMany, uniquement sur acquisitionMessage.
    assert.equal((code.match(/\.findMany\(/g) ?? []).length, 1)
    assert.match(code, /prisma\.acquisitionMessage\.findMany\(args\)/)
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

// ---------------------------------------------------------------------------
// INSPECT — lecture seule post-504 : le mail Penven est-il déjà en base ?
// ---------------------------------------------------------------------------

const INSPECT = { confirmation: TARGETED_GMAIL_SYNC_INSPECT_CONFIRMATION }

function inspectRow(over: Partial<GmailSyncInspectRow> = {}): GmailSyncInspectRow {
  return {
    id: "msg-1",
    externalMessageId: "gmail-ext-1",
    sourceMailboxKey: CONNECTION,
    senderEmail: "planning@partner.test",
    subject: "Consultation démontage_BISCUITERIE PENVEN_20/10 et 21/10",
    receivedAt: new Date("2026-10-01T14:24:00.000Z"),
    status: "DRAFT_CREATED",
    createdAt: new Date("2026-10-02T08:00:00.000Z"),
    updatedAt: new Date("2026-10-02T08:00:01.000Z"),
    draft: { id: "draft-1", status: "PENDING_EXTRACTION", createdWorksiteId: null },
    ...over,
  }
}

function inspectDeps(rows: GmailSyncInspectRow[], over: Partial<TargetedGmailSyncHandlerDeps> = {}) {
  const reads: GmailSyncInspectArgs[] = []
  const base = deps({
    sync: bomb("sync"),
    createProvider: NO_IO.createProvider,
    findMessages: async (args) => {
      reads.push(args)
      return rows
    },
    ...over,
  })
  return { ...base, reads }
}

describe("INSPECT — lecture seule post-504", () => {
  it("confirmation INSPECT exacte acceptée → réponse compacte, readOnly, gmailCalled/syncCalled false", async () => {
    const { d, calls, reads } = inspectDeps([inspectRow()])
    const r = await call(INSPECT, d)
    assert.equal(r.status, 200, r.text)
    assert.equal(r.cache, "no-store")
    assert.deepEqual(Object.keys(r.json).sort(), [
      "count", "gmailCalled", "harness", "messages", "mode", "ok", "penvenFound", "readOnly", "syncCalled",
    ])
    assert.equal(r.json.ok, true)
    assert.equal(r.json.harness, "targeted-staging-gmail-sync")
    assert.equal(r.json.mode, "INSPECT")
    assert.equal(r.json.readOnly, true)
    assert.equal(r.json.gmailCalled, false)
    assert.equal(r.json.syncCalled, false)
    assert.equal(r.json.count, 1)
    assert.equal(r.json.penvenFound, true)
    assert.equal(reads.length, 1, "exactement une lecture findMany")
    assert.deepEqual(calls.sync, [], "sync jamais appelée")
    assert.equal(calls.provider, 0, "provider Gmail jamais créé")
    assert.deepEqual(calls.load, [{ companyId: COMPANY, connectionId: CONNECTION }])
  })

  for (const bad of [
    "INSPECT",
    `${TARGETED_GMAIL_SYNC_INSPECT_CONFIRMATION} `,
    TARGETED_GMAIL_SYNC_INSPECT_CONFIRMATION.toLowerCase(),
    "INSPECT_TARGETED_STAGING_GMAIL_MIME_DIAGNOSTIC",
  ]) {
    it(`mauvaise confirmation « ${bad} » → CONFIRMATION_REQUIRED, aucune lecture`, async () => {
      const { d, reads } = inspectDeps([inspectRow()], { loadConnection: bomb("loadConnection") })
      const r = await call({ confirmation: bad }, d)
      assert.equal(r.status, 400)
      assert.equal(r.json.code, "CONFIRMATION_REQUIRED")
      assert.equal(reads.length, 0)
    })
  }

  const guardCases: Array<[string, Partial<TargetedGmailSyncHandlerDeps>, unknown, number, string]> = [
    ["surface non Preview", { env: { ...ENV, VERCEL_ENV: "production" } }, INSPECT, 403, "HARNESS_SURFACE_FORBIDDEN"],
    ["mauvais project", { env: { ...ENV, VERCEL_PROJECT_ID: "prj_other" } }, INSPECT, 403, "HARNESS_SURFACE_FORBIDDEN"],
    ["flag off", { env: { ...ENV, TARGETED_STAGING_GMAIL_SYNC_ENABLED: undefined } }, INSPECT, 403, "HARNESS_DISABLED"],
    ["non authentifié", { auth: async () => null }, INSPECT, 401, "UNAUTHORIZED"],
    ["rôle USER", { auth: async () => ({ user: { id: "u", role: "USER", companyId: COMPANY } }) }, INSPECT, 403, "FORBIDDEN"],
    ["tenant mismatch", { auth: async () => ({ user: { id: "u", role: "ADMIN", companyId: "co-other" } }) }, INSPECT, 403, "TENANT_MISMATCH"],
    ["cible env absente", { env: { ...ENV, TARGETED_STAGING_GMAIL_SYNC_CONNECTION_ID: undefined } }, INSPECT, 403, "HARNESS_TARGET_UNSET"],
    ["override cible body", {}, { ...INSPECT, sourceMailboxKey: "conn-other" }, 400, "TARGET_OVERRIDE_FORBIDDEN"],
    ["override receivedAt / take refusé (champ inconnu)", {}, { ...INSPECT, take: 500 }, 400, "UNKNOWN_FIELD"],
    ["connexion absente", { loadConnection: async () => null }, INSPECT, 404, "CONNECTION_NOT_FOUND"],
    ["connexion inactive", { loadConnection: async () => ({ id: CONNECTION, companyId: COMPANY, active: false }) }, INSPECT, 409, "CONNECTION_INACTIVE"],
  ]
  for (const [label, over, body, status, code] of guardCases) {
    it(`gardes existantes appliquées à INSPECT : ${label} → ${status} ${code}, aucune lecture messages`, async () => {
      const { d, reads } = inspectDeps([inspectRow()], over)
      const r = await call(body, d)
      assert.equal(r.status, status)
      assert.equal(r.json.code, code)
      assert.equal(reads.length, 0)
    })
  }

  it("filtre exact : companyId + source GMAIL + sourceMailboxKey cibles, receivedAt ≥ 2026-10-01, desc, take 20, select minimal", async () => {
    const { d, reads } = inspectDeps([])
    await call(INSPECT, d)
    const args = reads[0]!
    assert.deepEqual(Object.keys(args).sort(), ["orderBy", "select", "take", "where"])
    assert.deepEqual(Object.keys(args.where).sort(), ["companyId", "receivedAt", "source", "sourceMailboxKey"])
    assert.equal(args.where.companyId, COMPANY)
    assert.equal(args.where.source, "GMAIL")
    assert.equal(args.where.sourceMailboxKey, CONNECTION)
    assert.deepEqual(Object.keys(args.where.receivedAt), ["gte"])
    assert.equal(args.where.receivedAt.gte.toISOString(), "2026-10-01T00:00:00.000Z")
    assert.equal(INSPECT_RECEIVED_SINCE, "2026-10-01T00:00:00.000Z")
    assert.deepEqual(args.orderBy, { receivedAt: "desc" })
    assert.equal(args.take, 20)
    assert.ok(args.take <= 20 && INSPECT_MAX_MESSAGES === 20)
    assert.deepEqual(args.select, {
      id: true,
      externalMessageId: true,
      sourceMailboxKey: true,
      senderEmail: true,
      subject: true,
      receivedAt: true,
      status: true,
      createdAt: true,
      updatedAt: true,
      draft: { select: { id: true, status: true, createdWorksiteId: true } },
    })
    assert.deepEqual(buildInspectFindManyArgs({ companyId: COMPANY, connectionId: CONNECTION }).where.sourceMailboxKey, CONNECTION)
  })

  it("plus de 20 lignes retournées par la lecture → réponse bornée à 20", async () => {
    const many = Array.from({ length: 30 }, (_, i) => inspectRow({ id: `m${i}`, subject: `Autre ${i}` }))
    const { d } = inspectDeps(many)
    const r = await call(INSPECT, d)
    assert.equal(r.json.count, 20)
    assert.equal((r.json.messages as unknown[]).length, 20)
  })

  it("détection Penven positive (variantes) / négative, penvenFound correct", () => {
    for (const s of [
      "Consultation démontage_BISCUITERIE PENVEN_20/10 et 21/10",
      "biscuiterie penven",
      "RE: Penven démontage",
      "Chantier PONTAVEN",
      "Usine Pont Aven",
      "pont aven",
    ]) {
      assert.equal(isPenvenCandidateSubject(s), true, s)
    }
    for (const s of ["Consultation démontage GL Events", "", "Penve", "Pont-Avenue", null, undefined, 42]) {
      assert.equal(isPenvenCandidateSubject(s), false, String(s))
    }
  })

  it("liste mixte : penvenCandidate par message, penvenFound true ; liste sans Penven → false ; vide → false", async () => {
    const mixed = inspectDeps([inspectRow({ id: "a", subject: "Consultation GL Events" }), inspectRow({ id: "b" })])
    const r1 = await call(INSPECT, mixed.d)
    assert.deepEqual((r1.json.messages as Array<{ id: string; penvenCandidate: boolean }>).map((m) => [m.id, m.penvenCandidate]), [["a", false], ["b", true]])
    assert.equal(r1.json.penvenFound, true)

    const none = inspectDeps([inspectRow({ subject: "Consultation GL Events" })])
    const r2 = await call(INSPECT, none.d)
    assert.equal(r2.json.penvenFound, false)

    const empty = inspectDeps([])
    const r3 = await call(INSPECT, empty.d)
    assert.deepEqual({ count: r3.json.count, penvenFound: r3.json.penvenFound, messages: r3.json.messages }, { count: 0, penvenFound: false, messages: [] })
  })

  it("forme d'un message : champs sélectionnés + draft (ou null) + penvenCandidate, dates ISO, rien d'autre", async () => {
    const withExtras = {
      ...inspectRow(),
      rawMetadata: { secret: "RAW-SENSITIVE" },
      normalizedText: "BODY-SENSITIVE",
      attachments: [{ storagePublicId: "pub/SENSITIVE" }],
    } as unknown as GmailSyncInspectRow
    const { d } = inspectDeps([withExtras, inspectRow({ id: "no-draft", draft: null })])
    const r = await call(INSPECT, d)
    const [m1, m2] = r.json.messages as Array<Record<string, unknown>>
    assert.deepEqual(m1, {
      id: "msg-1",
      externalMessageId: "gmail-ext-1",
      sourceMailboxKey: CONNECTION,
      senderEmail: "planning@partner.test",
      subject: "Consultation démontage_BISCUITERIE PENVEN_20/10 et 21/10",
      receivedAt: "2026-10-01T14:24:00.000Z",
      status: "DRAFT_CREATED",
      createdAt: "2026-10-02T08:00:00.000Z",
      updatedAt: "2026-10-02T08:00:01.000Z",
      draft: { id: "draft-1", status: "PENDING_EXTRACTION", createdWorksiteId: null },
      penvenCandidate: true,
    })
    assert.equal(m2!.draft, null)
    for (const s of ["RAW-SENSITIVE", "BODY-SENSITIVE", "SENSITIVE", "rawMetadata", "normalizedText", "attachments", "storagePublicId", SECRET_TOKEN]) {
      assert.ok(!r.text.includes(s), s)
    }
  })

  it("lecture en erreur → 500 INSPECT_READ_FAILED, code seul, aucune fuite, aucune sync", async () => {
    const { d, calls } = inspectDeps([], {
      findMessages: async () => {
        throw new Error(`Invalid prisma.acquisitionMessage.findMany() ${SECRET_TOKEN}`)
      },
    })
    const r = await call(INSPECT, d)
    assert.equal(r.status, 500)
    assert.equal(r.json.code, "INSPECT_READ_FAILED")
    assert.ok(!r.text.includes(SECRET_TOKEN))
    assert.ok(!r.text.includes("prisma"))
    assert.deepEqual(calls.sync, [])
  })

  it("CHECK et RUN inchangés : jamais de lecture findMessages (bombe par défaut), mêmes réponses", async () => {
    const check = deps({ sync: bomb("sync") })
    const rc = await call(CHECK, check.d)
    assert.equal(rc.status, 200)
    assert.equal(rc.json.mode, "CHECK")
    assert.ok(!("messages" in rc.json))

    const run = deps()
    const rr = await call(RUN, run.d)
    assert.equal(rr.status, 200)
    assert.equal(rr.json.mode, "RUN")
    assert.equal(run.calls.sync.length, 1)
    assert.ok(!("messages" in rr.json))
  })

  it("source : INSPECT avant RUN, aucune écriture Prisma, aucune sync ni provider dans la branche INSPECT", () => {
    const src = readFileSync(path.join(ROOT, HANDLER_PATH), "utf8")
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")
    const start = code.indexOf('if (mode === "INSPECT") {')
    const end = code.indexOf("const sync = deps.sync")
    assert.ok(start > 0 && end > start, "branche INSPECT avant le câblage RUN")
    const branch = code.slice(start, end)
    assert.ok(!/sync\(|createProvider|syncAcquisitionMailForCompany|getValidAccessToken/.test(branch))
    assert.ok(!/\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\(/.test(code))
    assert.ok(!/\$executeRaw|\$queryRaw|\$transaction/.test(code))
  })
})
