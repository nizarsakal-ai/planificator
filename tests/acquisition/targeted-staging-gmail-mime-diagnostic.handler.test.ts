/**
 * Harness diagnostic MIME Gmail ciblé — toutes les deps injectées (auth, env, DB, OAuth, Gmail).
 * Aucun accès réel DB / Gmail / OAuth : les deps non attendues sont des « bombes » qui lèvent.
 */
process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test"

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import path from "node:path"
import {
  GMAIL_MIME_DIAGNOSTIC_ALLOWED_VERCEL_PROJECT_ID,
  TARGETED_GMAIL_MIME_DIAGNOSTIC_CHECK_CONFIRMATION,
  TARGETED_GMAIL_MIME_DIAGNOSTIC_RUN_CONFIRMATION,
  extractImageMimeParts,
  handleTargetedStagingGmailMimeDiagnostic,
  type GmailMimeDiagnosticMessageTarget,
  type GmailMimeDiagnosticSession,
  type TargetedGmailMimeDiagnosticHandlerDeps,
} from "@/lib/acquisition/connector/targeted-staging-gmail-mime-diagnostic.handler"
import type { GmailMessageResource } from "@/lib/acquisition/connector/gmail-api.types"
import { GmailProviderError } from "@/lib/acquisition/connector/gmail.errors"

const ROOT = path.resolve(__dirname, "../..")
const HANDLER_PATH = "src/lib/acquisition/connector/targeted-staging-gmail-mime-diagnostic.handler.ts"
const ROUTE_PATH = "src/app/api/acquisition/targeted-staging-gmail-mime-diagnostic/route.ts"

const COMPANY = "co-fict-mime"
const MSG = "acqmsg-fict-mime"
const EXTERNAL = "gmail-fict-ext-1"
const MAILBOX = "conn-fict-mailbox"
const TOKEN = "ya29.FICT-SECRET-ACCESS-TOKEN"
const ATTACHMENT_ID = "ANGjdJ-FICT-RAW-ATTACHMENT-ID"
const BODY_DATA = "iVBORw0KGgoFICTBASE64DATA"

const ENV = {
  VERCEL_ENV: "preview",
  VERCEL_PROJECT_ID: GMAIL_MIME_DIAGNOSTIC_ALLOWED_VERCEL_PROJECT_ID,
  TARGETED_STAGING_GMAIL_MIME_DIAGNOSTIC_ENABLED: "true",
  TARGETED_STAGING_GMAIL_MIME_DIAGNOSTIC_COMPANY_ID: COMPANY,
  TARGETED_STAGING_GMAIL_MIME_DIAGNOSTIC_MESSAGE_ID: MSG,
}

const ADMIN: GmailMimeDiagnosticSession = { user: { id: "u1", role: "ADMIN", companyId: COMPANY } }

function target(over: Partial<GmailMimeDiagnosticMessageTarget> = {}): GmailMimeDiagnosticMessageTarget {
  return { id: MSG, companyId: COMPANY, externalMessageId: EXTERNAL, sourceMailboxKey: MAILBOX, ...over }
}

