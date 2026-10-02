/**
 * Harness identité OAuth Gmail (users/me/profile) — deps injectées : auth, env, DB connexion,
 * token, client Gmail COMPLET dont toutes les API hors getProfile sont des bombes. Aucun accès réel.
 */
process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test"

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import path from "node:path"
import {
  GMAIL_OAUTH_PROFILE_ALLOWED_VERCEL_PROJECT_ID,
  TARGETED_GMAIL_OAUTH_PROFILE_CHECK_CONFIRMATION,
  TARGETED_GMAIL_OAUTH_PROFILE_RUN_CONFIRMATION,
  handleTargetedStagingGmailOAuthProfile,
  type GmailOAuthProfileConnection,
  type GmailOAuthProfileSession,
  type TargetedGmailOAuthProfileHandlerDeps,
} from "@/lib/acquisition/connector/targeted-staging-gmail-oauth-profile.handler"
import type { GmailApiClient } from "@/lib/acquisition/connector/gmail-api.client"
import type { GmailProfileResponse } from "@/lib/acquisition/connector/gmail-api.types"
import { GmailProviderError } from "@/lib/acquisition/connector/gmail.errors"

const ROOT = path.resolve(__dirname, "../..")
const HANDLER_PATH = "src/lib/acquisition/connector/targeted-staging-gmail-oauth-profile.handler.ts"
const ROUTE_PATH = "src/app/api/acquisition/targeted-staging-gmail-oauth-profile/route.ts"

const COMPANY = "co-fict-oauth"
const CONNECTION = "conn-fict-oauth"
const TOKEN = "ya29.FICT-SECRET-ACCESS-TOKEN"
const REFRESH = "1//FICT-SECRET-REFRESH"
const PROFILE_EMAIL = "consultations@hylight.test"
const HISTORY_ID = "5013445"

const ENV = {
  VERCEL_ENV: "preview",
  VERCEL_PROJECT_ID: GMAIL_OAUTH_PROFILE_ALLOWED_VERCEL_PROJECT_ID,
  TARGETED_STAGING_GMAIL_OAUTH_PROFILE_ENABLED: "true",
  TARGETED_STAGING_GMAIL_SYNC_COMPANY_ID: COMPANY,
  TARGETED_STAGING_GMAIL_SYNC_CONNECTION_ID: CONNECTION,
}
const ADMIN: GmailOAuthProfileSession = { user: { id: "u1", role: "ADMIN", companyId: COMPANY } }
const CHECK = { confirmation: TARGETED_GMAIL_OAUTH_PROFILE_CHECK_CONFIRMATION }
const RUN = { confirmation: TARGETED_GMAIL_OAUTH_PROFILE_RUN_CONFIRMATION }

function bomb(name: string) {
  return async (): Promise<never> => {
    throw new Error(`${name} MUST NOT BE CALLED`)
  }
}

