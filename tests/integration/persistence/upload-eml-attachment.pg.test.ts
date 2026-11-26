import assert from "node:assert/strict"
import { createHash, randomUUID } from "node:crypto"
import { mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { PrismaClient } from "@prisma/client"
import { registerIncomingMessage } from "@/lib/acquisition/acquisition.service"
import { AcquisitionAttachmentRepository } from "@/lib/acquisition/attachments/acquisition-attachment.repository"
import { downloadAcquisitionAttachment } from "@/lib/acquisition/attachments/attachment-download.service"
import { RETRYABLE_ATTACHMENT_ERROR_CODES } from "@/lib/acquisition/attachments/attachment-retry.policy"
import { assertSafeDisposableTestDatabaseUrl, resolveIntegrationTestDatabaseUrl } from "./helpers/safe-test-database-url"

test("une pièce UPLOAD relue depuis PostgreSQL survit aux pannes et ne sort jamais de sa société", async () => {
  const resolved = resolveIntegrationTestDatabaseUrl()
  assert.ok(resolved.ok)
  assertSafeDisposableTestDatabaseUrl(resolved.url)
  const db = new PrismaClient({ datasources: { db: { url: resolved.url } } })
  const dir = await mkdtemp(join(tmpdir(), "lot5-stockage-fictif-"))
  process.env.PLANIFICATOR_ACQUISITION_ENABLED = "true"
  process.env.ACQUISITION_ATTACHMENT_DOWNLOAD_ENABLED = "true"
  try {
    const company = await db.company.create({ data: { name: "Pièces fictives", slug: `pj-${randomUUID()}` } })
    const other = await db.company.create({ data: { name: "Autre société fictive", slug: `pj-${randomUUID()}` } })
    const companyId = company.id
    const admin = await db.user.create({
      data: { companyId, role: "ADMIN", email: `admin-${randomUUID()}@example.invalid`, password: "fixture inutilisable" },
    })
    const partner = await db.acquisitionPartner.create({
      data: { companyId, name: "Partenaire fictif", code: "pj-test", connector: "UPLOAD" },
    })
    const bytes = Buffer.from("%PDF-1.4 document de recette")
    const input = {
      companyId, source: "UPLOAD" as const, sourceMailboxKey: "connexion-fictive",
      externalMessageId: "fichier-fictif", senderEmail: "devis@example.invalid", receivedAt: new Date(),
      attachments: [{ filename: "fictif.pdf", mimeType: "application/pdf", sizeBytes: bytes.length }],
    }
    const deps = {
      uploadActorId: admin.id,
      eligibilityResolver: {
        isDomainEligible: async () => false,
        resolveEligibleSender: async () => ({ partner, matchKind: "DOMAIN" as const }),
      },
    }
    const foreignAdmin = await db.user.create({
      data: { companyId: other.id, role: "ADMIN", email: `autre-${randomUUID()}@example.invalid`, password: "fixture inutilisable" },
    })
    await assert.rejects(registerIncomingMessage(input, db, {
      ...deps, uploadActorId: foreignAdmin.id, uploadAttachmentBytes: [bytes],
    }), /Acteur UPLOAD non autorisé/)

    const profile = await db.employee.create({
      data: { companyId, userId: admin.id, role: "EMPLOYEE", firstName: "Profil", lastName: "Fictif" },
    })
    const assertAccessDenied = () => assert.rejects(registerIncomingMessage(
      input, db, { ...deps, uploadAttachmentBytes: [bytes] },
    ), /Acteur UPLOAD non autorisé/)
    await assertAccessDenied()
    await db.employee.update({ where: { id: profile.id }, data: { role: "ADMIN", active: false } })
    await assertAccessDenied()
    await db.employee.update({ where: { id: profile.id }, data: { active: true } })
    await db.user.update({ where: { id: admin.id }, data: { active: false } })
    await assertAccessDenied()
    await db.user.update({ where: { id: admin.id }, data: { active: true } })
    await db.company.update({ where: { id: companyId }, data: { active: false } })
    await assertAccessDenied()
    await db.company.update({ where: { id: companyId }, data: { active: true } })

    const auditUnavailable = db.$extends({
      query: {
        historyLog: {
          create() { throw new Error("Panne fictive de l’audit transactionnel") },
        },
      },
    })
    await assert.rejects(registerIncomingMessage(
      input, auditUnavailable as unknown as PrismaClient, { ...deps, uploadAttachmentBytes: [bytes] },
    ), /Panne fictive de l’audit transactionnel/)
    assert.equal(await db.acquisitionMessage.count({ where: { companyId } }), 0)
    assert.equal(await db.acquisitionAttachment.count({ where: { companyId } }), 0)
    assert.equal(await db.acquisitionAttachmentUploadSource.count({ where: { companyId } }), 0)
    assert.equal(await db.worksiteImportDraft.count({ where: { companyId } }), 0)
    assert.equal(await db.historyLog.count({ where: { companyId, entityType: "AcquisitionEmlImport" } }), 0)
    await assert.rejects(registerIncomingMessage(input, db, deps), /Octets des pièces UPLOAD invalides/)
    assert.equal(await db.acquisitionMessage.count({ where: { companyId } }), 0)
    const duplicatePart = { ...input.attachments[0], partId: "partie-dupliquee" }
    await assert.rejects(registerIncomingMessage(
      { ...input, attachments: [duplicatePart, duplicatePart] },
      db,
      { ...deps, uploadAttachmentBytes: [bytes, bytes] },
    ))
    assert.equal(await db.acquisitionMessage.count({ where: { companyId } }), 0)
    assert.equal(await db.acquisitionAttachmentUploadSource.count({ where: { companyId } }), 0)
    assert.equal(await db.worksiteImportDraft.count({ where: { companyId } }), 0)
    assert.equal(await db.historyLog.count({ where: { companyId, entityType: "AcquisitionEmlImport" } }), 0)
    const attempts = await Promise.all([1, 2].map(() =>
      registerIncomingMessage(input, db, { ...deps, uploadAttachmentBytes: [bytes] })
    ))
    assert.equal(attempts.filter((attempt) => attempt.created).length, 1)
    const piece = await db.acquisitionAttachment.findFirstOrThrow({ where: { companyId } })
    const attachmentId = piece.id
    const stagedWhere = { companyId, attachmentId }
    assert.equal(await db.acquisitionAttachmentUploadSource.count({ where: stagedWhere }), 1)

    const repository = new AcquisitionAttachmentRepository(db)
    const filename = join(dir, "document-prive")
    let failure: "before" | "after" | null = "before"
    let storageCalls = 0
    let destroyCalls = 0
    let verifies = 0
    const storage = {
      async store({ buffer }: { buffer: Buffer }) {
        storageCalls++
        if (failure === "before") throw new Error("Écriture fictive indisponible")
        try {
          await writeFile(filename, buffer, { flag: "wx" })
        } catch (error) {
          if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error
          return { created: false, storagePublicId: "document-prive" }
        }
        return { created: true, storagePublicId: "document-prive", storageUrl: "https://example.invalid/prive" }
      },
      async verifyExisting(proof: { companyId: string; attachmentId: string; storagePublicId: string; sizeBytes: number; sha256: string }) {
        verifies++
        if (proof.companyId !== companyId || proof.attachmentId !== attachmentId || proof.storagePublicId !== "document-prive") return null
        const existing = await readFile(filename)
        if (existing.length !== proof.sizeBytes || createHash("sha256").update(existing).digest("hex") !== proof.sha256) return null
        return { storageUrl: "https://example.invalid/prive" }
      },
      async destroy() { destroyCalls++; await unlink(filename) },
    }
    const worker = {
      db, repository, storage, log: () => {},
      gmailSource: { fetchAttachment: async () => assert.fail("Lecture Gmail inattendue") },
    }
    const foreign = await downloadAcquisitionAttachment({ companyId: other.id, attachmentId }, worker)
    assert.equal(foreign.outcome, "FAILED")
    assert.equal(storageCalls, 0)

    const schedule = async () => {
      const piece = await db.acquisitionAttachment.findUniqueOrThrow({ where: { id: attachmentId } })
      assert.ok(piece.downloadNextRetryAt)
      assert.equal(await repository.scheduleRetryToDiscovered({
        companyId, attachmentId, now: piece.downloadNextRetryAt, maxRetries: 5,
        retryableErrorCodes: [...RETRYABLE_ATTACHMENT_ERROR_CODES],
      }), "TRANSITIONED")
    }

    const before = await downloadAcquisitionAttachment({ companyId, attachmentId }, worker)
    assert.equal(before.outcome, "FAILED")
    assert.equal(await db.acquisitionAttachmentUploadSource.count({ where: stagedWhere }), 1)
    await schedule()

    failure = "after"
    const failingRepository = new AcquisitionAttachmentRepository(db)
    failingRepository.markStored = async () => ({ status: "FAILED" })
    const after = await downloadAcquisitionAttachment({ companyId, attachmentId }, { ...worker, repository: failingRepository })
    assert.equal(after.outcome, "FAILED")
    assert.deepEqual(await readFile(filename), bytes)
    assert.equal(destroyCalls, 0)
    assert.equal(await db.acquisitionAttachmentUploadSource.count({ where: stagedWhere }), 1)
    await schedule()

    failure = null
    const lostAckRepository = new AcquisitionAttachmentRepository(db)
    const commit = lostAckRepository.markStored.bind(lostAckRepository)
    let commits = 0
    lostAckRepository.markStored = async (...args) => {
      const persisted = await commit(...args)
      assert.equal(persisted.status, "STORED")
      commits++
      throw new Error("Acquittement fictif perdu après commit")
    }
    const downloads = await Promise.all([1, 2].map(() =>
      downloadAcquisitionAttachment({ companyId, attachmentId }, { ...worker, repository: lostAckRepository })
    ))
    assert.equal(commits, 1)
    assert.ok(downloads.some(({ outcome }) => outcome === "ALREADY_STORED"))
    assert.equal(verifies, 1)
    assert.equal(destroyCalls, 0)
    assert.deepEqual(await readFile(filename), bytes)
    assert.equal(await db.acquisitionAttachmentUploadSource.count({ where: stagedWhere }), 0)
    const replay = await downloadAcquisitionAttachment({ companyId, attachmentId }, worker)
    assert.equal(replay.outcome, "ALREADY_STORED")
    assert.deepEqual(await readFile(filename), bytes)
    assert.equal(storageCalls, 3)
  } finally {
    await db.$disconnect()
    await rm(dir, { recursive: true, force: true })
  }
})
