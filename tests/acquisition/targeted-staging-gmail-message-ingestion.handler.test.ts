/**
 * Harness ingestion Gmail ciblée (Penven) — deps injectées : auth, env, DB connexion, token, Gmail,
 * identités partenaires, ingestion. Aucun accès réel. Mapping canonique + mapper RÉELS (purs).
 * Le client Gmail injecté est COMPLET : history / attachments / profile sont des bombes.
 */
process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test"

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import path from "node:path"
import {
  GMAIL_MESSAGE_INGESTION_ALLOWED_VERCEL_PROJECT_ID,
  TARGETED_GMAIL_MESSAGE_INGESTION_CHECK_CONFIRMATION,
  TARGETED_GMAIL_MESSAGE_INGESTION_RUN_CONFIRMATION,
  TARGET_EXPECTED_SUBJECT,
  TARGET_LOOKBACK_DAYS,
  TARGET_MAX_RESULTS,
  buildTargetedPenvenQuery,
  handleTargetedStagingGmailMessageIngestion,
  isExactTargetSubject,
  type GmailMessageIngestionConnection,
  type GmailMessageIngestionSession,
  type TargetedGmailMessageIngestionHandlerDeps,
} from "@/lib/acquisition/connector/targeted-staging-gmail-message-ingestion.handler"
import { buildAcquisitionGmailLookbackQuery } from "@/lib/acquisition/connector/gmail-mail-provider.adapter"
import type { GmailApiClient } from "@/lib/acquisition/connector/gmail-api.client"
import type { GmailMessageResource } from "@/lib/acquisition/connector/gmail-api.types"
import { GmailProviderError } from "@/lib/acquisition/connector/gmail.errors"
import type { AcquisitionIngestionPort } from "@/lib/acquisition/ports/acquisition-ingestion.port"
import type { RegisterIncomingMessageInput } from "@/lib/validations/acquisition"

const ROOT = path.resolve(__dirname, "../..")
const HANDLER_PATH = "src/lib/acquisition/connector/targeted-staging-gmail-message-ingestion.handler.ts"
const ROUTE_PATH = "src/app/api/acquisition/targeted-staging-gmail-message-ingestion/route.ts"

const COMPANY = "co-fict-ingest"
const CONNECTION = "conn-fict-ingest"
const TOKEN = "ya29.FICT-SECRET-ACCESS-TOKEN"
const REFRESH = "1//FICT-SECRET-REFRESH"
const BODY_DATA = "Qk9EWS1TRU5TSVRJVkUtUEVOVkVO"
const SNIPPET = "SNIPPET-SENSITIVE-PENVEN"

const ENV = {
  VERCEL_ENV: "preview",
  VERCEL_PROJECT_ID: GMAIL_MESSAGE_INGESTION_ALLOWED_VERCEL_PROJECT_ID,
  TARGETED_STAGING_GMAIL_MESSAGE_INGESTION_ENABLED: "true",
  TARGETED_STAGING_GMAIL_SYNC_COMPANY_ID: COMPANY,
  TARGETED_STAGING_GMAIL_SYNC_CONNECTION_ID: CONNECTION,
}
const ADMIN: GmailMessageIngestionSession = { user: { id: "u1", role: "ADMIN", companyId: COMPANY } }
const CHECK = { confirmation: TARGETED_GMAIL_MESSAGE_INGESTION_CHECK_CONFIRMATION }
const RUN = { confirmation: TARGETED_GMAIL_MESSAGE_INGESTION_RUN_CONFIRMATION }
const IDENTITIES = { domains: ["hylight.test"], emails: ["planning@hylight.test"] }

function gmailMessage(id: string, subject: string, over: Partial<GmailMessageResource> = {}): GmailMessageResource {
  return {
    id,
    threadId: `thread-${id}`,
    labelIds: ["INBOX"],
    snippet: SNIPPET,
    internalDate: "1790864640000",
    payload: {
      mimeType: "multipart/mixed",
      headers: [
        { name: "From", value: "Planning <planning@hylight.test>" },
        { name: "Subject", value: subject },
        { name: "Date", value: "Thu, 01 Oct 2026 16:24:00 +0200" },
        { name: "Authorization", value: `Bearer ${TOKEN}` },
      ],
      parts: [
        { partId: "0", mimeType: "text/plain", body: { size: 40, data: BODY_DATA } },
        {
          partId: "1",
          mimeType: "application/pdf",
          filename: "plan-penven.pdf",
          headers: [{ name: "Content-Disposition", value: 'attachment; filename="plan-penven.pdf"' }],
          body: { attachmentId: "ATT-PDF-RAW", size: 4096 },
        },
        {
          partId: "2",
          mimeType: "image/png",
          filename: "image006.png",
          headers: [
            { name: "Content-Disposition", value: 'inline; filename="image006.png"' },
            { name: "Content-ID", value: "<image006.png@01DC>" },
          ],
          body: { attachmentId: "ATT-INLINE-RAW", size: 1000 },
        },
      ],
    },
    ...over,
  }
}