/** Message Gmail fictif : images inline/attachées imbriquées + parts non image + champs sensibles. */
function gmailMessage(): GmailMessageResource {
  return {
    id: EXTERNAL,
    threadId: "thread-fict",
    snippet: "SNIPPET-SENSITIVE",
    payload: {
      partId: "",
      mimeType: "multipart/mixed",
      filename: "",
      headers: [
        { name: "Subject", value: "SUBJECT-SENSITIVE" },
        { name: "From", value: "sender-sensitive@example.test" },
        { name: "To", value: "rcpt-sensitive@example.test" },
      ],
      body: { size: 0 },
      parts: [
        {
          partId: "0",
          mimeType: "multipart/related",
          filename: "",
          headers: [{ name: "Content-Type", value: "multipart/related" }],
          body: { size: 0 },
          parts: [
            {
              partId: "0.0",
              mimeType: "text/html",
              filename: "",
              headers: [{ name: "Content-Type", value: "text/html" }],
              body: { size: 120, data: "PGh0bWw+Qk9EWS1TRU5TSVRJVkU8L2h0bWw+" },
            },
            {
              partId: "0.1",
              mimeType: "image/png",
              filename: "image006.png",
              headers: [
                { name: "content-disposition", value: 'inline; filename="image006.png"' },
                { name: "CONTENT-ID", value: "<image006.png@01DAFICT>" },
                { name: "X-Other-Header", value: "OTHER-HEADER-SENSITIVE" },
              ],
              body: { size: 4321, attachmentId: ATTACHMENT_ID, data: BODY_DATA },
            },
          ],
        },
        {
          partId: "1",
          mimeType: "IMAGE/JPEG",
          filename: "photo-chantier.jpg",
          headers: [{ name: "Content-Disposition", value: 'attachment; filename="photo-chantier.jpg"' }],
          body: { size: 98765, attachmentId: ATTACHMENT_ID },
        },
        {
          partId: "2",
          mimeType: "application/pdf",
          filename: "plan.pdf",
          headers: [{ name: "Content-Disposition", value: "attachment" }],
          body: { size: 5000, attachmentId: ATTACHMENT_ID },
        },
        {
          partId: "3",
          mimeType: "image/gif",
          filename: "   ",
          headers: [],
          body: { size: 10, data: BODY_DATA },
        },
      ],
    },
  }
}

type Calls = { load: unknown[][]; token: unknown[][]; gmail: unknown[][] }

function bomb(name: string) {
  return async (): Promise<never> => {
    throw new Error(`${name} MUST NOT BE CALLED`)
  }
}

function deps(over: Partial<TargetedGmailMimeDiagnosticHandlerDeps> = {}) {
  const calls: Calls = { load: [], token: [], gmail: [] }
  const d: TargetedGmailMimeDiagnosticHandlerDeps = {
    auth: async () => ADMIN,
    env: { ...ENV },
    loadMessageTarget: async (...args) => {
      calls.load.push(args)
      return target()
    },
    getValidAccessToken: async (...args) => {
      calls.token.push(args)
      return TOKEN
    },
    getMessage: async (...args) => {
      calls.gmail.push(args)
      return gmailMessage()
    },
    ...over,
  }
  return { d, calls }
}

function req(body: unknown): Request {
  return new Request("http://localhost/api/acquisition/targeted-staging-gmail-mime-diagnostic", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  })
}

async function call(body: unknown, d: TargetedGmailMimeDiagnosticHandlerDeps) {
  const res = await handleTargetedStagingGmailMimeDiagnostic(req(body), d)
  const text = await res.text()
  return { status: res.status, json: JSON.parse(text) as Record<string, unknown>, text }
}

const CHECK = { confirmation: TARGETED_GMAIL_MIME_DIAGNOSTIC_CHECK_CONFIRMATION }
const RUN = { confirmation: TARGETED_GMAIL_MIME_DIAGNOSTIC_RUN_CONFIRMATION }

/** Refus : aucune lecture DB, aucun token, aucun Gmail (deps = bombes). */
const NO_IO = {
  loadMessageTarget: bomb("loadMessageTarget"),
  getValidAccessToken: bomb("getValidAccessToken"),
  getMessage: bomb("getMessage"),
}

