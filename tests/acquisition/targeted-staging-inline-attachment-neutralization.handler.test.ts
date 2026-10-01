/**
 * Harness neutralisation des 6 pièces inline historiques — deps injectées, aucune DB réelle.
 * La transaction est exercée sur une fausse DB à sémantique commit/rollback (écritures stagées,
 * committées uniquement si le callback réussit) : prouve « aucune écriture » / « rollback complet ».
 */
process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test"

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import path from "node:path"
import type { PrismaClient } from "@prisma/client"
import {
  INLINE_MIME_EMBEDDED_ERROR_CODE,
  INLINE_NEUTRALIZATION_ALLOWED_VERCEL_PROJECT_ID,
  INLINE_NEUTRALIZATION_CHECK_CONFIRMATION,
  INLINE_NEUTRALIZATION_MANIFEST,
  INLINE_NEUTRALIZATION_RUN_CONFIRMATION,
  INLINE_NEUTRALIZATION_TARGET,
  evaluateInlineNeutralizationRows,
  handleTargetedStagingInlineAttachmentNeutralization,
  runInlineNeutralizationTransaction,
  type InlineAttachmentFullRow,
  type InlineAttachmentRow,
  type InlineNeutralizationOutcome,
  type InlineNeutralizationSession,
  type TargetedInlineNeutralizationHandlerDeps,
} from "@/lib/acquisition/attachments/targeted-staging-inline-attachment-neutralization.handler"

const ROOT = path.resolve(__dirname, "../..")
const HANDLER_PATH = "src/lib/acquisition/attachments/targeted-staging-inline-attachment-neutralization.handler.ts"
const ROUTE_PATH = "src/app/api/acquisition/targeted-staging-inline-attachment-neutralization/route.ts"

const { companyId: COMPANY, acquisitionMessageId: MESSAGE } = INLINE_NEUTRALIZATION_TARGET
const NOW = new Date("2026-10-01T10:00:00.000Z")

const ENV = {
  VERCEL_ENV: "preview",
  VERCEL_PROJECT_ID: INLINE_NEUTRALIZATION_ALLOWED_VERCEL_PROJECT_ID,
  TARGETED_STAGING_INLINE_ATTACHMENT_NEUTRALIZATION_ENABLED: "true",
  TARGETED_STAGING_INLINE_NEUTRALIZATION_COMPANY_ID: COMPANY,
  TARGETED_STAGING_INLINE_NEUTRALIZATION_MESSAGE_ID: MESSAGE,
}
const ADMIN: InlineNeutralizationSession = { user: { id: "u1", role: "ADMIN", companyId: COMPANY } }
const CHECK = { confirmation: INLINE_NEUTRALIZATION_CHECK_CONFIRMATION }
const RUN = { confirmation: INLINE_NEUTRALIZATION_RUN_CONFIRMATION }

function fullRow(i: number, over: Partial<InlineAttachmentFullRow> = {}): InlineAttachmentFullRow {
  const e = INLINE_NEUTRALIZATION_MANIFEST[i]!
  return {
    id: e.id,
    companyId: COMPANY,
    acquisitionMessageId: MESSAGE,
    status: "DISCOVERED",
    category: "PHOTO",
    mimeType: "image/png",
    filename: e.filename,
    sizeBytes: e.sizeBytes,
    storagePublicId: null,
    storageUrl: null,
    storedAt: null,
    sha256: null,
    downloadClaimedAt: null,
    lastErrorCode: null,
    lastErrorAt: null,
    attachmentKey: `ext:ATT-${i}`,
    externalAttachmentId: `ATT-${i}`,
    downloadRetryCount: 0,
    downloadNextRetryAt: null,
    ...over,
  }
}

function sixRows(): InlineAttachmentFullRow[] {
  return INLINE_NEUTRALIZATION_MANIFEST.map((_, i) => fullRow(i))
}

const OTHER_ROW: InlineAttachmentFullRow = {
  ...fullRow(0),
  id: "other-attachment-pdf",
  filename: "image006.png",
  mimeType: "application/pdf",
  category: "PLAN",
  sizeBytes: 999,
  attachmentKey: "ext:OTHER",
  externalAttachmentId: "OTHER",
}

