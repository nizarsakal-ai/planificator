/**
 * Harness diagnostic Gmail messages.list (Penven) — deps injectées : auth, env, DB connexion, token,
 * client Gmail COMPLET dont toutes les API hors listMessages sont des bombes. Aucun accès réel.
 */
process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test"

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import path from "node:path"
import {
  GMAIL_LIST_DIAGNOSTIC_ALLOWED_VERCEL_PROJECT_ID,
  GMAIL_LIST_DIAGNOSTIC_MAX_RESULTS,
  GMAIL_LIST_DIAGNOSTIC_QUERIES,
  TARGETED_GMAIL_LIST_DIAGNOSTIC_CHECK_CONFIRMATION,
  TARGETED_GMAIL_LIST_DIAGNOSTIC_RUN_CONFIRMATION,
  handleTargetedStagingGmailListDiagnostic,
  summarizeListPage,
  type GmailListDiagnosticConnection,
  type GmailListDiagnosticSession,
  type TargetedGmailListDiagnosticHandlerDeps,
} from "@/lib/acquisition/connector/targeted-staging-gmail-list-diagnostic.handler"
import type { GmailApiClient } from "@/lib/acquisition/connector/gmail-api.client"
import type { GmailMessagesListResponse } from "@/lib/acquisition/connector/gmail-api.types"
import { GmailProviderError } from "@/lib/acquisition/connector/gmail.errors"

const ROOT = path.resolve(__dirname, "../..")
const HANDLER_PATH = "src/lib/acquisition/connector/targeted-staging-gmail-list-diagnostic.handler.ts"
const ROUTE_PATH = "src/app/api/acquisition/targeted-staging-gmail-list-diagnostic/route.ts"

const COMPANY = "co-fict-list"
const CONNECTION = "conn-fict-list"
const TOKEN = "ya29.FICT-SECRET-ACCESS-TOKEN"
const REFRESH = "1//FICT-SECRET-REFRESH"
const PAGE_TOKEN = "NEXT-PAGE-TOKEN-SECRETISH"

const EXPECTED_QUERIES = [
  "from:jeanlaurentcazala@lauralu.fr",
  "after:2026/09/25 from:jeanlaurentcazala@lauralu.fr",
  "from:jeanlaurentcazala@lauralu.fr subject:Consultation",
  "after:2026/09/25 from:jeanlaurentcazala@lauralu.fr subject:Consultation",
]

const ENV = {
  VERCEL_ENV: "preview",
  VERCEL_PROJECT_ID: GMAIL_LIST_DIAGNOSTIC_ALLOWED_VERCEL_PROJECT_ID,
  TARGETED_STAGING_GMAIL_LIST_DIAGNOSTIC_ENABLED: "true",
  TARGETED_STAGING_GMAIL_SYNC_COMPANY_ID: COMPANY,
  TARGETED_STAGING_GMAIL_SYNC_CONNECTION_ID: CONNECTION,
}
const ADMIN: GmailListDiagnosticSession = { user: { id: "u1", role: "ADMIN", companyId: COMPANY } }
const CHECK = { confirmation: TARGETED_GMAIL_LIST_DIAGNOSTIC_CHECK_CONFIRMATION }
const RUN = { confirmation: TARGETED_GMAIL_LIST_DIAGNOSTIC_RUN_CONFIRMATION }

function bomb(name: string) {
  return async (): Promise<never> => {
    throw new Error(`${name} MUST NOT BE CALLED`)
  }
}

type ListCall = { token: string; query: string; maxResults: number; argCount: number }

function setup(opts: {
  pages?: Record<string, GmailMessagesListResponse | Error>
  over?: Partial<TargetedGmailListDiagnosticHandlerDeps>
} = {}) {
  const calls = { load: [] as unknown[], token: [] as unknown[], list: [] as ListCall[] }
  const gmail: GmailApiClient = {
    async listMessages(token, query, maxResults, ...rest: unknown[]) {
      calls.list.push({ token, query, maxResults, argCount: 3 + rest.length })
      const page = opts.pages?.[query]
      if (page instanceof Error) throw page
      return page ?? { resultSizeEstimate: 0 }
    },
    getMessage: bomb("getMessage"),
    getAttachment: bomb("getAttachment"),
    getProfile: bomb("getProfile"),
    listHistory: bomb("listHistory"),
  }
  const d: TargetedGmailListDiagnosticHandlerDeps = {
    auth: async () => ADMIN,
    env: { ...ENV },
    loadConnection: async (input) => {
      calls.load.push(input)
      return { id: CONNECTION, companyId: COMPANY, active: true }
    },
    getValidAccessToken: async (lookup) => {
      calls.token.push(lookup)
      return TOKEN
    },
    gmail,
    ...opts.over,
  }
  return { d, calls }
}