describe("garde-fous pré-DB (A–I) — aucune lecture DB, aucun token, aucun Gmail", () => {
  const cases: Array<[string, Partial<TargetedGmailMimeDiagnosticHandlerDeps>, unknown, number, string]> = [
    ["A. VERCEL_ENV production", { env: { ...ENV, VERCEL_ENV: "production" } }, RUN, 403, "HARNESS_SURFACE_FORBIDDEN"],
    ["A. VERCEL_ENV absent", { env: { ...ENV, VERCEL_ENV: undefined } }, RUN, 403, "HARNESS_SURFACE_FORBIDDEN"],
    ["B. mauvais VERCEL_PROJECT_ID", { env: { ...ENV, VERCEL_PROJECT_ID: "prj_other" } }, RUN, 403, "HARNESS_SURFACE_FORBIDDEN"],
    ["C. flag absent", { env: { ...ENV, TARGETED_STAGING_GMAIL_MIME_DIAGNOSTIC_ENABLED: undefined } }, RUN, 403, "HARNESS_DISABLED"],
    ["C. flag ≠ \"true\"", { env: { ...ENV, TARGETED_STAGING_GMAIL_MIME_DIAGNOSTIC_ENABLED: "TRUE" } }, RUN, 403, "HARNESS_DISABLED"],
    ["D. non authentifié", { auth: async () => null }, RUN, 401, "UNAUTHORIZED"],
    ["E. rôle USER", { auth: async () => ({ user: { id: "u2", role: "USER", companyId: COMPANY } }) }, RUN, 403, "FORBIDDEN"],
    ["F. confirmation absente", {}, {}, 400, "CONFIRMATION_REQUIRED"],
    ["F. confirmation fausse", {}, { confirmation: "RUN_TARGETED_STAGING_GMAIL_MIME_DIAGNOSTIC " }, 400, "CONFIRMATION_REQUIRED"],
    ["F. confirmation d'un autre harness", {}, { confirmation: "RUN_TARGETED_ATTACHMENT_NOT_READY_TEST" }, 400, "CONFIRMATION_REQUIRED"],
    ["F. body JSON invalide", {}, "{not json", 400, "INVALID_BODY"],
    ["F. body tableau", {}, [RUN], 400, "INVALID_BODY"],
    ["F. champ inconnu", {}, { ...RUN, mode: "RUN" }, 400, "UNKNOWN_FIELD"],
    ["H. tenant mismatch", { auth: async () => ({ user: { id: "u1", role: "ADMIN", companyId: "co-other" } }) }, RUN, 403, "TENANT_MISMATCH"],
    ["H. session sans companyId", { auth: async () => ({ user: { id: "u1", role: "SUPER_ADMIN", companyId: null } }) }, RUN, 403, "TENANT_MISMATCH"],
    ["I. company env absente", { env: { ...ENV, TARGETED_STAGING_GMAIL_MIME_DIAGNOSTIC_COMPANY_ID: undefined } }, RUN, 403, "HARNESS_TARGET_UNSET"],
    ["I. message env blanc", { env: { ...ENV, TARGETED_STAGING_GMAIL_MIME_DIAGNOSTIC_MESSAGE_ID: "  " } }, RUN, 403, "HARNESS_TARGET_UNSET"],
  ]
  for (const [label, over, body, status, code] of cases) {
    it(`${label} → ${status} ${code}`, async () => {
      const { d } = deps({ ...NO_IO, ...over })
      const r = await call(body, d)
      assert.equal(r.status, status)
      assert.equal(r.json.ok, false)
      assert.equal(r.json.code, code)
    })
  }

  const overrideKeys = [
    "companyId", "company_id", "COMPANY_ID",
    "messageId", "message_id", "acquisitionMessageId", "acquisition_message_id",
    "externalMessageId", "external_message_id", "gmailMessageId",
    "connectionId", "connection_id",
    "sourceMailboxKey", "source_mailbox_key", "mailboxKey",
    "draftId", "draft_id",
    "attachmentId", "attachment_id", "attachment-id",
    "target",
  ]
  for (const key of overrideKeys) {
    it(`G. override « ${key} » dans le body (même avec confirmation valide) → TARGET_OVERRIDE_FORBIDDEN`, async () => {
      const { d } = deps(NO_IO)
      const r = await call({ ...RUN, [key]: "x" }, d)
      assert.equal(r.status, 400)
      assert.equal(r.json.code, "TARGET_OVERRIDE_FORBIDDEN")
    })
  }

  it("SUPER_ADMIN du tenant cible → autorisé (CHECK)", async () => {
    const { d } = deps({
      auth: async () => ({ user: { id: "u3", role: "SUPER_ADMIN", companyId: COMPANY } }),
      getValidAccessToken: bomb("getValidAccessToken"),
      getMessage: bomb("getMessage"),
    })
    const r = await call(CHECK, d)
    assert.equal(r.status, 200, r.text)
  })
})