function toCheckRow(r: InlineAttachmentFullRow): InlineAttachmentRow {
  const { attachmentKey: _k, externalAttachmentId: _e, lastErrorAt: _a, downloadRetryCount: _c, downloadNextRetryAt: _n, ...rest } = r
  return rest
}

// ---------------------------------------------------------------------------
// Fausse DB transactionnelle (commit uniquement si le callback réussit).
// ---------------------------------------------------------------------------

type Where = Record<string, unknown>

function matchesWhere(row: InlineAttachmentFullRow, where: Where): boolean {
  for (const [key, cond] of Object.entries(where)) {
    if (key === "OR") {
      if (!(cond as Where[]).some((w) => matchesWhere(row, w))) return false
      continue
    }
    const value = (row as Record<string, unknown>)[key]
    if (cond && typeof cond === "object" && !(cond instanceof Date) && "in" in (cond as object)) {
      if (!((cond as { in: unknown[] }).in).includes(value)) return false
      continue
    }
    if (cond === null ? value !== null : value !== cond) return false
  }
  return true
}

function clone(rows: InlineAttachmentFullRow[]): InlineAttachmentFullRow[] {
  return rows.map((r) => ({ ...r }))
}

function fakeDb(initial: InlineAttachmentFullRow[], hooks: {
  updateCountOverride?: number
  tamperPostRead?: (rows: InlineAttachmentFullRow[]) => InlineAttachmentFullRow[]
  throwOnLock?: Error
  throwOnUpdate?: Error
} = {}) {
  let committed = clone(initial)
  const log: string[] = []
  let findManyCalls = 0
  const db = {
    async $transaction<T>(fn: (tx: unknown) => Promise<T>): Promise<T> {
      const staged = clone(committed)
      const tx = {
        async $queryRaw(strings: TemplateStringsArray) {
          log.push("lock")
          assert.match(strings.join("?"), /FOR UPDATE/)
          if (hooks.throwOnLock) throw hooks.throwOnLock
          const ids = INLINE_NEUTRALIZATION_MANIFEST.map((e) => e.id)
          return staged.filter((r) => ids.includes(r.id)).map((r) => toCheckRow({ ...r }))
        },
        acquisitionAttachment: {
          async findMany(args: { where: Where }) {
            findManyCalls++
            log.push("findMany")
            const rows = clone(staged.filter((r) => matchesWhere(r, args.where)))
            return findManyCalls >= 2 && hooks.tamperPostRead ? hooks.tamperPostRead(rows) : rows
          },
          async updateMany(args: { where: Where; data: Partial<InlineAttachmentFullRow> }) {
            log.push("updateMany")
            if (hooks.throwOnUpdate) throw hooks.throwOnUpdate
            let count = 0
            for (const r of staged) {
              if (matchesWhere(r, args.where)) {
                Object.assign(r, args.data)
                count++
              }
            }
            return { count: hooks.updateCountOverride ?? count }
          },
        },
      }
      const result = await fn(tx)
      committed = staged
      log.push("commit")
      return result
    },
  }
  return { db: db as unknown as PrismaClient, log, state: () => clone(committed) }
}

// ---------------------------------------------------------------------------
// Handler helpers
// ---------------------------------------------------------------------------

function bomb(name: string) {
  return async (): Promise<never> => {
    throw new Error(`${name} MUST NOT BE CALLED`)
  }
}

function deps(over: Partial<TargetedInlineNeutralizationHandlerDeps> = {}) {
  const calls = { message: [] as unknown[], rows: 0, run: [] as Date[] }
  const d: TargetedInlineNeutralizationHandlerDeps = {
    auth: async () => ADMIN,
    env: { ...ENV },
    now: () => NOW,
    loadMessage: async (input) => {
      calls.message.push(input)
      return { id: MESSAGE, companyId: COMPANY }
    },
    loadTargetRows: async () => {
      calls.rows++
      return sixRows().map(toCheckRow)
    },
    runNeutralization: async (now) => {
      calls.run.push(now)
      return { outcome: "NEUTRALIZED", updated: 6 }
    },
    ...over,
  }
  return { d, calls }
}