async function call(body: unknown, d: TargetedGmailListDiagnosticHandlerDeps) {
  const res = await handleTargetedStagingGmailListDiagnostic(
    new Request("http://localhost/api/acquisition/targeted-staging-gmail-list-diagnostic", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
    d
  )
  const text = await res.text()
  return { status: res.status, json: JSON.parse(text) as Record<string, unknown>, text, cache: res.headers.get("cache-control") }
}

const NO_IO: Partial<TargetedGmailListDiagnosticHandlerDeps> = {
  loadConnection: bomb("loadConnection"),
  getValidAccessToken: bomb("getValidAccessToken"),
}

describe("gardes Preview / project / flag / auth / RBAC / tenant / cible / connexion / confirmation", () => {
  const cases: Array<[string, Partial<TargetedGmailListDiagnosticHandlerDeps>, unknown, number, string]> = [
    ["non Preview", { env: { ...ENV, VERCEL_ENV: "production" } }, RUN, 403, "HARNESS_SURFACE_FORBIDDEN"],
    ["mauvais project", { env: { ...ENV, VERCEL_PROJECT_ID: "prj_other" } }, RUN, 403, "HARNESS_SURFACE_FORBIDDEN"],
    ["flag absent (désactivé par défaut)", { env: { ...ENV, TARGETED_STAGING_GMAIL_LIST_DIAGNOSTIC_ENABLED: undefined } }, RUN, 403, "HARNESS_DISABLED"],
    ["flag ≠ true", { env: { ...ENV, TARGETED_STAGING_GMAIL_LIST_DIAGNOSTIC_ENABLED: "TRUE" } }, RUN, 403, "HARNESS_DISABLED"],
    ["non authentifié", { auth: async () => null }, RUN, 401, "UNAUTHORIZED"],
    ["auth lève", { auth: async () => { throw new Error(TOKEN) } }, RUN, 401, "UNAUTHORIZED"],
    ["rôle USER", { auth: async () => ({ user: { id: "u", role: "USER", companyId: COMPANY } }) }, RUN, 403, "FORBIDDEN"],
    ["tenant mismatch", { auth: async () => ({ user: { id: "u", role: "ADMIN", companyId: "co-other" } }) }, RUN, 403, "TENANT_MISMATCH"],
    ["session sans companyId", { auth: async () => ({ user: { id: "u", role: "SUPER_ADMIN", companyId: null } }) }, RUN, 403, "TENANT_MISMATCH"],
    ["cible company absente", { env: { ...ENV, TARGETED_STAGING_GMAIL_SYNC_COMPANY_ID: undefined } }, RUN, 403, "HARNESS_TARGET_UNSET"],
    ["cible connexion blanche", { env: { ...ENV, TARGETED_STAGING_GMAIL_SYNC_CONNECTION_ID: " " } }, RUN, 403, "HARNESS_TARGET_UNSET"],
    ["confirmation absente", {}, {}, 400, "CONFIRMATION_REQUIRED"],
    ["confirmation fausse", {}, { confirmation: `${TARGETED_GMAIL_LIST_DIAGNOSTIC_RUN_CONFIRMATION} ` }, 400, "CONFIRMATION_REQUIRED"],
    ["confirmation d'un autre harness", {}, { confirmation: "RUN_TARGETED_STAGING_GMAIL_OAUTH_PROFILE" }, 400, "CONFIRMATION_REQUIRED"],
    ["body invalide", {}, "{bad", 400, "INVALID_BODY"],
    ["champ inconnu", {}, { ...RUN, verbose: true }, 400, "UNKNOWN_FIELD"],
  ]
  for (const [label, over, body, status, code] of cases) {
    it(`${label} → ${status} ${code}, zéro token / Gmail`, async () => {
      const { d, calls } = setup({ over: { ...NO_IO, ...over } })
      const r = await call(body, d)
      assert.equal(r.status, status)
      assert.equal(r.json.code, code)
      assert.equal(r.cache, "no-store")
      assert.deepEqual([calls.token.length, calls.list.length], [0, 0])
    })
  }

  for (const key of ["companyId", "connection_id", "sourceMailboxKey", "email", "query", "Q", "queries", "search", "maxResults", "page-token", "messageId", "accessToken", "target"]) {
    it(`override « ${key} » → TARGET_OVERRIDE_FORBIDDEN`, async () => {
      const { d, calls } = setup({ over: NO_IO })
      const r = await call({ ...RUN, [key]: "x" }, d)
      assert.equal(r.json.code, "TARGET_OVERRIDE_FORBIDDEN")
      assert.deepEqual([calls.token.length, calls.list.length], [0, 0])
    })
  }

  const conns: Array<[string, GmailListDiagnosticConnection | null, number, string]> = [
    ["connexion absente", null, 404, "CONNECTION_NOT_FOUND"],
    ["connexion d'un autre tenant", { id: CONNECTION, companyId: "co-other", active: true }, 404, "CONNECTION_NOT_FOUND"],
    ["connexion inactive", { id: CONNECTION, companyId: COMPANY, active: false }, 409, "CONNECTION_INACTIVE"],
  ]
  for (const mode of [CHECK, RUN]) {
    for (const [label, row, status, code] of conns) {
      it(`${label} (${mode === CHECK ? "CHECK" : "RUN"}) → ${status} ${code}, zéro token / Gmail`, async () => {
        const { d, calls } = setup({ over: { loadConnection: async () => row, getValidAccessToken: bomb("token") } })
        const r = await call(mode, d)
        assert.equal(r.status, status)
        assert.equal(r.json.code, code)
        assert.deepEqual([calls.token.length, calls.list.length], [0, 0])
      })
    }
  }
})

describe("CHECK", () => {
  it("CHECK → gardes OK, connexion active, tokenCalled/gmailCalled false, zéro token / Gmail", async () => {
    const { d, calls } = setup({ over: { getValidAccessToken: bomb("getValidAccessToken") } })
    const r = await call(CHECK, d)
    assert.equal(r.status, 200, r.text)
    assert.deepEqual(r.json, { ok: true, harness: "targeted-staging-gmail-list-diagnostic", mode: "CHECK", tokenCalled: false, gmailCalled: false })
    assert.deepEqual(calls.load, [{ companyId: COMPANY, connectionId: CONNECTION }])
    assert.deepEqual([calls.token.length, calls.list.length], [0, 0])
  })
})

describe("RUN — uniquement messages.list sur les 4 requêtes fixes", () => {
  it("token pour exactement companyId + connectionId ; exactement A/B/C/D dans l'ordre ; maxResults borné ; sans pageToken", async () => {
    const { d, calls } = setup()
    const r = await call(RUN, d)
    assert.equal(r.status, 200, r.text)
    assert.deepEqual(calls.token, [{ companyId: COMPANY, connectionId: CONNECTION }])
    assert.deepEqual(calls.list.map((c) => c.query), EXPECTED_QUERIES)
    assert.deepEqual(GMAIL_LIST_DIAGNOSTIC_QUERIES.map((q) => q.query), EXPECTED_QUERIES)
    for (const c of calls.list) {
      assert.equal(c.token, TOKEN)
      assert.equal(c.maxResults, GMAIL_LIST_DIAGNOSTIC_MAX_RESULTS)
      assert.ok(c.maxResults <= 10)
      assert.equal(c.argCount, 3, "aucun pageToken transmis")
    }
  })

  it("synthèse par requête : returnedCount, resultSizeEstimate, hasNextPage, ≤ 5 IDs opaques ; rien d'autre", async () => {
    const { d } = setup({
      pages: {
        [EXPECTED_QUERIES[0]!]: {
          messages: Array.from({ length: 7 }, (_, i) => ({ id: `m${i}`, threadId: `THREAD-SECRET-${i}` })),
          resultSizeEstimate: 42,
          nextPageToken: PAGE_TOKEN,
        },
        [EXPECTED_QUERIES[1]!]: { messages: [{ id: "199a0penven01", threadId: "t" }], resultSizeEstimate: 1 },
        [EXPECTED_QUERIES[2]!]: { messages: [{ id: "199a0penven01" }, { id: "bad id with spaces" }], resultSizeEstimate: 2 },
        [EXPECTED_QUERIES[3]!]: { resultSizeEstimate: 0 },
      },
    })
    const r = await call(RUN, d)
    assert.equal(r.status, 200, r.text)
    assert.deepEqual(r.json.queries, {
      senderOnly: { returnedCount: 7, resultSizeEstimate: 42, hasNextPage: true, messageIds: ["m0", "m1", "m2", "m3", "m4"] },
      senderAfter: { returnedCount: 1, resultSizeEstimate: 1, hasNextPage: false, messageIds: ["199a0penven01"] },
      senderSubject: { returnedCount: 2, resultSizeEstimate: 2, hasNextPage: false, messageIds: ["199a0penven01"] },
      exactHarnessQuery: { returnedCount: 0, resultSizeEstimate: 0, hasNextPage: false, messageIds: [] },
    })
    assert.deepEqual(Object.keys(r.json).sort(), ["gmailCalled", "harness", "maxResults", "mode", "ok", "queries", "tokenCalled"])
    for (const s of [PAGE_TOKEN, "THREAD-SECRET", "bad id with spaces", TOKEN]) {
      assert.ok(!r.text.includes(s), s)
    }
  })

  it("getMessage / getAttachment / getProfile / listHistory jamais appelés (bombes du client complet)", async () => {
    const { d, calls } = setup()
    const r = await call(RUN, d)
    assert.equal(r.status, 200, r.text)
    assert.equal(calls.list.length, 4)
  })

  it("échec d'une requête (C) → GMAIL_LIST_FAILED fail-closed, failedQuery sûr, arrêt (D non appelée), aucun brut ni token", async () => {
    const { d, calls } = setup({
      pages: {
        [EXPECTED_QUERIES[2]!]: new Error(`HTTP 400 {"error":{"message":"Invalid query"}} Authorization: Bearer ${TOKEN}`),
      },
    })
    const r = await call(RUN, d)
    assert.equal(r.status, 502)
    assert.equal(r.json.ok, false)
    assert.equal(r.json.code, "GMAIL_LIST_FAILED")
    assert.equal(r.json.failedQuery, "senderSubject")
    assert.equal(r.json.providerCode, null)
    assert.deepEqual(Object.keys(r.json.queries as object), ["senderOnly", "senderAfter"])
    assert.equal(calls.list.length, 3)
    for (const s of [TOKEN, "Bearer", "Invalid query", "HTTP 400", '"error"']) {
      assert.ok(!r.text.includes(s), s)
    }
  })

  it("échec provider typé → providerCode sûr seul", async () => {
    const { d } = setup({
      pages: {
        [EXPECTED_QUERIES[0]!]: new GmailProviderError({ code: "GMAIL_RATE_LIMITED", message: `quota ${TOKEN}`, retryable: true, global: true }),
      },
    })
    const r = await call(RUN, d)
    assert.equal(r.json.failedQuery, "senderOnly")
    assert.equal(r.json.providerCode, "GMAIL_RATE_LIMITED")
    assert.ok(!r.text.includes(TOKEN) && !r.text.includes("quota"))
  })

  it("échec token (secrets) → GMAIL_TOKEN_UNAVAILABLE + code sûr, aucun messages.list", async () => {
    const { d, calls } = setup({
      over: {
        getValidAccessToken: async () => {
          throw new GmailProviderError({ code: "GMAIL_TOKEN_REFRESH_FAILED", message: `invalid_grant ${REFRESH}`, retryable: false, global: true })
        },
      },
    })
    const r = await call(RUN, d)
    assert.equal(r.status, 502)
    assert.equal(r.json.code, "GMAIL_TOKEN_UNAVAILABLE")
    assert.equal(r.json.providerCode, "GMAIL_TOKEN_REFRESH_FAILED")
    assert.equal(r.json.gmailCalled, false)
    assert.equal(calls.list.length, 0)
    assert.ok(!r.text.includes(REFRESH) && !r.text.includes("invalid_grant"))
  })

  it("summarizeListPage : réponses malformées → compteurs neutres, jamais d'exception", () => {
    for (const page of [undefined, null, 42, "x", { messages: "nope" }, { messages: [null, 3, {}], resultSizeEstimate: "9" }]) {
      const s = summarizeListPage(page)
      assert.equal(s.resultSizeEstimate, null)
      assert.equal(s.hasNextPage, false)
      assert.deepEqual(s.messageIds, [])
    }
  })
})

describe("source / route", () => {
  const src = readFileSync(path.join(ROOT, HANDLER_PATH), "utf8")
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")

  it("uniquement listMessages ; aucune autre API Gmail, ingestion, curseur, écriture, log ; requêtes figées", () => {
    assert.equal((code.match(/\.listMessages\(/g) ?? []).length, 1)
    assert.match(code, /gmail\.listMessages\(accessToken, entry\.query, GMAIL_LIST_DIAGNOSTIC_MAX_RESULTS\)/)
    for (const forbidden of [
      /getMessage/, /getAttachment/, /getProfile/, /listHistory/, /registerIncomingMessage/, /ingestion/i,
      /ScanCursor/, /cursorRepository/, /syncAcquisitionMailForCompany/, /nextPageToken\s*[,)]/,
      /\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\(/, /\$executeRaw|\$queryRaw|\$transaction/,
      /console\./, /while\s*\(/,
    ]) {
      assert.ok(!forbidden.test(code), String(forbidden))
    }
    assert.ok(Object.isFrozen(GMAIL_LIST_DIAGNOSTIC_QUERIES))
    assert.ok(GMAIL_LIST_DIAGNOSTIC_QUERIES.every((q) => Object.isFrozen(q)))
    assert.match(code, /new PrismaAcquisitionGmailConnectionClient\(\)\.getValidAccessToken\(lookup\)/)
  })

  it("route mince, POST uniquement", () => {
    const route = readFileSync(path.join(ROOT, ROUTE_PATH), "utf8")
    assert.match(route, /return handleTargetedStagingGmailListDiagnostic\(req\)/)
    assert.ok(!/export async function (GET|PUT|PATCH|DELETE)/.test(route))
  })
})