function setup(opts: {
  profile?: GmailProfileResponse | (() => Promise<GmailProfileResponse>)
  over?: Partial<TargetedGmailOAuthProfileHandlerDeps>
} = {}) {
  const calls = { load: [] as unknown[], token: [] as unknown[], profile: [] as string[] }
  const gmail: GmailApiClient = {
    async getProfile(token) {
      calls.profile.push(token)
      if (typeof opts.profile === "function") return opts.profile()
      return opts.profile ?? { emailAddress: PROFILE_EMAIL, historyId: HISTORY_ID }
    },
    listMessages: bomb("listMessages"),
    getMessage: bomb("getMessage"),
    getAttachment: bomb("getAttachment"),
    listHistory: bomb("listHistory"),
  }
  const d: TargetedGmailOAuthProfileHandlerDeps = {
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

async function call(body: unknown, d: TargetedGmailOAuthProfileHandlerDeps) {
  const res = await handleTargetedStagingGmailOAuthProfile(
    new Request("http://localhost/api/acquisition/targeted-staging-gmail-oauth-profile", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
    d
  )
  const text = await res.text()
  return { status: res.status, json: JSON.parse(text) as Record<string, unknown>, text, cache: res.headers.get("cache-control") }
}

const NO_IO: Partial<TargetedGmailOAuthProfileHandlerDeps> = {
  loadConnection: bomb("loadConnection"),
  getValidAccessToken: bomb("getValidAccessToken"),
}

describe("gardes Preview / project / flag / auth / rôle / tenant / cible / confirmation", () => {
  const cases: Array<[string, Partial<TargetedGmailOAuthProfileHandlerDeps>, unknown, number, string]> = [
    ["non Preview", { env: { ...ENV, VERCEL_ENV: "production" } }, RUN, 403, "HARNESS_SURFACE_FORBIDDEN"],
    ["VERCEL_ENV absent", { env: { ...ENV, VERCEL_ENV: undefined } }, RUN, 403, "HARNESS_SURFACE_FORBIDDEN"],
    ["mauvais project", { env: { ...ENV, VERCEL_PROJECT_ID: "prj_other" } }, RUN, 403, "HARNESS_SURFACE_FORBIDDEN"],
    ["flag absent (désactivé par défaut)", { env: { ...ENV, TARGETED_STAGING_GMAIL_OAUTH_PROFILE_ENABLED: undefined } }, RUN, 403, "HARNESS_DISABLED"],
    ["flag ≠ true", { env: { ...ENV, TARGETED_STAGING_GMAIL_OAUTH_PROFILE_ENABLED: "TRUE" } }, RUN, 403, "HARNESS_DISABLED"],
    ["non authentifié", { auth: async () => null }, RUN, 401, "UNAUTHORIZED"],
    ["auth lève", { auth: async () => { throw new Error(TOKEN) } }, RUN, 401, "UNAUTHORIZED"],
    ["rôle USER", { auth: async () => ({ user: { id: "u", role: "USER", companyId: COMPANY } }) }, RUN, 403, "FORBIDDEN"],
    ["tenant mismatch", { auth: async () => ({ user: { id: "u", role: "ADMIN", companyId: "co-other" } }) }, RUN, 403, "TENANT_MISMATCH"],
    ["session sans companyId", { auth: async () => ({ user: { id: "u", role: "SUPER_ADMIN", companyId: null } }) }, RUN, 403, "TENANT_MISMATCH"],
    ["cible company absente", { env: { ...ENV, TARGETED_STAGING_GMAIL_SYNC_COMPANY_ID: undefined } }, RUN, 403, "HARNESS_TARGET_UNSET"],
    ["cible connexion blanche", { env: { ...ENV, TARGETED_STAGING_GMAIL_SYNC_CONNECTION_ID: " " } }, RUN, 403, "HARNESS_TARGET_UNSET"],
    ["confirmation absente", {}, {}, 400, "CONFIRMATION_REQUIRED"],
    ["confirmation fausse", {}, { confirmation: `${TARGETED_GMAIL_OAUTH_PROFILE_RUN_CONFIRMATION} ` }, 400, "CONFIRMATION_REQUIRED"],
    ["confirmation d'un autre harness", {}, { confirmation: "RUN_TARGETED_STAGING_GMAIL_MESSAGE_INGESTION" }, 400, "CONFIRMATION_REQUIRED"],
    ["body invalide", {}, "{bad", 400, "INVALID_BODY"],
    ["body tableau", {}, [RUN], 400, "INVALID_BODY"],
    ["champ inconnu", {}, { ...RUN, verbose: true }, 400, "UNKNOWN_FIELD"],
  ]
  for (const [label, over, body, status, code] of cases) {
    it(`${label} → ${status} ${code}, aucun token ni Gmail`, async () => {
      const { d, calls } = setup({ over: { ...NO_IO, ...over } })
      const r = await call(body, d)
      assert.equal(r.status, status)
      assert.equal(r.json.code, code)
      assert.equal(r.cache, "no-store")
      assert.deepEqual([calls.token.length, calls.profile.length], [0, 0])
    })
  }

  for (const key of [
    "companyId", "company_id", "connectionId", "connection-id", "sourceMailboxKey", "mailboxKey",
    "email", "emailAddress", "email_address", "gmailAddress", "userId", "accessToken", "token", "TARGET",
  ]) {
    it(`override cible « ${key} » → TARGET_OVERRIDE_FORBIDDEN`, async () => {
      const { d, calls } = setup({ over: NO_IO })
      const r = await call({ ...RUN, [key]: "x" }, d)
      assert.equal(r.status, 400)
      assert.equal(r.json.code, "TARGET_OVERRIDE_FORBIDDEN")
      assert.deepEqual([calls.token.length, calls.profile.length], [0, 0])
    })
  }

  const conns: Array<[string, GmailOAuthProfileConnection | null, number, string]> = [
    ["connexion absente", null, 404, "CONNECTION_NOT_FOUND"],
    ["connexion d'un autre id", { id: "conn-other", companyId: COMPANY, active: true }, 404, "CONNECTION_NOT_FOUND"],
    ["connexion d'un autre tenant", { id: CONNECTION, companyId: "co-other", active: true }, 404, "CONNECTION_NOT_FOUND"],
    ["connexion inactive", { id: CONNECTION, companyId: COMPANY, active: false }, 409, "CONNECTION_INACTIVE"],
  ]
  for (const mode of [CHECK, RUN]) {
    for (const [label, row, status, code] of conns) {
      it(`${label} (${mode === CHECK ? "CHECK" : "RUN"}) → ${status} ${code}, aucun token ni Gmail`, async () => {
        const { d, calls } = setup({ over: { loadConnection: async () => row, getValidAccessToken: bomb("token") } })
        const r = await call(mode, d)
        assert.equal(r.status, status)
        assert.equal(r.json.code, code)
        assert.deepEqual([calls.token.length, calls.profile.length], [0, 0])
      })
    }
  }

  it("lecture connexion en erreur → CONNECTION_LOAD_FAILED sans fuite", async () => {
    const { d } = setup({ over: { loadConnection: async () => { throw new Error(`prisma ${REFRESH}`) }, getValidAccessToken: bomb("token") } })
    const r = await call(RUN, d)
    assert.equal(r.json.code, "CONNECTION_LOAD_FAILED")
    assert.ok(!r.text.includes(REFRESH) && !r.text.includes("prisma"))
  })
})

describe("CHECK — gardes uniquement", () => {
  it("CHECK valide → réponse exacte ; aucun getValidAccessToken, aucun appel Gmail", async () => {
    const { d, calls } = setup({ over: { getValidAccessToken: bomb("getValidAccessToken") } })
    const r = await call(CHECK, d)
    assert.equal(r.status, 200, r.text)
    assert.deepEqual(r.json, {
      ok: true,
      harness: "targeted-staging-gmail-oauth-profile",
      mode: "CHECK",
      gmailCalled: false,
      profileCalled: false,
    })
    assert.deepEqual(calls.load, [{ companyId: COMPANY, connectionId: CONNECTION }])
    assert.deepEqual([calls.token.length, calls.profile.length], [0, 0])
  })
})

describe("RUN — token normal puis UN seul getProfile", () => {
  it("token pour exactement companyId + connectionId cibles ; getProfile une fois avec ce token ; emailAddress retournée", async () => {
    const { d, calls } = setup()
    const r = await call(RUN, d)
    assert.equal(r.status, 200, r.text)
    assert.deepEqual(calls.token, [{ companyId: COMPANY, connectionId: CONNECTION }])
    assert.deepEqual(calls.profile, [TOKEN])
    assert.deepEqual(r.json, {
      ok: true,
      harness: "targeted-staging-gmail-oauth-profile",
      mode: "RUN",
      gmailCalled: true,
      profileCalled: true,
      emailAddress: PROFILE_EMAIL,
    })
  })

  it("aucune API messages / history / attachments (bombes du client complet) ; historyId non exposé", async () => {
    const { d } = setup()
    const r = await call(RUN, d)
    assert.equal(r.status, 200, r.text)
    assert.ok(!r.text.includes(HISTORY_ID))
    assert.ok(!("historyId" in r.json))
  })

  it("token jamais exposé (succès et erreurs)", async () => {
    const ok = await call(RUN, setup().d)
    assert.ok(!ok.text.includes(TOKEN) && !ok.text.includes("Bearer"))
    const fail = await call(RUN, setup({ profile: async () => { throw new Error(`401 Authorization: Bearer ${TOKEN}`) } }).d)
    assert.ok(!fail.text.includes(TOKEN) && !fail.text.includes("Bearer") && !fail.text.includes("401"))
  })

  it("échec token (GmailProviderError avec secrets) → GMAIL_TOKEN_UNAVAILABLE + code sûr, aucun getProfile", async () => {
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
    assert.equal(r.json.profileCalled, false)
    assert.ok(!r.text.includes(REFRESH) && !r.text.includes("invalid_grant"))
    assert.equal(calls.profile.length, 0)
  })

  it("token vide → GMAIL_TOKEN_UNAVAILABLE, aucun getProfile", async () => {
    const { d, calls } = setup({ over: { getValidAccessToken: async () => "" } })
    const r = await call(RUN, d)
    assert.equal(r.json.code, "GMAIL_TOKEN_UNAVAILABLE")
    assert.equal(calls.profile.length, 0)
  })

  it("échec getProfile → GMAIL_PROFILE_FAILED fail-closed, code provider sûr seul, un seul appel (aucun retry)", async () => {
    let n = 0
    for (const [err, code] of [
      [new GmailProviderError({ code: "GMAIL_UNAUTHORIZED", message: `token ${TOKEN} revoked`, retryable: false, global: true }), "GMAIL_UNAUTHORIZED"],
      [new Error(`raw provider body {"error":"x"} ${TOKEN}`), null],
    ] as const) {
      const { d } = setup({ profile: async () => { n++; throw err } })
      const r = await call(RUN, d)
      assert.equal(r.status, 502)
      assert.equal(r.json.code, "GMAIL_PROFILE_FAILED")
      assert.equal(r.json.providerCode, code)
      assert.equal(r.json.ok, false)
      assert.ok(!("emailAddress" in r.json))
      assert.ok(!r.text.includes(TOKEN) && !r.text.includes("revoked") && !r.text.includes('{"error"'))
    }
    assert.equal(n, 2)
  })

  it("profil sans adresse exploitable → PROFILE_EMAIL_MISSING, aucune valeur brute renvoyée", async () => {
    for (const profile of [{}, { emailAddress: "" }, { emailAddress: "   " }, { emailAddress: "not-an-email" }, { emailAddress: `${"a".repeat(330)}@x.test` }]) {
      const r = await call(RUN, setup({ profile }).d)
      assert.equal(r.status, 502)
      assert.equal(r.json.code, "PROFILE_EMAIL_MISSING")
      assert.ok(!("emailAddress" in r.json))
    }
  })

  it("champs supplémentaires de la réponse brute jamais exposés", async () => {
    const r = await call(RUN, setup({ profile: { emailAddress: PROFILE_EMAIL, historyId: HISTORY_ID, messagesTotal: 99, threadsTotal: 7 } as GmailProfileResponse }).d)
    assert.deepEqual(Object.keys(r.json).sort(), ["emailAddress", "gmailCalled", "harness", "mode", "ok", "profileCalled"])
  })
})

describe("source / route", () => {
  const src = readFileSync(path.join(ROOT, HANDLER_PATH), "utf8")
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")

  it("seul getProfile ; aucune API messages / history / attachments, aucune ingestion, aucun curseur, aucune écriture, aucun log", () => {
    assert.equal((code.match(/\.getProfile\(/g) ?? []).length, 1)
    for (const forbidden of [
      /listMessages/, /getMessage/, /getAttachment/, /listHistory/, /registerIncomingMessage/, /ingestion/i,
      /ScanCursor/, /cursorRepository/, /syncAcquisitionMailForCompany/,
      /\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\(/, /\$executeRaw|\$queryRaw|\$transaction/,
      /console\./, /while\s*\(/, /\bfor\s*\(/,
    ]) {
      assert.ok(!forbidden.test(code), String(forbidden))
    }
    assert.match(code, /deps\.getValidAccessToken \?\? defaultGetValidAccessToken/)
    assert.match(code, /new PrismaAcquisitionGmailConnectionClient\(\)\.getValidAccessToken\(lookup\)/)
    assert.match(code, /select: \{ id: true, companyId: true, active: true \}/)
  })

  it("route mince, POST uniquement", () => {
    const route = readFileSync(path.join(ROOT, ROUTE_PATH), "utf8")
    assert.match(route, /return handleTargetedStagingGmailOAuthProfile\(req\)/)
    assert.ok(!/export async function (GET|PUT|PATCH|DELETE)/.test(route))
  })
})