async function call(body: unknown, d: TargetedInlineNeutralizationHandlerDeps) {
  const res = await handleTargetedStagingInlineAttachmentNeutralization(
    new Request("http://localhost/api/acquisition/targeted-staging-inline-attachment-neutralization", {
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
  loadMessage: bomb("loadMessage"),
  loadTargetRows: bomb("loadTargetRows"),
  runNeutralization: bomb("runNeutralization"),
}

// ---------------------------------------------------------------------------

describe("guards — refus avant toute lecture / écriture", () => {
  const cases: Array<[string, Partial<TargetedInlineNeutralizationHandlerDeps>, unknown, number, string]> = [
    ["VERCEL_ENV production", { env: { ...ENV, VERCEL_ENV: "production" } }, RUN, 403, "HARNESS_SURFACE_FORBIDDEN"],
    ["VERCEL_ENV absent", { env: { ...ENV, VERCEL_ENV: undefined } }, RUN, 403, "HARNESS_SURFACE_FORBIDDEN"],
    ["mauvais project", { env: { ...ENV, VERCEL_PROJECT_ID: "prj_other" } }, RUN, 403, "HARNESS_SURFACE_FORBIDDEN"],
    ["project absent", { env: { ...ENV, VERCEL_PROJECT_ID: undefined } }, RUN, 403, "HARNESS_SURFACE_FORBIDDEN"],
    ["flag absent", { env: { ...ENV, TARGETED_STAGING_INLINE_ATTACHMENT_NEUTRALIZATION_ENABLED: undefined } }, RUN, 403, "HARNESS_DISABLED"],
    ["flag ≠ true", { env: { ...ENV, TARGETED_STAGING_INLINE_ATTACHMENT_NEUTRALIZATION_ENABLED: "TRUE" } }, RUN, 403, "HARNESS_DISABLED"],
    ["non authentifié", { auth: async () => null }, RUN, 401, "UNAUTHORIZED"],
    ["auth lève", { auth: async () => { throw new Error("x") } }, RUN, 401, "UNAUTHORIZED"],
    ["rôle USER", { auth: async () => ({ user: { id: "u", role: "USER", companyId: COMPANY } }) }, RUN, 403, "FORBIDDEN"],
    ["JSON invalide", {}, "{bad", 400, "INVALID_BODY"],
    ["body tableau", {}, [RUN], 400, "INVALID_BODY"],
    ["champ inconnu", {}, { ...RUN, dryRun: true }, 400, "UNKNOWN_FIELD"],
    ["confirmation absente", {}, {}, 400, "CONFIRMATION_REQUIRED"],
    ["confirmation fausse", {}, { confirmation: `${INLINE_NEUTRALIZATION_RUN_CONFIRMATION} ` }, 400, "CONFIRMATION_REQUIRED"],
    ["confirmation autre harness", {}, { confirmation: "RUN_TARGETED_STAGING_GMAIL_MIME_DIAGNOSTIC" }, 400, "CONFIRMATION_REQUIRED"],
    ["env company absente", { env: { ...ENV, TARGETED_STAGING_INLINE_NEUTRALIZATION_COMPANY_ID: undefined } }, RUN, 403, "HARNESS_TARGET_UNSET"],
    ["env message blanc", { env: { ...ENV, TARGETED_STAGING_INLINE_NEUTRALIZATION_MESSAGE_ID: " " } }, RUN, 403, "HARNESS_TARGET_UNSET"],
    ["env company ≠ constante", { env: { ...ENV, TARGETED_STAGING_INLINE_NEUTRALIZATION_COMPANY_ID: "co-other" } }, RUN, 403, "HARNESS_TARGET_MISMATCH"],
    ["env message ≠ constante", { env: { ...ENV, TARGETED_STAGING_INLINE_NEUTRALIZATION_MESSAGE_ID: "msg-other" } }, RUN, 403, "HARNESS_TARGET_MISMATCH"],
    ["tenant mismatch", { auth: async () => ({ user: { id: "u", role: "ADMIN", companyId: "co-other" } }) }, RUN, 403, "TENANT_MISMATCH"],
    ["session sans companyId", { auth: async () => ({ user: { id: "u", role: "SUPER_ADMIN", companyId: null } }) }, RUN, 403, "TENANT_MISMATCH"],
  ]
  for (const [label, over, body, status, code] of cases) {
    it(`${label} → ${status} ${code}`, async () => {
      const { d } = deps({ ...NO_IO, ...over })
      const r = await call(body, d)
      assert.equal(r.status, status)
      assert.equal(r.json.code, code)
      assert.equal(r.cache, "no-store")
    })
  }

  for (const key of [
    "companyId", "company_id", "messageId", "acquisitionMessageId", "acquisition_message_id",
    "attachmentId", "attachment_ids", "attachmentIds", "id", "ids", "IDS", "draftId", "filename",
    "status", "target", "manifest",
  ]) {
    it(`override « ${key} » (confirmation valide) → TARGET_OVERRIDE_FORBIDDEN`, async () => {
      const { d } = deps(NO_IO)
      const r = await call({ ...RUN, [key]: "x" }, d)
      assert.equal(r.status, 400)
      assert.equal(r.json.code, "TARGET_OVERRIDE_FORBIDDEN")
    })
  }

  it("message introuvable / identité divergente → 404 sans lecture des pièces ni RUN", async () => {
    for (const msg of [null, { id: "x", companyId: COMPANY }, { id: MESSAGE, companyId: "co-x" }]) {
      const { d } = deps({ loadMessage: async () => msg, loadTargetRows: bomb("rows"), runNeutralization: bomb("run") })
      const r = await call(RUN, d)
      assert.equal(r.status, 404)
      assert.equal(r.json.code, "MESSAGE_NOT_FOUND")
    }
  })

  it("message chargé avec la cible verrouillée exacte", async () => {
    const { d, calls } = deps()
    await call(CHECK, d)
    assert.deepEqual(calls.message, [{ companyId: COMPANY, messageId: MESSAGE }])
  })
})

describe("CHECK — lecture seule, jamais une autorisation", () => {
  it("6 conformes → APPLICABLE, wouldApply, zéro appel RUN", async () => {
    const { d, calls } = deps({ runNeutralization: bomb("runNeutralization") })
    const r = await call(CHECK, d)
    assert.equal(r.status, 200, r.text)
    assert.equal(r.json.result, "APPLICABLE")
    assert.equal(r.json.wouldApply, true)
    assert.equal(calls.rows, 1)
    assert.equal(r.cache, "no-store")
  })

  it("réponse minimale : aucun id, filename, size ni valeur de champ", async () => {
    const { d } = deps()
    const r = await call(CHECK, d)
    for (const e of INLINE_NEUTRALIZATION_MANIFEST) {
      assert.ok(!r.text.includes(e.id))
      assert.ok(!r.text.includes(e.filename))
      assert.ok(!r.text.includes(String(e.sizeBytes)))
    }
    assert.ok(!r.text.includes(COMPANY))
    assert.ok(!r.text.includes(MESSAGE))
  })

  it("préconditions KO → 200 PRECONDITION_FAILED avec codes, wouldApply false, aucun RUN", async () => {
    const rows = sixRows().map(toCheckRow)
    rows[2] = { ...rows[2]!, sha256: "abc" }
    const { d } = deps({ loadTargetRows: async () => rows, runNeutralization: bomb("run") })
    const r = await call(CHECK, d)
    assert.equal(r.json.result, "PRECONDITION_FAILED")
    assert.equal(r.json.wouldApply, false)
    assert.deepEqual((r.json.rows as Array<{ failedChecks: string[] }>)[2]!.failedChecks, ["SHA256_SET"])
    assert.ok(!r.text.includes('"abc"'))
  })

  it("lecture en erreur → code seul", async () => {
    const { d } = deps({ loadTargetRows: async () => { throw new Error("SELECT secret FROM x") } })
    const r = await call(CHECK, d)
    assert.equal(r.status, 500)
    assert.equal(r.json.code, "TARGET_ROWS_LOAD_FAILED")
    assert.ok(!r.text.includes("SELECT"))
  })

  it("RUN revalide indépendamment : un CHECK APPLICABLE puis état modifié → RUN PRECONDITION_FAILED, zéro écriture", async () => {
    const fake = fakeDb(sixRows())
    const check = await call(CHECK, deps({ loadTargetRows: async () => fake.state().map(toCheckRow) }).d)
    assert.equal(check.json.result, "APPLICABLE")
    // Changement d'état entre CHECK et RUN (ex. claim downloader concurrent).
    const drifted = fake.state()
    drifted[4] = { ...drifted[4]!, status: "PENDING_DOWNLOAD", downloadClaimedAt: NOW }
    const fake2 = fakeDb(drifted)
    const run = await call(RUN, deps({ runNeutralization: (now) => runInlineNeutralizationTransaction(fake2.db, now) }).d)
    assert.equal(run.status, 409)
    assert.equal(run.json.code, "PRECONDITION_FAILED")
    assert.deepEqual(fake2.state(), drifted)
    assert.ok(!fake2.log.includes("updateMany"))
  })
})

describe("evaluateInlineNeutralizationRows — préconditions exactes", () => {
  const ROW_CASES: Array<[string, Partial<InlineAttachmentFullRow>, string]> = [
    ["mauvais filename (échange)", { filename: "image007.png" }, "FILENAME_MISMATCH"],
    ["mauvais sizeBytes", { sizeBytes: 230196 }, "SIZE_MISMATCH"],
    ["mauvais mimeType", { mimeType: "image/jpeg" }, "MIME_MISMATCH"],
    ["mimeType casse différente", { mimeType: "IMAGE/PNG" }, "MIME_MISMATCH"],
    ["mauvaise category", { category: "UNKNOWN" }, "CATEGORY_MISMATCH"],
    ["mauvais companyId", { companyId: "co-other" }, "COMPANY_MISMATCH"],
    ["mauvais acquisitionMessageId", { acquisitionMessageId: "msg-other" }, "MESSAGE_MISMATCH"],
    ["status PENDING_DOWNLOAD", { status: "PENDING_DOWNLOAD" }, "STATUS_NOT_DISCOVERED"],
    ["status STORED", { status: "STORED" }, "STATUS_NOT_DISCOVERED"],
    ["status FAILED", { status: "FAILED" }, "STATUS_NOT_DISCOVERED"],
    ["status REJECTED autre code", { status: "REJECTED", lastErrorCode: "ATTACHMENT_TOO_LARGE" }, "STATUS_NOT_DISCOVERED"],
    ["storagePublicId non null", { storagePublicId: "pub/x" }, "STORAGE_PUBLIC_ID_SET"],
    ["storageUrl non null", { storageUrl: "https://x" }, "STORAGE_URL_SET"],
    ["storedAt non null", { storedAt: NOW }, "STORED_AT_SET"],
    ["sha256 non null", { sha256: "abc" }, "SHA256_SET"],
    ["downloadClaimedAt non null", { downloadClaimedAt: NOW }, "DOWNLOAD_CLAIMED"],
  ]
  for (const [label, over, code] of ROW_CASES) {
    it(`${label} → PRECONDITION_FAILED (${code})`, () => {
      const rows = sixRows()
      rows[0] = fullRow(0, over)
      const ev = evaluateInlineNeutralizationRows(rows.map(toCheckRow))
      assert.equal(ev.kind, "PRECONDITION_FAILED")
      assert.ok(ev.rows[0]!.failedChecks.includes(code as never), JSON.stringify(ev.rows[0]))
      assert.ok(ev.rows.slice(1).every((r) => r.ok))
    })
  }

  it("5/6 (une ligne absente) → ROW_MISSING", () => {
    const ev = evaluateInlineNeutralizationRows(sixRows().slice(0, 5).map(toCheckRow))
    assert.equal(ev.kind, "PRECONDITION_FAILED")
    assert.deepEqual(ev.rows[5]!.failedChecks, ["ROW_MISSING"])
  })

  it("0/6 → toutes ROW_MISSING", () => {
    const ev = evaluateInlineNeutralizationRows([])
    assert.equal(ev.kind, "PRECONDITION_FAILED")
    assert.ok(ev.rows.every((r) => r.failedChecks[0] === "ROW_MISSING"))
  })

  it("7/6 (ligne hors manifest) → PRECONDITION_FAILED, unexpectedRows = 1", () => {
    const ev = evaluateInlineNeutralizationRows([...sixRows(), OTHER_ROW].map(toCheckRow))
    assert.equal(ev.kind, "PRECONDITION_FAILED")
    if (ev.kind === "PRECONDITION_FAILED") assert.equal(ev.unexpectedRows, 1)
  })

  it("doublon d'id → ROW_DUPLICATE", () => {
    const ev = evaluateInlineNeutralizationRows([...sixRows(), fullRow(3)].map(toCheckRow))
    assert.equal(ev.kind, "PRECONDITION_FAILED")
    assert.deepEqual(ev.rows[3]!.failedChecks, ["ROW_DUPLICATE"])
  })

  it("6 × REJECTED + INLINE_MIME_EMBEDDED → ALREADY_NEUTRALIZED", () => {
    const rows = sixRows().map((r) => ({ ...r, status: "REJECTED", lastErrorCode: INLINE_MIME_EMBEDDED_ERROR_CODE }))
    assert.equal(evaluateInlineNeutralizationRows(rows.map(toCheckRow)).kind, "ALREADY_NEUTRALIZED")
  })

  it("état mixte (3 DISCOVERED + 3 REJECTED inline) → PRECONDITION_FAILED", () => {
    const rows = sixRows().map((r, i) => (i < 3 ? r : { ...r, status: "REJECTED", lastErrorCode: INLINE_MIME_EMBEDDED_ERROR_CODE }))
    const ev = evaluateInlineNeutralizationRows(rows.map(toCheckRow))
    assert.equal(ev.kind, "PRECONDITION_FAILED")
    assert.deepEqual(ev.rows.map((r) => r.ok), [true, true, true, false, false, false])
  })

  it("aucun contrôle par regex de filename hors manifest : un homonyme hors IDs n'est pas lu", () => {
    const src = readFileSync(path.join(ROOT, HANDLER_PATH), "utf8")
    assert.ok(!/image0\(|image0\[|\^image/.test(src))
  })
})

describe("transaction RUN — fausse DB à sémantique commit/rollback", () => {
  it("RUN valide → exactement 6 mises à jour, seuls status/lastErrorCode/lastErrorAt changent, autre pièce intacte", async () => {
    const fake = fakeDb([...sixRows(), OTHER_ROW])
    const out = await runInlineNeutralizationTransaction(fake.db, NOW)
    assert.deepEqual(out, { outcome: "NEUTRALIZED", updated: 6 })
    assert.deepEqual(fake.log, ["lock", "findMany", "updateMany", "findMany", "commit"])
    const state = fake.state()
    for (let i = 0; i < 6; i++) {
      assert.deepEqual(state[i], { ...fullRow(i), status: "REJECTED", lastErrorCode: "INLINE_MIME_EMBEDDED", lastErrorAt: NOW })
    }
    assert.deepEqual(state[6], OTHER_ROW)
  })

  it("préconditions KO → aucun updateMany, aucun changement", async () => {
    const rows = sixRows()
    rows[1] = fullRow(1, { storageUrl: "https://x" })
    const fake = fakeDb(rows)
    const out = await runInlineNeutralizationTransaction(fake.db, NOW)
    assert.equal(out.outcome, "PRECONDITION_FAILED")
    assert.ok(!fake.log.includes("updateMany"))
    assert.deepEqual(fake.state(), rows)
  })

  it("updateMany count ≠ 6 → UPDATE_COUNT_MISMATCH, rollback complet", async () => {
    for (const count of [0, 5, 7]) {
      const fake = fakeDb(sixRows(), { updateCountOverride: count })
      const out = await runInlineNeutralizationTransaction(fake.db, NOW)
      assert.deepEqual(out, { outcome: "UPDATE_COUNT_MISMATCH" })
      assert.ok(!fake.log.includes("commit"))
      assert.deepEqual(fake.state(), sixRows())
    }
  })

  it("relecture post-update incorrecte → POST_READ_MISMATCH, rollback complet", async () => {
    const tampers: Array<(rows: InlineAttachmentFullRow[]) => InlineAttachmentFullRow[]> = [
      (rows) => rows.map((r, i) => (i === 0 ? { ...r, status: "DISCOVERED" } : r)),
      (rows) => rows.map((r, i) => (i === 1 ? { ...r, lastErrorCode: "OTHER" } : r)),
      (rows) => rows.map((r, i) => (i === 2 ? { ...r, category: "UNKNOWN" } : r)),
      (rows) => rows.map((r, i) => (i === 3 ? { ...r, attachmentKey: "changed" } : r)),
      (rows) => rows.map((r, i) => (i === 4 ? { ...r, lastErrorAt: new Date(0) } : r)),
      (rows) => rows.map((r, i) => (i === 5 ? { ...r, downloadRetryCount: 1 } : r)),
      (rows) => rows.slice(0, 5),
    ]
    for (const tamperPostRead of tampers) {
      const fake = fakeDb(sixRows(), { tamperPostRead })
      const out = await runInlineNeutralizationTransaction(fake.db, NOW)
      assert.deepEqual(out, { outcome: "POST_READ_MISMATCH" })
      assert.deepEqual(fake.state(), sixRows())
    }
  })

  it("second RUN → ALREADY_NEUTRALIZED, zéro updateMany, état inchangé", async () => {
    const fake = fakeDb(sixRows())
    assert.equal((await runInlineNeutralizationTransaction(fake.db, NOW)).outcome, "NEUTRALIZED")
    const after1 = fake.state()
    const second = fakeDb(after1)
    const out = await runInlineNeutralizationTransaction(second.db, new Date(NOW.getTime() + 60_000))
    assert.deepEqual(out, { outcome: "ALREADY_NEUTRALIZED" })
    assert.ok(!second.log.includes("updateMany"))
    assert.deepEqual(second.state(), after1)
  })

  it("erreur Prisma simulée (lock / update) → TRANSACTION_FAILED, rollback, aucune fuite", async () => {
    const leak = new Error('Invalid `prisma.acquisitionAttachment.updateMany()` invocation: SELECT "sha256" FROM secret WHERE id=cmtvfubht00stz05odjfui0m4')
    for (const hooks of [{ throwOnLock: leak }, { throwOnUpdate: leak }]) {
      const fake = fakeDb(sixRows(), hooks)
      const out = await runInlineNeutralizationTransaction(fake.db, NOW)
      assert.deepEqual(out, { outcome: "TRANSACTION_FAILED" })
      assert.deepEqual(fake.state(), sixRows())
    }
  })
})

describe("RUN via handler — mapping des issues, aucune fuite", () => {
  const OUTCOMES: Array<[InlineNeutralizationOutcome, number, string]> = [
    [{ outcome: "ALREADY_NEUTRALIZED" }, 409, "ALREADY_NEUTRALIZED"],
    [{ outcome: "PRECONDITION_FAILED", rows: [], unexpectedRows: 0 }, 409, "PRECONDITION_FAILED"],
    [{ outcome: "UPDATE_COUNT_MISMATCH" }, 409, "UPDATE_COUNT_MISMATCH"],
    [{ outcome: "POST_READ_MISMATCH" }, 409, "POST_READ_MISMATCH"],
    [{ outcome: "TRANSACTION_FAILED" }, 500, "TRANSACTION_FAILED"],
  ]
  for (const [outcome, status, code] of OUTCOMES) {
    it(`${outcome.outcome} → ${status} ${code}`, async () => {
      const { d } = deps({ runNeutralization: async () => outcome, loadTargetRows: bomb("rows") })
      const r = await call(RUN, d)
      assert.equal(r.status, status)
      assert.equal(r.json.code, code)
      assert.equal(r.cache, "no-store")
    })
  }

  it("RUN valide → 200 NEUTRALIZED, 6, now injecté, CHECK jamais lu", async () => {
    const { d, calls } = deps({ loadTargetRows: bomb("loadTargetRows") })
    const r = await call(RUN, d)
    assert.equal(r.status, 200)
    assert.deepEqual(
      { result: r.json.result, updated: r.json.updated, mode: r.json.mode },
      { result: "NEUTRALIZED", updated: 6, mode: "RUN" }
    )
    assert.deepEqual(calls.run, [NOW])
  })

  it("runNeutralization qui lève (message Prisma) → 500 TRANSACTION_FAILED sans fuite", async () => {
    const { d } = deps({
      runNeutralization: async () => {
        throw new Error("PrismaClientKnownRequestError: P2002 SELECT secret cmtvfubht00stz05odjfui0m4")
      },
    })
    const r = await call(RUN, d)
    assert.equal(r.status, 500)
    assert.equal(r.json.code, "TRANSACTION_FAILED")
    for (const s of ["Prisma", "P2002", "SELECT", "cmtvfubht00stz05odjfui0m4", "stack"]) {
      assert.ok(!r.text.includes(s), s)
    }
  })

  it("RUN de bout en bout (handler + transaction réelle sur fausse DB) → 6 neutralisées, puis ALREADY_NEUTRALIZED", async () => {
    let store = sixRows()
    const runner = async (now: Date) => {
      const fake = fakeDb(store)
      const out = await runInlineNeutralizationTransaction(fake.db, now)
      store = fake.state()
      return out
    }
    const first = await call(RUN, deps({ runNeutralization: runner }).d)
    assert.equal(first.json.result, "NEUTRALIZED")
    assert.ok(store.every((r) => r.status === "REJECTED" && r.lastErrorCode === "INLINE_MIME_EMBEDDED"))
    const snapshot = JSON.stringify(store)
    const second = await call(RUN, deps({ runNeutralization: runner }).d)
    assert.equal(second.status, 409)
    assert.equal(second.json.code, "ALREADY_NEUTRALIZED")
    assert.equal(JSON.stringify(store), snapshot)
  })
})

describe("source", () => {
  const src = readFileSync(path.join(ROOT, HANDLER_PATH), "utf8")
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")

  it("aucun Gmail / OAuth / extraction / conversion / download / log", () => {
    assert.ok(!/gmail|oauth|getValidAccessToken|getAttachment/i.test(code))
    assert.ok(!/extraction|conversion|attachment-download|repository/i.test(code.replace(/acquisitionAttachment/g, "")))
    assert.ok(!/console\./.test(code))
  })

  it("un seul updateMany, WHERE répétant les invariants, data limitée à 3 champs", () => {
    assert.equal((code.match(/\.updateMany\(/g) ?? []).length, 1)
    assert.ok(!/\.(create|createMany|update|upsert|delete|deleteMany)\(/.test(code))
    assert.ok(!/\$executeRaw/.test(code))
    const upd = code.slice(code.indexOf(".updateMany("), code.indexOf("if (result.count !== 6)"))
    for (const inv of [
      'status: "DISCOVERED"', "category: EXPECTED_CATEGORY", "mimeType: EXPECTED_MIME", "storagePublicId: null",
      "storageUrl: null", "storedAt: null", "sha256: null", "downloadClaimedAt: null", "filename: e.filename",
      "sizeBytes: e.sizeBytes", "companyId: INLINE_NEUTRALIZATION_TARGET.companyId",
      "acquisitionMessageId: INLINE_NEUTRALIZATION_TARGET.acquisitionMessageId",
    ]) {
      assert.ok(upd.includes(inv), inv)
    }
    const data = upd.slice(upd.indexOf("data: {"))
    assert.match(data, /data: \{\s*status: "REJECTED",\s*lastErrorCode: INLINE_MIME_EMBEDDED_ERROR_CODE,\s*lastErrorAt: now,\s*\}/)
  })

  it("verrou FOR UPDATE sur les seuls IDs du manifest, dans la transaction", () => {
    assert.match(code, /FOR UPDATE/)
    assert.match(code, /WHERE "id" IN \(\$\{Prisma\.join\(\[\.\.\.MANIFEST_IDS\]\)\}\)/)
    assert.ok(code.indexOf("lockTargetRows(tx)") > code.indexOf("db.$transaction("))
  })

  it("manifest exact et figé", () => {
    assert.deepEqual(INLINE_NEUTRALIZATION_MANIFEST.map((e) => [e.id, e.filename, e.sizeBytes]), [
      ["cmtvfubht00stz05odjfui0m4", "image006.png", 230197],
      ["cmtvfubht00suz05oy1qx6x4c", "image007.png", 5807],
      ["cmtvfubht00svz05o808akzbh", "image008.png", 443998],
      ["cmtvfubht00swz05o80u0mer5", "image009.png", 18891],
      ["cmtvfubht00sxz05onuz8ifj6", "image010.png", 37228],
      ["cmtvfubht00syz05otw4sd6ev", "image011.png", 369084],
    ])
    assert.ok(Object.isFrozen(INLINE_NEUTRALIZATION_MANIFEST))
    assert.ok(INLINE_NEUTRALIZATION_MANIFEST.every((e) => Object.isFrozen(e)))
    assert.ok(Object.isFrozen(INLINE_NEUTRALIZATION_TARGET))
  })

  it("route mince : POST uniquement", () => {
    const route = readFileSync(path.join(ROOT, ROUTE_PATH), "utf8")
    assert.match(route, /return handleTargetedStagingInlineAttachmentNeutralization\(req\)/)
    assert.ok(!/export async function (GET|PUT|PATCH|DELETE)/.test(route))
  })
})
