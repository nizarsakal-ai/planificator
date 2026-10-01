/**
 * Runner manuel worksiteCreation ciblé — preuve PostgreSQL RÉELLE de l'ordre :
 * gardes pures → identité read-only (port Prisma réel, transaction READ ONLY) → wiring.
 * Aucune écriture (y compris acquisition_orchestrator_leases) avant validation complète.
 * Skip si TEST_ACQUISITION_DATABASE_URL absent. Base locale jetable uniquement.
 */
if (process.env.TEST_ACQUISITION_DATABASE_URL) {
  // Le port réel utilise le singleton Prisma (DATABASE_URL), comme le wiring : même base.
  process.env.DATABASE_URL = process.env.TEST_ACQUISITION_DATABASE_URL
}
process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test"

import { describe, it, before, after } from "node:test"
import assert from "node:assert/strict"
import { PrismaClient } from "@prisma/client"
import { registerIncomingMessage } from "@/lib/acquisition/acquisition.service"
import { seedLauraluPartnerForCompany } from "./helpers/seed-lauralu-partner"
import { prisma } from "@/lib/prisma"
import {
  TARGETED_WORKSITE_CREATION_CHECK_CONFIRMATION,
  TARGETED_WORKSITE_CREATION_CONFIRMATION,
  prismaDatabaseIdentityReadPort,
  runGuardedTargetedWorksiteCreation,
  type ScriptTarget,
} from "../../scripts/run-targeted-staging-worksite-creation"

const TEST_URL = process.env.TEST_ACQUISITION_DATABASE_URL
const enabled = Boolean(TEST_URL)
const RUN = { skip: enabled ? undefined : "TEST_ACQUISITION_DATABASE_URL non défini" }

// Toutes les requêtes du singleton (celui du port réel ET du wiring) sont observées.
const singletonCalls: string[] = []
prisma.$use(async (params, next) => {
  singletonCalls.push(`${params.model ?? "raw"}.${params.action}`)
  return next(params)
})

const READ_ACTIONS = new Set(["raw.executeRaw", "raw.queryRaw", "WorksiteImportDraft.findFirst"])