describe("cible AcquisitionMessage (J–L) — fail-closed, aucun token, aucun Gmail", () => {
  const cases: Array<[string, GmailMimeDiagnosticMessageTarget | null, number, string]> = [
    ["J. AcquisitionMessage absent", null, 404, "MESSAGE_NOT_FOUND"],
    ["J. id retourné ≠ cible", target({ id: "acqmsg-other" }), 404, "MESSAGE_NOT_FOUND"],
    ["J. companyId retourné ≠ cible", target({ companyId: "co-other" }), 404, "MESSAGE_NOT_FOUND"],
    ["K. externalMessageId vide", target({ externalMessageId: "" }), 409, "EXTERNAL_MESSAGE_ID_MISSING"],
    ["K. externalMessageId null", target({ externalMessageId: null }), 409, "EXTERNAL_MESSAGE_ID_MISSING"],
    ["L. sourceMailboxKey vide (défaut schéma)", target({ sourceMailboxKey: "" }), 409, "SOURCE_MAILBOX_KEY_MISSING"],
    ["L. sourceMailboxKey blanc", target({ sourceMailboxKey: "   " }), 409, "SOURCE_MAILBOX_KEY_MISSING"],
  ]
  for (const mode of [CHECK, RUN]) {
    for (const [label, row, status, code] of cases) {
      it(`${label} (${mode === CHECK ? "CHECK" : "RUN"}) → ${status} ${code}`, async () => {
        const loads: unknown[][] = []
        const { d } = deps({
          loadMessageTarget: async (...args) => {
            loads.push(args)
            return row
          },
          getValidAccessToken: bomb("getValidAccessToken"),
          getMessage: bomb("getMessage"),
        })
        const r = await call(mode, d)
        assert.equal(r.status, status)
        assert.equal(r.json.code, code)
        assert.deepEqual(loads, [[COMPANY, MSG]])
      })
    }
  }

  it("lecture DB en erreur → MESSAGE_LOAD_FAILED, aucun token", async () => {
    const { d } = deps({
      loadMessageTarget: async () => {
        throw new Error("db down")
      },
      getValidAccessToken: bomb("getValidAccessToken"),
      getMessage: bomb("getMessage"),
    })
    const r = await call(RUN, d)
    assert.equal(r.status, 500)
    assert.equal(r.json.code, "MESSAGE_LOAD_FAILED")
  })
})