function bomb(name: string) {
  return async (): Promise<never> => {
    throw new Error(`${name} MUST NOT BE CALLED`)
  }
}

type Calls = {
  load: unknown[]
  token: unknown[]
  list: Array<{ query: string; maxResults: number; pageToken?: string; argCount: number }>
  get: string[]
  identities: string[]
  register: RegisterIncomingMessageInput[]
}

function setup(opts: {
  listed?: string[]
  messages?: Record<string, GmailMessageResource>
  over?: Partial<TargetedGmailMessageIngestionHandlerDeps>
  registerResult?: Awaited<ReturnType<AcquisitionIngestionPort["registerIncomingMessage"]>>
  enabled?: boolean
} = {}) {
  const calls: Calls = { load: [], token: [], list: [], get: [], identities: [], register: [] }
  const listed = opts.listed ?? ["gm-1"]
  const messages = opts.messages ?? { "gm-1": gmailMessage("gm-1", TARGET_EXPECTED_SUBJECT) }
  const gmail: GmailApiClient = {
    async listMessages(token, query, maxResults, ...rest: unknown[]) {
      calls.list.push({ query, maxResults, pageToken: rest[0] as string | undefined, argCount: 3 + rest.length })
      assert.equal(token, TOKEN)
      return { messages: listed.map((id) => ({ id })), nextPageToken: "NEXT-PAGE-MUST-BE-IGNORED" }
    },
    async getMessage(token, id) {
      calls.get.push(id)
      assert.equal(token, TOKEN)
      const m = messages[id]
      if (!m) throw new GmailProviderError({ code: "GMAIL_MESSAGE_NOT_FOUND", message: `nf ${TOKEN}`, retryable: false, global: false })
      return m
    },
    listHistory: bomb("listHistory (History API)"),
    getAttachment: bomb("getAttachment"),
    getProfile: bomb("getProfile"),
  }
  const ingestion: AcquisitionIngestionPort = {
    isEnabled: () => opts.enabled ?? true,
    async registerIncomingMessage(input) {
      calls.register.push(input)
      return opts.registerResult ?? { created: true, outcome: "DRAFT_CREATED", messageId: "acqmsg-1", draftId: "draft-1" }
    },
  }
  const d: TargetedGmailMessageIngestionHandlerDeps = {
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
    listActiveIdentities: async (id) => {
      calls.identities.push(id)
      return IDENTITIES
    },
    ingestion,
    ...opts.over,
  }
  return { d, calls }
}