describe("TARGETED runner — PostgreSQL : identité read-only avant toute écriture", RUN, () => {
  const stamp = Date.now()
  let companyId = ""
  let draftId = ""
  let urlHost = ""
  let urlName = ""
  let admin: PrismaClient

  before(async () => {
    admin = new PrismaClient({ datasources: { db: { url: TEST_URL! } } })
    const parsed = new URL(TEST_URL!)
    urlHost = parsed.hostname
    urlName = decodeURIComponent(parsed.pathname.replace(/^\//, ""))
    assert.equal(urlHost, "127.0.0.1", "base locale uniquement")

    const company = await admin.company.create({ data: { name: "Runner PG Co", slug: `runner-pg-${stamp}` } })
    companyId = company.id
    await seedLauraluPartnerForCompany(admin, companyId)
    const reg = await registerIncomingMessage(
      {
        companyId,
        source: "GMAIL",
        externalMessageId: `ext-runner-pg-${stamp}`,
        senderEmail: "carlene@lauralu.fr",
        subject: "Runner PG",
        receivedAt: new Date(),
        attachments: [],
      },
      admin
    )
    draftId = reg.draftId!
  })

  after(async () => {
    if (!enabled) return
    await admin.worksiteImportDraft.updateMany({ where: { companyId }, data: { createdWorksiteId: null } })
    await admin.worksite.deleteMany({ where: { companyId } })
    await admin.worksiteImportDraft.deleteMany({ where: { companyId } })
    await admin.acquisitionMessage.deleteMany({ where: { companyId } })
    await admin.acquisitionPartnerDomain.deleteMany({ where: { companyId } })
    await admin.acquisitionPartner.deleteMany({ where: { companyId } })
    await admin.client.deleteMany({ where: { companyId } })
    await admin.user.deleteMany({ where: { companyId } })
    await admin.company.delete({ where: { id: companyId } }).catch(() => undefined)
    await admin.$disconnect()
    await prisma.$disconnect()
  })

  async function setDraft(data: { status: "APPROVED" | "PENDING_REVIEW"; createdWorksiteId?: string | null }) {
    await admin.worksiteImportDraft.update({
      where: { id: draftId },
      data: { status: data.status, version: 6, createdWorksiteId: data.createdWorksiteId ?? null },
    })
  }

  async function snapshot() {
    const leases = await admin.$queryRaw<Array<{ n: bigint }>>`SELECT count(*)::bigint AS n FROM "acquisition_orchestrator_leases"`
    const d = await admin.worksiteImportDraft.findUniqueOrThrow({
      where: { id: draftId },
      select: { status: true, version: true, createdWorksiteId: true, updatedAt: true },
    })
    return { leases: Number(leases[0]!.n), draft: d, worksites: await admin.worksite.count({ where: { companyId } }) }
  }

  function env(over: Record<string, string | undefined> = {}) {
    return {
      TARGETED_STAGING_WORKSITE_CREATION_RUN_ENABLED: "true",
      TARGETED_STAGING_EXPECTED_DATABASE_HOST: urlHost,
      TARGETED_STAGING_EXPECTED_DATABASE_NAME: urlName,
      TARGETED_STAGING_FORBIDDEN_DATABASE_HOST: "forbidden-live.invalid",
      DATABASE_URL: TEST_URL,
      TARGETED_STAGING_ATTACHMENT_NOT_READY_COMPANY_ID: companyId,
      TARGETED_STAGING_ATTACHMENT_NOT_READY_DRAFT_ID: draftId,
      ...over,
    }
  }

  const ARGV = ["node", "script.ts", `--confirm=${TARGETED_WORKSITE_CREATION_CONFIRMATION}`]
  const CHECK_ARGV = ["node", "script.ts", `--confirm=${TARGETED_WORKSITE_CREATION_CHECK_CONFIRMATION}`]

  async function guarded(e: Record<string, string | undefined>, argv: string[] = ARGV) {
    const runCalls: Array<{ target: ScriptTarget; leasesAtCall: number; callsAtCall: string[] }> = []
    singletonCalls.length = 0
    const result = await runGuardedTargetedWorksiteCreation({
      argv,
      env: e,
      identityPort: prismaDatabaseIdentityReadPort,
      runWorksiteCreation: async (input) => {
        const s = await snapshot()
        runCalls.push({ target: input.target, leasesAtCall: s.leases, callsAtCall: [...singletonCalls] })
        return { outcome: "TARGET_NOT_AUTHORIZED" as const }
      },
    })
    return { result, runCalls, calls: [...singletonCalls] }
  }

  it("R-0 — garde pure en échec (mauvais hôte) → aucune requête, aucune écriture", async () => {
    await setDraft({ status: "APPROVED" })
    const before = await snapshot()
    const { result, runCalls, calls } = await guarded(env({ TARGETED_STAGING_EXPECTED_DATABASE_HOST: "other.invalid" }))
    assert.deepEqual(result, { ok: false, stage: "PURE_GUARDS", code: "DATABASE_IDENTITY_MISMATCH" })
    assert.deepEqual(calls, [])
    assert.equal(runCalls.length, 0)
    assert.deepEqual(await snapshot(), before)
  })

  it("R-1 — empreinte valide (base réelle) → wiring appelé APRÈS des lectures uniquement, lease intact", async () => {
    await setDraft({ status: "APPROVED" })
    const before = await snapshot()
    const { result, runCalls, calls } = await guarded(env())
    assert.equal(result.ok, true, JSON.stringify(result))
    assert.equal(runCalls.length, 1)
    assert.deepEqual(runCalls[0]!.target, { companyId, draftId })
    // Au moment de l'appel du wiring : uniquement des lectures, aucune ligne de lease créée.
    assert.deepEqual(runCalls[0]!.callsAtCall, ["raw.executeRaw", "raw.queryRaw", "WorksiteImportDraft.findFirst"])
    assert.ok(runCalls[0]!.callsAtCall.every((c) => READ_ACTIONS.has(c)))
    assert.equal(runCalls[0]!.leasesAtCall, before.leases)
    assert.ok(calls.every((c) => READ_ACTIONS.has(c)))
  })

  const refusals: Array<[string, () => Promise<void>, Record<string, string | undefined>, string]> = [
    ["R-2 — cible absente", async () => setDraft({ status: "APPROVED" }), { TARGETED_STAGING_ATTACHMENT_NOT_READY_DRAFT_ID: "draft-absent-xyz" }, "TARGET_FINGERPRINT_ABSENT"],
    ["R-3 — mauvaise company", async () => setDraft({ status: "APPROVED" }), { TARGETED_STAGING_ATTACHMENT_NOT_READY_COMPANY_ID: "co-absent-xyz" }, "TARGET_FINGERPRINT_ABSENT"],
    ["R-4 — status PENDING_REVIEW", async () => setDraft({ status: "PENDING_REVIEW" }), {}, "TARGET_FINGERPRINT_MISMATCH"],
  ]
  for (const [label, setup, over, code] of refusals) {
    it(`${label} → ${code}, lectures uniquement, aucun lease, draft inchangé`, async () => {
      await setup()
      const before = await snapshot()
      const { result, runCalls, calls } = await guarded(env(over))
      assert.deepEqual(result, { ok: false, stage: "READ_ONLY_IDENTITY", code })
      assert.equal(runCalls.length, 0)
      assert.deepEqual(calls, ["raw.executeRaw", "raw.queryRaw", "WorksiteImportDraft.findFirst"])
      assert.deepEqual(await snapshot(), before)
    })
  }

  it("R-5 — createdWorksiteId non null → TARGET_FINGERPRINT_MISMATCH, aucun lease, aucune écriture", async () => {
    const user = await admin.user.create({
      data: { email: `runner-pg-${stamp}@test.local`, name: "Runner", role: "ADMIN", companyId, password: "x" },
    })
    const client = await admin.client.create({ data: { name: "Client Runner", companyId } })
    const ws = await admin.worksite.create({
      data: { name: "WS existant", companyId, clientId: client.id, createdById: user.id, dailyHours: 10, status: "PLANNED" },
      select: { id: true },
    })
    await setDraft({ status: "APPROVED", createdWorksiteId: ws.id })
    const before = await snapshot()
    const { result, runCalls, calls } = await guarded(env())
    assert.deepEqual(result, { ok: false, stage: "READ_ONLY_IDENTITY", code: "TARGET_FINGERPRINT_MISMATCH" })
    assert.equal(runCalls.length, 0)
    assert.ok(calls.every((c) => READ_ACTIONS.has(c)))
    assert.deepEqual(await snapshot(), before)
  })

  it("R-7 — CHECK (port Prisma réel) → CHECK_PASSED, exactement les 3 lectures d'identité, aucun wiring, aucun lease, base inchangée", async () => {
    await setDraft({ status: "APPROVED" })
    const before = await snapshot()
    const { result, runCalls, calls } = await guarded(env(), CHECK_ARGV)
    assert.deepEqual(result, { ok: true, mode: "CHECK", code: "CHECK_PASSED" })
    assert.equal(runCalls.length, 0)
    assert.deepEqual(calls, ["raw.executeRaw", "raw.queryRaw", "WorksiteImportDraft.findFirst"])
    assert.deepEqual(await snapshot(), before)
  })

  it("R-8 — CHECK + empreinte absente / non APPROVED → refus READ_ONLY_IDENTITY, aucun wiring, base inchangée", async () => {
    for (const [setup, over, code] of [
      [async () => setDraft({ status: "APPROVED" }), { TARGETED_STAGING_ATTACHMENT_NOT_READY_DRAFT_ID: "draft-absent-xyz" }, "TARGET_FINGERPRINT_ABSENT"],
      [async () => setDraft({ status: "PENDING_REVIEW" }), {}, "TARGET_FINGERPRINT_MISMATCH"],
    ] as const) {
      await setup()
      const before = await snapshot()
      const { result, runCalls, calls } = await guarded(env(over), CHECK_ARGV)
      assert.deepEqual(result, { ok: false, stage: "READ_ONLY_IDENTITY", code })
      assert.equal(runCalls.length, 0)
      assert.deepEqual(calls, ["raw.executeRaw", "raw.queryRaw", "WorksiteImportDraft.findFirst"])
      assert.deepEqual(await snapshot(), before)
    }
  })

  it("R-6 — la transaction d'identité est réellement READ ONLY (écriture refusée par PostgreSQL)", async () => {
    await assert.rejects(
      () =>
        admin.$transaction(async (tx) => {
          await tx.$executeRaw`SET TRANSACTION READ ONLY`
          await tx.$executeRaw`UPDATE "worksite_import_drafts" SET "version" = "version" WHERE "id" = ${draftId}`
        }),
      (err: unknown) => /25006|read-only transaction/i.test(String(err))
    )
  })
})