describe("CHECK (M–O)", () => {
  it("M/N/O. CHECK valide → 200, cible lue (id + companyId exacts), aucun token, aucun Gmail, aucune mutation", async () => {
    const { d, calls } = deps()
    const r = await call(CHECK, d)
    assert.equal(r.status, 200, r.text)
    assert.equal(r.json.ok, true)
    assert.equal(r.json.mode, "CHECK")
    assert.deepEqual(calls.load, [[COMPANY, MSG]])
    assert.deepEqual(calls.token, [], "M. aucune acquisition de token")
    assert.deepEqual(calls.gmail, [], "N. aucun appel Gmail")
    assert.equal(r.json.tokenAcquired, false)
    assert.equal(r.json.gmailCalled, false)
    // O. seule I/O = loadMessageTarget (lecture) ; aucun identifiant brut ni secret retourné.
    for (const s of [TOKEN, EXTERNAL, MAILBOX]) assert.ok(!r.text.includes(s), s)
  })

  it("O. CHECK avec token/Gmail en bombe → toujours 200 (prouve qu'ils ne sont jamais atteints)", async () => {
    const { d } = deps({ getValidAccessToken: bomb("getValidAccessToken"), getMessage: bomb("getMessage") })
    const r = await call(CHECK, d)
    assert.equal(r.status, 200, r.text)
  })

  it("O. source : aucune écriture Prisma, aucun getAttachment, aucun log dans le handler", () => {
    const src = readFileSync(path.join(ROOT, HANDLER_PATH), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "")
    assert.ok(!/\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\(/.test(src))
    assert.ok(!/\$executeRaw|\$queryRaw|\$transaction/.test(src))
    assert.ok(!/getAttachment/.test(src))
    assert.ok(!/console\./.test(src))
    assert.match(src, /select: \{ id: true, companyId: true, externalMessageId: true, sourceMailboxKey: true \}/)
    assert.match(src, /where: \{ id: messageId, companyId \}/)
  })

  it("route mince : POST délègue uniquement au handler", () => {
    const src = readFileSync(path.join(ROOT, ROUTE_PATH), "utf8")
    assert.match(src, /export async function POST\(req: Request\)/)
    assert.match(src, /return handleTargetedStagingGmailMimeDiagnostic\(req\)/)
    assert.ok(!/export async function (GET|PUT|PATCH|DELETE)/.test(src))
  })
})

describe("RUN (P–Y)", () => {
  it("P/Q. token via companyId + sourceMailboxKey exacts ; getMessage via token + externalMessageId exacts", async () => {
    const { d, calls } = deps()
    const r = await call(RUN, d)
    assert.equal(r.status, 200, r.text)
    assert.deepEqual(calls.token, [[{ companyId: COMPANY, connectionId: MAILBOX }]])
    assert.deepEqual(calls.gmail, [[TOKEN, EXTERNAL]])
  })

  it("R/S/T/U. uniquement image/* nommées, parts imbriquées, headers case-insensitive", async () => {
    const { d } = deps()
    const r = await call(RUN, d)
    assert.equal(r.json.mode, "RUN")
    assert.equal(r.json.imagePartCount, 2)
    assert.equal(r.json.truncated, false)
    assert.deepEqual(r.json.imageParts, [
      {
        partId: "0.1",
        filename: "image006.png",
        mimeType: "image/png",
        sizeBytes: 4321,
        hasAttachmentId: true,
        contentDisposition: 'inline; filename="image006.png"',
        contentId: "<image006.png@01DAFICT>",
      },
      {
        partId: "1",
        filename: "photo-chantier.jpg",
        mimeType: "image/jpeg",
        sizeBytes: 98765,
        hasAttachmentId: true,
        contentDisposition: 'attachment; filename="photo-chantier.jpg"',
        contentId: null,
      },
    ])
  })

  it("R. PDF, text/html et image sans filename exclus", () => {
    const { parts } = extractImageMimeParts(gmailMessage().payload)
    assert.deepEqual(parts.map((p) => p.filename), ["image006.png", "photo-chantier.jpg"])
  })

  it("S. imbrication profonde (4 niveaux) + payload racine image", () => {
    const deep = {
      mimeType: "multipart/mixed",
      parts: [{ mimeType: "multipart/alternative", parts: [{ mimeType: "multipart/related", parts: [
        { partId: "0.0.0.0", mimeType: "image/png", filename: "deep.png", body: { size: 1 } },
      ] }] }],
    }
    assert.deepEqual(extractImageMimeParts(deep).parts.map((p) => p.partId), ["0.0.0.0"])
    const root = { partId: "", mimeType: "image/png", filename: "root.png", body: { size: 2 } }
    assert.deepEqual(extractImageMimeParts(root).parts.map((p) => p.filename), ["root.png"])
    assert.deepEqual(extractImageMimeParts(undefined), { parts: [], truncated: false })
  })

  it("T/U. variantes de casse des noms de headers ; absence → null", () => {
    for (const [cd, cid] of [
      ["Content-Disposition", "Content-ID"],
      ["content-disposition", "content-id"],
      ["CONTENT-DISPOSITION", "CONTENT-ID"],
      ["Content-disposition", "Content-Id"],
    ]) {
      const { parts } = extractImageMimeParts({
        mimeType: "image/png",
        filename: "a.png",
        headers: [{ name: cd, value: "inline" }, { name: cid, value: "<a@b>" }],
      })
      assert.equal(parts[0]!.contentDisposition, "inline", cd)
      assert.equal(parts[0]!.contentId, "<a@b>", cid)
    }
    const { parts } = extractImageMimeParts({ mimeType: "image/png", filename: "a.png" })
    assert.equal(parts[0]!.contentDisposition, null)
    assert.equal(parts[0]!.contentId, null)
    assert.equal(parts[0]!.hasAttachmentId, false)
  })

  it("V/W/X. aucun attachmentId brut, body.data, snippet, sujet, expéditeur, autre header, token", async () => {
    const { d } = deps()
    const r = await call(RUN, d)
    for (const forbidden of [
      ATTACHMENT_ID,
      BODY_DATA,
      "PGh0bWw+",
      "SNIPPET-SENSITIVE",
      "SUBJECT-SENSITIVE",
      "sender-sensitive",
      "rcpt-sensitive",
      "OTHER-HEADER-SENSITIVE",
      "thread-fict",
      TOKEN,
      MAILBOX,
      '"payload"',
      '"data"',
      '"attachmentId"',
      '"headers"',
      '"snippet"',
    ]) {
      assert.ok(!r.text.includes(forbidden), `réponse contient ${forbidden}`)
    }
    for (const part of r.json.imageParts as Array<Record<string, unknown>>) {
      assert.deepEqual(Object.keys(part).sort(), [
        "contentDisposition", "contentId", "filename", "hasAttachmentId", "mimeType", "partId", "sizeBytes",
      ])
    }
  })

  it("Y. échec token (GmailProviderError dont le message contient le token) → 502, code seul, aucune fuite, Gmail non appelé", async () => {
    const { d, calls } = deps({
      getValidAccessToken: async () => {
        throw new GmailProviderError({
          code: "GMAIL_TOKEN_REFRESH_FAILED",
          message: `invalid_grant for ${TOKEN}`,
          retryable: false,
          global: true,
        })
      },
    })
    const r = await call(RUN, d)
    assert.equal(r.status, 502)
    assert.equal(r.json.code, "GMAIL_TOKEN_UNAVAILABLE")
    assert.equal(r.json.providerCode, "GMAIL_TOKEN_REFRESH_FAILED")
    assert.ok(!r.text.includes(TOKEN))
    assert.ok(!r.text.includes("invalid_grant"))
    assert.deepEqual(calls.gmail, [])
  })

  it("Y. échec getMessage (erreur générique contenant le token) → 502, providerCode null, aucune fuite", async () => {
    const { d } = deps({
      getMessage: async () => {
        throw new Error(`fetch failed Authorization: Bearer ${TOKEN}`)
      },
    })
    const r = await call(RUN, d)
    assert.equal(r.status, 502)
    assert.equal(r.json.code, "GMAIL_MESSAGE_FETCH_FAILED")
    assert.equal(r.json.providerCode, null)
    assert.ok(!r.text.includes(TOKEN))
    assert.ok(!r.text.includes("Bearer"))
  })

  it("Y. getMessage GmailProviderError 404 → code provider exposé, sans message", async () => {
    const { d } = deps({
      getMessage: async () => {
        throw new GmailProviderError({
          code: "GMAIL_MESSAGE_NOT_FOUND",
          message: `not found ${TOKEN}`,
          retryable: false,
          global: false,
          messageId: EXTERNAL,
        })
      },
    })
    const r = await call(RUN, d)
    assert.equal(r.json.providerCode, "GMAIL_MESSAGE_NOT_FOUND")
    assert.ok(!r.text.includes(TOKEN))
    assert.ok(!r.text.includes(EXTERNAL))
  })

  it("Y. token vide → 502 sans appel Gmail ; message Gmail d'un autre id → 502 sans parts", async () => {
    const empty = deps({ getValidAccessToken: async () => "", getMessage: bomb("getMessage") })
    const r1 = await call(RUN, empty.d)
    assert.equal(r1.status, 502)
    assert.equal(r1.json.code, "GMAIL_TOKEN_UNAVAILABLE")

    const other = deps({ getMessage: async () => ({ ...gmailMessage(), id: "gmail-other" }) })
    const r2 = await call(RUN, other.d)
    assert.equal(r2.status, 502)
    assert.equal(r2.json.code, "GMAIL_MESSAGE_IDENTITY_MISMATCH")
    assert.ok(!("imageParts" in r2.json))
  })

  it("bornes : profondeur pathologique → truncated, sans exception", () => {
    let node: { mimeType: string; parts?: unknown[]; filename?: string } = { mimeType: "image/png", filename: "x.png" }
    for (let i = 0; i < 100; i++) node = { mimeType: "multipart/mixed", parts: [node] }
    const res = extractImageMimeParts(node as never)
    assert.equal(res.truncated, true)
    assert.deepEqual(res.parts, [])
  })
})