async function call(body: unknown, d: TargetedGmailMessageIngestionHandlerDeps) {
  const res = await handleTargetedStagingGmailMessageIngestion(
    new Request("http://localhost/api/acquisition/targeted-staging-gmail-message-ingestion", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
    d
  )
  const text = await res.text()
  return { status: res.status, json: JSON.parse(text) as Record<string, unknown>, text, cache: res.headers.get("cache-control") }
}

const NO_IO: Partial<TargetedGmailMessageIngestionHandlerDeps> = {
  loadConnection: bomb("loadConnection"),
  getValidAccessToken: bomb("getValidAccessToken"),
  listActiveIdentities: bomb("listActiveIdentities"),
}

describe("1–10. gardes — refus avant toute lecture, token, Gmail ou ingestion", () => {
  const cases: Array<[string, Partial<TargetedGmailMessageIngestionHandlerDeps>, unknown, number, string]> = [
    ["1. non Preview", { env: { ...ENV, VERCEL_ENV: "production" } }, RUN, 403, "HARNESS_SURFACE_FORBIDDEN"],
    ["1. VERCEL_ENV absent", { env: { ...ENV, VERCEL_ENV: undefined } }, RUN, 403, "HARNESS_SURFACE_FORBIDDEN"],
    ["2. mauvais project", { env: { ...ENV, VERCEL_PROJECT_ID: "prj_other" } }, RUN, 403, "HARNESS_SURFACE_FORBIDDEN"],
    ["3. flag off", { env: { ...ENV, TARGETED_STAGING_GMAIL_MESSAGE_INGESTION_ENABLED: undefined } }, RUN, 403, "HARNESS_DISABLED"],
    ["3. flag ≠ true", { env: { ...ENV, TARGETED_STAGING_GMAIL_MESSAGE_INGESTION_ENABLED: "TRUE" } }, RUN, 403, "HARNESS_DISABLED"],
    ["4. non authentifié", { auth: async () => null }, RUN, 401, "UNAUTHORIZED"],
    ["4. auth lève", { auth: async () => { throw new Error(TOKEN) } }, RUN, 401, "UNAUTHORIZED"],
    ["5. rôle USER", { auth: async () => ({ user: { id: "u", role: "USER", companyId: COMPANY } }) }, RUN, 403, "FORBIDDEN"],
    ["6. tenant mismatch", { auth: async () => ({ user: { id: "u", role: "ADMIN", companyId: "co-other" } }) }, RUN, 403, "TENANT_MISMATCH"],
    ["6. session sans companyId", { auth: async () => ({ user: { id: "u", role: "SUPER_ADMIN", companyId: null } }) }, RUN, 403, "TENANT_MISMATCH"],
    ["7. confirmation absente", {}, {}, 400, "CONFIRMATION_REQUIRED"],
    ["7. confirmation fausse", {}, { confirmation: `${TARGETED_GMAIL_MESSAGE_INGESTION_RUN_CONFIRMATION} ` }, 400, "CONFIRMATION_REQUIRED"],
    ["7. confirmation d'un autre harness", {}, { confirmation: "RUN_TARGETED_STAGING_GMAIL_SYNC" }, 400, "CONFIRMATION_REQUIRED"],
    ["7. body invalide", {}, "{bad", 400, "INVALID_BODY"],
    ["7. champ inconnu", {}, { ...RUN, dryRun: true }, 400, "UNKNOWN_FIELD"],
    ["cible env absente", { env: { ...ENV, TARGETED_STAGING_GMAIL_SYNC_CONNECTION_ID: undefined } }, RUN, 403, "HARNESS_TARGET_UNSET"],
  ]
  for (const [label, over, body, status, code] of cases) {
    it(`${label} → ${status} ${code}`, async () => {
      const { d, calls } = setup({ over: { ...NO_IO, ...over } })
      const r = await call(body, d)
      assert.equal(r.status, status)
      assert.equal(r.json.code, code)
      assert.equal(r.cache, "no-store")
      assert.deepEqual([calls.list.length, calls.get.length, calls.register.length], [0, 0, 0])
    })
  }

  for (const key of [
    "companyId", "company_id", "connectionId", "connection-id", "sourceMailboxKey", "mailboxKey",
    "query", "q", "QUERY", "search", "messageId", "message_id", "externalMessageId", "gmailMessageId",
    "subject", "SUBJECT", "draftId", "target", "maxResults", "max_results", "pageToken", "lookbackDays", "email",
  ]) {
    it(`8. override « ${key} » → TARGET_OVERRIDE_FORBIDDEN`, async () => {
      const { d } = setup({ over: NO_IO })
      const r = await call({ ...RUN, [key]: "x" }, d)
      assert.equal(r.status, 400)
      assert.equal(r.json.code, "TARGET_OVERRIDE_FORBIDDEN")
    })
  }

  const conns: Array<[string, GmailMessageIngestionConnection | null, number, string]> = [
    ["9. connexion inexistante", null, 404, "CONNECTION_NOT_FOUND"],
    ["9. connexion d'un autre id", { id: "conn-other", companyId: COMPANY, active: true }, 404, "CONNECTION_NOT_FOUND"],
    ["9. connexion d'un autre tenant", { id: CONNECTION, companyId: "co-other", active: true }, 404, "CONNECTION_NOT_FOUND"],
    ["10. connexion inactive", { id: CONNECTION, companyId: COMPANY, active: false }, 409, "CONNECTION_INACTIVE"],
  ]
  for (const mode of [CHECK, RUN]) {
    for (const [label, row, status, code] of conns) {
      it(`${label} (${mode === CHECK ? "CHECK" : "RUN"}) → ${status} ${code}, zéro token/Gmail/ingestion`, async () => {
        const { d, calls } = setup({
          over: { loadConnection: async () => row, getValidAccessToken: bomb("token"), listActiveIdentities: bomb("ids") },
        })
        const r = await call(mode, d)
        assert.equal(r.status, status)
        assert.equal(r.json.code, code)
        assert.deepEqual([calls.list.length, calls.get.length, calls.register.length], [0, 0, 0])
      })
    }
  }
})

describe("11/26. CHECK — zéro token, Gmail, ingestion, écriture ; strictement séparé du RUN", () => {
  it("CHECK valide → réponse exacte ; seule la connexion est lue", async () => {
    const { d, calls } = setup({
      over: { getValidAccessToken: bomb("token"), listActiveIdentities: bomb("identities") },
    })
    const r = await call(CHECK, d)
    assert.equal(r.status, 200, r.text)
    assert.deepEqual(r.json, {
      ok: true,
      harness: "targeted-staging-gmail-message-ingestion",
      mode: "CHECK",
      gmailCalled: false,
      ingestionCalled: false,
    })
    assert.deepEqual(calls.load, [{ companyId: COMPANY, connectionId: CONNECTION }])
    assert.deepEqual([calls.token.length, calls.list.length, calls.get.length, calls.register.length, calls.identities.length], [0, 0, 0, 0, 0])
  })
})

describe("12–16. requête Gmail : partenaire fail-closed, une page ≤ 10, aucun History / curseur", () => {
  it("12. aucune identité partenaire active → NO_ACTIVE_PARTNER_IDENTITIES, aucun token ni Gmail", async () => {
    for (const ids of [{ domains: [], emails: [] }, { domains: ["not a domain"], emails: ["nope"] }]) {
      const { d, calls } = setup({ over: { listActiveIdentities: async () => ids, getValidAccessToken: bomb("token") } })
      const r = await call(RUN, d)
      assert.equal(r.status, 409)
      assert.equal(r.json.code, "NO_ACTIVE_PARTNER_IDENTITIES")
      assert.deepEqual([calls.list.length, calls.register.length], [0, 0])
    }
    assert.deepEqual(buildTargetedPenvenQuery({ domains: [], emails: [] }), { ok: false, code: "NO_ACTIVE_PARTNER_IDENTITIES" })
  })

  const EXPECTED_SUBJECT_FILTER = "subject:Consultation"

  it("12. requête = base partenaire officielle (identique) + subject:Consultation", async () => {
    const { d, calls } = setup()
    await call(RUN, d)
    const base = buildAcquisitionGmailLookbackQuery(TARGET_LOOKBACK_DAYS, IDENTITIES)
    assert.ok(base.ok)
    assert.equal(calls.list[0]!.query, `${base.ok ? base.query : ""} ${EXPECTED_SUBJECT_FILTER}`)
    assert.equal(
      calls.list[0]!.query.replace(/^after:\d{4}\/\d{2}\/\d{2} /, "after:<date> "),
      `after:<date> (from:planning@hylight.test OR from:@hylight.test) ${EXPECTED_SUBJECT_FILTER}`
    )
    assert.deepEqual(calls.identities, [COMPANY])
  })

  it("12 (a/b/c). query : base partenaire intégrale + exactement subject:Consultation, jamais élargie", async () => {
    for (const identities of [
      IDENTITIES,
      { domains: ["gl-events.com", "lauralu.fr"], emails: [] },
      { domains: ["a.test", "b.test"], emails: [] },
      { domains: [], emails: ["x@c.test"] },
    ]) {
      const built = buildTargetedPenvenQuery(identities)
      const base = buildAcquisitionGmailLookbackQuery(7, identities)
      assert.ok(built.ok && base.ok)
      if (!built.ok || !base.ok) continue
      // (a) base partenaire / lookback 7 jours conservée intégralement, en préfixe.
      assert.ok(built.query.startsWith(`${base.query} `))
      assert.match(base.query, /^after:\d{4}\/\d{2}\/\d{2} \(from:/)
      // (b) exactement un filtre subject:, et c'est subject:Consultation.
      const tail = built.query.slice(base.query.length + 1)
      assert.equal(tail, EXPECTED_SUBJECT_FILTER)
      assert.equal((built.query.match(/subject:/g) ?? []).length, 1)
      assert.equal((built.query.match(/(^|\s)subject:Consultation(\s|$)/g) ?? []).length, 1)
      // Ni BISCUITERIE / PENVEN, ni phrase exacte, ni guillemets dans le filtre Gmail.
      assert.ok(!/BISCUITERIE|PENVEN/i.test(built.query))
      assert.ok(!built.query.includes(TARGET_EXPECTED_SUBJECT))
      assert.ok(!built.query.includes('"'))
      // (c) aucun élargissement : ni OR supplémentaire hors base partenaire, ni joker, ni in:anywhere.
      assert.ok(!/\bOR\b/.test(tail) && !tail.includes("{") && !tail.includes("*"))
      assert.ok(!/in:anywhere|in:spam|in:trash/i.test(built.query))
      // Les seuls OR sont ceux de la base partenaire officielle.
      assert.equal((built.query.match(/\bOR\b/g) ?? []).length, (base.query.match(/\bOR\b/g) ?? []).length)
    }
    assert.equal(TARGET_LOOKBACK_DAYS, 7)
    // Domaine expéditeur réel couvert par la base partenaire.
    const real = buildTargetedPenvenQuery({ domains: ["gl-events.com", "lauralu.fr"], emails: [] })
    assert.ok(real.ok && real.query.includes("from:@lauralu.fr") && real.query.includes("from:@gl-events.com"))
    // Fail-closed inchangé : pas d'identité → pas de requête du tout.
    assert.deepEqual(buildTargetedPenvenQuery({ domains: [], emails: [] }), { ok: false, code: "NO_ACTIVE_PARTNER_IDENTITIES" })

    // Bornage de la page et pagination non suivie, via un RUN réel du handler.
    const { d, calls } = setup()
    const r = await call(RUN, d)
    assert.equal(r.status, 200, r.text)
    assert.equal(calls.list.length, 1)
    assert.equal(calls.list[0]!.maxResults, 10)
    assert.equal(calls.list[0]!.pageToken, undefined)
    assert.equal(calls.list[0]!.argCount, 3)
    assert.ok(!calls.list.some((c) => c.pageToken === "NEXT-PAGE-MUST-BE-IGNORED"))
  })

  it("13/14. exactement un listMessages, maxResults = 10, sans pageToken ; nextPageToken ignoré", async () => {
    const { d, calls } = setup()
    await call(RUN, d)
    assert.equal(calls.list.length, 1)
    assert.equal(calls.list[0]!.maxResults, TARGET_MAX_RESULTS)
    assert.ok(TARGET_MAX_RESULTS <= 10)
    assert.equal(calls.list[0]!.pageToken, undefined)
    assert.equal(calls.list[0]!.argCount, 3)
  })

  it("13. liste > 10 ids (et doublons) → au plus 10 messages.get, dédupliqués", async () => {
    const listed = [...Array.from({ length: 15 }, (_, i) => `x${i}`), "x0", "x1"]
    const messages = Object.fromEntries(listed.map((id) => [id, gmailMessage(id, "Autre consultation")]))
    const { d, calls } = setup({ listed, messages })
    const r = await call(RUN, d)
    assert.equal(calls.get.length, 10)
    assert.equal(new Set(calls.get).size, 10)
    assert.equal(r.json.candidateCount, 10)
  })

  it("15. aucun History API / getAttachment / getProfile (bombes du client complet) sur un RUN complet", async () => {
    const { d } = setup()
    const r = await call(RUN, d)
    assert.equal(r.status, 200, r.text)
  })

  it("16. source : aucun curseur, aucune sync, aucun History, aucune pagination suivie", () => {
    const src = readFileSync(path.join(ROOT, HANDLER_PATH), "utf8")
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")
    for (const forbidden of [
      /acquisitionScanCursor/i, /ScanCursor/, /cursorRepository/, /getOrCreate/, /saveSuccessfulPage/, /recordFailure/,
      /syncAcquisitionMailForCompany/, /listHistory/, /getAttachment/, /getProfile/, /nextPageToken/,
      /listActiveAcquisitionGmailConnections/, /\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\(/,
      /\$executeRaw|\$queryRaw|\$transaction/, /console\./, /while\s*\(/,
    ]) {
      assert.ok(!forbidden.test(code), String(forbidden))
    }
    assert.equal((code.match(/\.listMessages\(/g) ?? []).length, 1)
    assert.match(code, /gmail\.listMessages\(accessToken, built\.query, TARGET_MAX_RESULTS\)/)
    assert.equal((code.match(/\.registerIncomingMessage\(/g) ?? []).length, 1)
  })
})

describe("17–21. correspondance exacte et ingestion normale", () => {
  it("17. 0 correspondance exacte (sujets voisins) → TARGET_MESSAGE_NOT_FOUND, aucune ingestion", async () => {
    const listed = ["a", "b", "c"]
    const messages = {
      a: gmailMessage("a", "TR: Consultation démontage_BISCUITERIE PENVEN_20/10 et 21/10"),
      b: gmailMessage("b", "Consultation montage_BISCUITERIE PENVEN_20/10 et 21/10"),
      c: gmailMessage("c", "Consultation démontage_BISCUITERIE PENVEN_22/10"),
    }
    const { d, calls } = setup({ listed, messages })
    const r = await call(RUN, d)
    assert.equal(r.status, 404)
    assert.equal(r.json.code, "TARGET_MESSAGE_NOT_FOUND")
    assert.equal(r.json.matchedCount, 0)
    assert.equal(r.json.candidateCount, 3)
    assert.equal(r.json.ingestionCalled, false)
    assert.deepEqual(calls.register, [])
  })

  it("17. liste Gmail vide → TARGET_MESSAGE_NOT_FOUND, aucune ingestion", async () => {
    const { d, calls } = setup({ listed: [], messages: {} })
    const r = await call(RUN, d)
    assert.equal(r.json.code, "TARGET_MESSAGE_NOT_FOUND")
    assert.deepEqual([calls.get.length, calls.register.length], [0, 0])
  })

  it("18. > 1 correspondance exacte → TARGET_MESSAGE_AMBIGUOUS, aucune ingestion", async () => {
    const listed = ["a", "b"]
    const messages = {
      a: gmailMessage("a", TARGET_EXPECTED_SUBJECT),
      b: gmailMessage("b", "consultation DEMONTAGE_biscuiterie penven_20/10   et 21/10"),
    }
    const { d, calls } = setup({ listed, messages })
    const r = await call(RUN, d)
    assert.equal(r.status, 409)
    assert.equal(r.json.code, "TARGET_MESSAGE_AMBIGUOUS")
    assert.equal(r.json.matchedCount, 2)
    assert.deepEqual(calls.register, [])
  })

  it("normalisation exacte : accents / casse / espaces seulement", () => {
    for (const s of [
      TARGET_EXPECTED_SUBJECT,
      "consultation demontage_biscuiterie penven_20/10 et 21/10",
      "  CONSULTATION  DÉMONTAGE_BISCUITERIE PENVEN_20/10 ET 21/10 ",
    ]) {
      assert.equal(isExactTargetSubject(s), true, s)
    }
    for (const s of [
      "RE: Consultation démontage_BISCUITERIE PENVEN_20/10 et 21/10",
      "Consultation démontage BISCUITERIE PENVEN 20/10 et 21/10",
      "Consultation démontage_BISCUITERIE PENVEN_20/10",
      "BISCUITERIE PENVEN",
      "",
      null,
    ]) {
      assert.equal(isExactTargetSubject(s), false, String(s))
    }
  })

  it("19/20. exactement 1 → registerIncomingMessage une seule fois, entrée = mapper normal, sourceMailboxKey = connectionId", async () => {
    const listed = ["noise", "gm-1"]
    const messages = { noise: gmailMessage("noise", "Autre consultation"), "gm-1": gmailMessage("gm-1", TARGET_EXPECTED_SUBJECT) }
    const { d, calls } = setup({ listed, messages })
    const r = await call(RUN, d)
    assert.equal(r.status, 200, r.text)
    assert.equal(calls.register.length, 1)
    const input = calls.register[0]!
    assert.equal(input.companyId, COMPANY)
    assert.equal(input.source, "GMAIL")
    assert.equal(input.sourceMailboxKey, CONNECTION)
    assert.equal(input.externalMessageId, "gm-1")
    assert.equal(input.subject, TARGET_EXPECTED_SUBJECT)
    assert.equal(input.senderEmail, "Planning <planning@hylight.test>")
    // Parser MIME normal : PDF conservé, image inline embarquée exclue.
    assert.deepEqual((input.attachments ?? []).map((a) => a.filename), ["plan-penven.pdf"])
    assert.equal((input.rawMetadata as Record<string, unknown>).acquisitionGmailConnectionId, CONNECTION)
    assert.deepEqual(calls.token, [{ companyId: COMPANY, connectionId: CONNECTION }])
    assert.deepEqual(r.json, {
      ok: true,
      harness: "targeted-staging-gmail-message-ingestion",
      mode: "RUN",
      gmailCalled: true,
      ingestionCalled: true,
      candidateCount: 2,
      matchedCount: 1,
      outcome: "DRAFT_CREATED",
      created: true,
      messageId: "acqmsg-1",
      draftId: "draft-1",
      rejectionCode: null,
      attachmentCount: 1,
    })
  })

  it("21. anti-doublon normal préservé : résultat created:false relayé tel quel, aucune 2e tentative", async () => {
    const { d, calls } = setup({
      registerResult: { created: false, outcome: "DRAFT_CREATED", messageId: "acqmsg-existing", draftId: "draft-existing" },
    })
    const r = await call(RUN, d)
    assert.equal(calls.register.length, 1)
    assert.equal(r.json.created, false)
    assert.equal(r.json.messageId, "acqmsg-existing")
  })

  it("21. rejet normal (expéditeur non admissible) relayé avec son code, sans contournement", async () => {
    const { d, calls } = setup({
      registerResult: { created: true, outcome: "REJECTED", messageId: "acqmsg-r", draftId: null, errorCode: "SENDER_NOT_ELIGIBLE" },
    })
    const r = await call(RUN, d)
    assert.equal(calls.register.length, 1)
    assert.equal(r.json.outcome, "REJECTED")
    assert.equal(r.json.draftId, null)
    assert.equal(r.json.rejectionCode, "SENDER_NOT_ELIGIBLE")
  })

  it("ingestion désactivée (flags normaux) → INGESTION_DISABLED, aucun token ni Gmail", async () => {
    const { d, calls } = setup({ enabled: false, over: { getValidAccessToken: bomb("token") } })
    const r = await call(RUN, d)
    assert.equal(r.status, 409)
    assert.equal(r.json.code, "INGESTION_DISABLED")
    assert.deepEqual([calls.list.length, calls.register.length], [0, 0])
  })
})

describe("22–24. erreurs sûres, aucune donnée sensible", () => {
  it("22. échec token (message contenant secrets) → GMAIL_TOKEN_UNAVAILABLE + code sûr, aucun Gmail", async () => {
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
    assert.ok(!r.text.includes(REFRESH) && !r.text.includes("invalid_grant"))
    assert.equal(calls.list.length, 0)
  })

  it("22. échec listMessages / getMessage → codes sûrs, aucune ingestion, aucune fuite", async () => {
    const listFail = setup({
      over: {
        gmail: {
          listMessages: async () => {
            throw new Error(`fetch failed Bearer ${TOKEN}`)
          },
          getMessage: bomb("get"),
        },
      },
    })
    const r1 = await call(RUN, listFail.d)
    assert.equal(r1.json.code, "GMAIL_LIST_FAILED")
    assert.equal(r1.json.providerCode, null)
    assert.ok(!r1.text.includes(TOKEN) && !r1.text.includes("Bearer"))

    const getFail = setup({ listed: ["missing"], messages: {} })
    const r2 = await call(RUN, getFail.d)
    assert.equal(r2.json.code, "GMAIL_MESSAGE_FETCH_FAILED")
    assert.equal(r2.json.providerCode, "GMAIL_MESSAGE_NOT_FOUND")
    assert.ok(!r2.text.includes(TOKEN))
    assert.deepEqual(getFail.calls.register, [])

    const mismatch = setup({ listed: ["gm-1"], messages: { "gm-1": gmailMessage("other-id", TARGET_EXPECTED_SUBJECT) } })
    const r3 = await call(RUN, mismatch.d)
    assert.equal(r3.json.code, "GMAIL_MESSAGE_IDENTITY_MISMATCH")
    assert.deepEqual(mismatch.calls.register, [])
  })

  it("23. erreur ingestion (message Prisma) → INGESTION_FAILED, code seul, aucun retry", async () => {
    let n = 0
    const { d } = setup({
      over: {
        ingestion: {
          isEnabled: () => true,
          registerIncomingMessage: async () => {
            n++
            throw new Error(`PrismaClientKnownRequestError P2002 ${TOKEN}`)
          },
        },
      },
    })
    const r = await call(RUN, d)
    assert.equal(r.status, 500)
    assert.equal(r.json.code, "INGESTION_FAILED")
    assert.equal(n, 1)
    assert.ok(!r.text.includes("Prisma") && !r.text.includes(TOKEN))
  })

  it("24. réponse RUN : aucun token, corps, snippet, rawMetadata, PJ, attachmentId, header sensible", async () => {
    const { d } = setup()
    const r = await call(RUN, d)
    for (const s of [
      TOKEN, REFRESH, BODY_DATA, SNIPPET, "Bearer", "Authorization", "rawMetadata", "normalizedText",
      "ATT-PDF-RAW", "ATT-INLINE-RAW", "plan-penven.pdf", "storagePublicId", "hylight.test", "thread-gm-1",
      TARGET_EXPECTED_SUBJECT, "subject",
    ]) {
      assert.ok(!r.text.includes(s), s)
    }
  })
})

describe("25. route", () => {
  it("route mince, POST uniquement", () => {
    const route = readFileSync(path.join(ROOT, ROUTE_PATH), "utf8")
    assert.match(route, /return handleTargetedStagingGmailMessageIngestion\(req\)/)
    assert.ok(!/export async function (GET|PUT|PATCH|DELETE)/.test(route))
  })
})

describe("présélection subject:Consultation — (d/e/f/g) post-fetch exact toujours autorité finale", () => {
  const REAL_IDENTITIES = { domains: ["gl-events.com", "lauralu.fr"], emails: [] }
  function lauralu(id: string, subject: string) {
    const m = gmailMessage(id, subject)
    m.payload!.headers = m.payload!.headers!.map((h) =>
      h.name === "From" ? { name: "From", value: "Jean-Laurent Cazala <jeanlaurentcazala@lauralu.fr>" } : h
    )
    return m
  }
  const NEAR_MISSES: Record<string, string> = {
    tr: "TR: Consultation démontage_BISCUITERIE PENVEN_20/10 et 21/10",
    re: "RE: Consultation démontage_BISCUITERIE PENVEN_20/10 et 21/10",
    suffix: "Consultation démontage_BISCUITERIE PENVEN_20/10 et 21/10 - modifié",
    other: "Consultation démontage_BISCUITERIE PENVEN_27/10 et 28/10",
    spaced: "Consultation démontage BISCUITERIE PENVEN 20/10 et 21/10",
  }

  it("(e/f) Gmail renvoie uniquement des faux candidats → TARGET_MESSAGE_NOT_FOUND, aucune ingestion", async () => {
    const listed = Object.keys(NEAR_MISSES)
    const messages = Object.fromEntries(listed.map((id) => [id, lauralu(id, NEAR_MISSES[id]!)]))
    const { d, calls } = setup({ listed, messages, over: { listActiveIdentities: async () => REAL_IDENTITIES } })
    const r = await call(RUN, d)
    assert.equal(r.status, 404)
    assert.equal(r.json.code, "TARGET_MESSAGE_NOT_FOUND")
    assert.equal(r.json.candidateCount, 5)
    assert.equal(r.json.matchedCount, 0)
    assert.deepEqual(calls.register, [])
  })

  it("(d/f) faux candidats + 1 exact (expéditeur lauralu.fr) → ingestion exactement 1 fois, sur le seul exact", async () => {
    const listed = [...Object.keys(NEAR_MISSES), "exact"]
    const messages = {
      ...Object.fromEntries(Object.keys(NEAR_MISSES).map((id) => [id, lauralu(id, NEAR_MISSES[id]!)])),
      exact: lauralu("exact", TARGET_EXPECTED_SUBJECT),
    }
    const { d, calls } = setup({ listed, messages, over: { listActiveIdentities: async () => REAL_IDENTITIES } })
    const r = await call(RUN, d)
    assert.equal(r.status, 200, r.text)
    assert.equal(r.json.candidateCount, 6)
    assert.equal(r.json.matchedCount, 1)
    assert.equal(calls.register.length, 1)
    assert.equal(calls.register[0]!.externalMessageId, "exact")
    assert.equal(calls.register[0]!.sourceMailboxKey, CONNECTION)
    assert.match(calls.list[0]!.query, /^after:\d{4}\/\d{2}\/\d{2} \(from:@gl-events\.com OR from:@lauralu\.fr\) subject:Consultation$/)
  })

  it("(f) deux exacts (dont variante casse / accents / espaces) → TARGET_MESSAGE_AMBIGUOUS, aucune ingestion", async () => {
    const messages = {
      a: lauralu("a", TARGET_EXPECTED_SUBJECT),
      b: lauralu("b", "CONSULTATION DEMONTAGE_BISCUITERIE  PENVEN_20/10 ET 21/10"),
    }
    const { d, calls } = setup({ listed: ["a", "b"], messages, over: { listActiveIdentities: async () => REAL_IDENTITIES } })
    const r = await call(RUN, d)
    assert.equal(r.json.code, "TARGET_MESSAGE_AMBIGUOUS")
    assert.deepEqual(calls.register, [])
  })

  it("(g) source : un seul subject:Consultation, aucune pagination / curseur / History / retry introduits", () => {
    const src = readFileSync(path.join(ROOT, HANDLER_PATH), "utf8")
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")
    assert.match(code, /export const TARGET_SUBJECT_QUERY_TERM = "Consultation"/)
    assert.match(code, /subject:\$\{escapeGmailQueryTerm\(TARGET_SUBJECT_QUERY_TERM\)\}/)
    // Opérateur Gmail : un seul filtre interpolé ; aucun subject:<littéral> (hors annotations TS « subject: unknown »).
    assert.equal((code.match(/subject:\$\{/g) ?? []).length, 1)
    assert.ok(!/subject:["A-Za-z]/.test(code))
    assert.ok(!/TARGET_SUBJECT_QUERY_TERMS|TARGET_SUBJECT_QUERY_PHRASE|in:anywhere/.test(code))
    assert.match(code, /if \(isExactTargetSubject\(canonical\.subject\)\) exact\.push\(canonical\)/)
    for (const forbidden of [/ScanCursor/, /cursorRepository/, /listHistory/, /nextPageToken/, /while\s*\(/, /retry/i]) {
      assert.ok(!forbidden.test(code), String(forbidden))
    }
    // « pageToken » n'apparaît que comme clé de body INTERDITE (garde), jamais transmis à Gmail.
    assert.deepEqual(code.match(/pageToken/g), ["pageToken"])
    assert.match(code, /"pageToken",/)
    assert.equal((code.match(/\.listMessages\(/g) ?? []).length, 1)
    assert.match(code, /gmail\.listMessages\(accessToken, built\.query, TARGET_MAX_RESULTS\)/)
  })
})
