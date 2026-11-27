import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { test } from "node:test"
import { PrismaClient } from "@prisma/client"
import { createPrismaAutoDecisionSelectionPort } from "@/lib/acquisition/orchestrator/acquisition-auto-decision.worker"
import { createUploadEmlAdmission } from "@/lib/acquisition/admission/upload-eml-consultations-admission"
import { handleAdminEmlUpload } from "@/lib/integration/connectors/upload-eml/handle-admin-eml-upload"
import { InboundSourceIdentityTx } from "@/lib/integration/persistence/inbound-source-identity.tx"
import { InboundSourceRepository } from "@/lib/integration/persistence/inbound-source.repository"
import { InboundSourceRuleRepository } from "@/lib/integration/persistence/inbound-source-rule.repository"
import { PipelineBindingRepository } from "@/lib/integration/persistence/pipeline-binding.repository"
import { InboundSourceWriteService } from "@/lib/integration/sources/inbound-source-write.service"
import { assertSafeDisposableTestDatabaseUrl, resolveIntegrationTestDatabaseUrl } from "./helpers/safe-test-database-url"

test("le fichier fictif traverse le normaliseur, le Router et l’admission PostgreSQL", async () => {
  const resolved = resolveIntegrationTestDatabaseUrl()
  assert.ok(resolved.ok)
  assertSafeDisposableTestDatabaseUrl(resolved.url)
  const db = new PrismaClient({ datasources: { db: { url: resolved.url } } })
  try {
    const company = await db.company.create({ data: { name: "Recette EML", slug: `eml-${randomUUID()}` } })
    const companyId = company.id
    const primary = await db.company.create({ data: { name: "Société principale fictive", slug: `eml-${randomUUID()}` } })
    const admin = await db.user.create({
      data: { companyId: primary.id, role: "EMPLOYEE", email: `admin-${randomUUID()}@example.invalid`, password: "fixture inutilisable" },
    })
    await db.employee.create({
      data: { companyId, userId: admin.id, role: "ADMIN", firstName: "Admin", lastName: "Fictif" },
    })
    const secondAdmin = await db.user.create({
      data: { companyId, role: "ADMIN", email: `admin-${randomUUID()}@example.invalid`, password: "fixture inutilisable" },
    })
    const connection = await db.integrationConnection.create({ data: {
      companyId, connectorType: "platform.upload.eml", displayName: "Import fictif",
      status: "ACTIVE", secretBackend: "PLATFORM_ENCRYPTED", config: {},
    } })
    const partner = await db.acquisitionPartner.create({ data: {
      companyId, name: "Partenaire fictif", code: "eml-test", connector: "UPLOAD",
    } })
    const sources = new InboundSourceWriteService(
      new InboundSourceRepository(db), new InboundSourceRuleRepository(db), new InboundSourceIdentityTx(db),
    )
    const source = await sources.createSource({ companyId, displayName: "Source fictive" })
    await sources.createRule({ companyId, sourceId: source.id, type: "SENDER_DOMAIN", value: "partenaire.example" })
    const bindings = new PipelineBindingRepository(db)
    const binding = await bindings.create({ companyId, sourceId: source.id, connectionId: connection.id })
    await bindings.setEnabled(companyId, binding.id, true)
    await sources.setSourceEnabled(companyId, source.id, true)

    const env: NodeJS.ProcessEnv = {
      NODE_ENV: "test",
      INTEGRATION_EML_UPLOAD_ENABLED: "true",
      INTEGRATION_PLATFORM_FOUNDATION_ENABLED: "true",
      INTEGRATION_ROUTING_ENABLED: "true",
      INTEGRATION_ROUTING_COMPANY_ALLOWLIST: companyId,
    }
    await db.integrationConnection.update({
      where: { id: connection.id },
      data: { config: { sourcePartners: [{ sourceId: source.id, partnerId: partner.id }] } },
    })

    async function admitFixture(domain: string, role = "ADMIN", requestEnv = env, raw?: string, actorId = admin.id) {
      const request = new Request("https://example.invalid/import", {
        method: "POST", headers: { "Content-Type": "message/rfc822", "X-Company-Id": "societe-injectee" },
        body: raw ?? `From: devis@${domain}\r\nSubject: Recette fictive\r\n\r\nTexte`,
      })
      return handleAdminEmlUpload(
        request, { id: actorId, companyId, role }, createUploadEmlAdmission(db, requestEnv), requestEnv,
      )
    }

    assert.equal((await admitFixture("partenaire.example", "CLIENT")).status, 403)
    assert.equal((await admitFixture("partenaire.example", "ADMIN", { ...env, INTEGRATION_EML_UPLOAD_ENABLED: "false" })).status, 404)
    const outside = await db.company.create({ data: { name: "Autre société fictive", slug: `eml-${randomUUID()}` } })
    const outsideRequest = new Request("https://example.invalid/import", {
      method: "POST", headers: { "Content-Type": "message/rfc822", "X-Company-Id": companyId },
      body: "From: devis@partenaire.example\r\n\r\nTexte",
    })
    const outsideEnv = { ...env, INTEGRATION_ROUTING_COMPANY_ALLOWLIST: `${companyId},${outside.id}` }
    const outsideResponse = await handleAdminEmlUpload(
      outsideRequest, { id: "admin-autre", companyId: outside.id, role: "ADMIN" },
      createUploadEmlAdmission(db, outsideEnv), outsideEnv,
    )
    assert.equal(outsideResponse.status, 409)
    assert.equal(await db.inboundEnvelope.count({ where: { companyId: outside.id } }), 0)

    const withAttachment = [
      "From: devis@partenaire.example", "Content-Type: multipart/mixed; boundary=eml", "",
      "--eml", "Content-Type: text/plain", "", "Texte", "--eml", "Content-Type: application/pdf",
      "Content-Disposition: attachment; filename=fictif.pdf", "", "%PDF-fictif", "--eml--",
    ].join("\r\n")
    const refused = await admitFixture("partenaire.example", "ADMIN", env, withAttachment)
    assert.equal(refused.status, 422)
    assert.deepEqual(await refused.json(), { outcome: "UPLOAD_ATTACHMENTS_UNAVAILABLE" })
    assert.equal(await db.inboundEnvelope.count({ where: { companyId } }), 0)
    const attempts = await Promise.all([admitFixture("partenaire.example"), admitFixture("partenaire.example")])
    assert.deepEqual(attempts.map((response) => response.status).sort(), [200, 201])
    const first = await attempts.find((response) => response.status === 201)!.json()
    assert.ok(first.outcome === "DRAFT_CREATED" && first.created)
    const replayResponse = await admitFixture("partenaire.example", "ADMIN", env, undefined, secondAdmin.id)
    assert.equal(replayResponse.status, 200)
    const replay = await replayResponse.json()
    assert.ok(replay.outcome === "DRAFT_CREATED" && !replay.created)
    assert.equal(replay.draftId, first.draftId)
    assert.deepEqual(await (await admitFixture("inconnu.example")).json(), { outcome: "NOT_ADMITTED" })
    assert.equal(await db.worksiteImportDraft.count({ where: { companyId } }), 1)
    const audit = await db.historyLog.findMany({ where: { companyId, entityType: "AcquisitionEmlImport" } })
    assert.equal(audit.length, 1)
    assert.equal(audit[0].actorId, admin.id)
    assert.equal(audit[0].entityId, (await db.acquisitionMessage.findFirstOrThrow({ where: { companyId } })).id)
    assert.equal(audit[0].detail, "DRAFT_CREATED")
    assert.equal(audit[0].oldValue, null)
    assert.equal(audit[0].newValue, null)
    assert.ok(audit[0].createdAt instanceof Date)
    const content = await db.acquisitionMessageContent.findFirstOrThrow({ where: { companyId } })
    assert.equal(content.normalizedText, "Texte")
  } finally {
    await db.$disconnect()
  }
})

test("cinq imports EML plus anciens ne prennent aucune place au brouillon Gmail éligible", async () => {
  const resolved = resolveIntegrationTestDatabaseUrl()
  assert.ok(resolved.ok)
  assertSafeDisposableTestDatabaseUrl(resolved.url)
  const db = new PrismaClient({ datasources: { db: { url: resolved.url } } })

  try {
    const { id: companyId } = await db.company.create({
      data: { name: "Sélection EML fictive", slug: `eml-ranking-${randomUUID()}` },
    })
    const sources = ["UPLOAD", "UPLOAD", "UPLOAD", "UPLOAD", "UPLOAD", "GMAIL"] as const
    let gmailDraftId: string | undefined
    for (const [index, source] of sources.entries()) {
      const date = new Date(Date.UTC(2026, 0, index + 1))
      const message = await db.acquisitionMessage.create({
        data: {
          companyId, source, externalMessageId: `message-${index}`,
          senderEmail: "devis@example.invalid", senderDomain: "example.invalid",
          subject: "Message fictif", receivedAt: date, status: "DRAFT_CREATED",
        },
      })
      const draft = await db.worksiteImportDraft.create({
        data: {
          companyId, acquisitionMessageId: message.id, status: "PENDING_REVIEW",
          updatedAt: date, version: 1, contentHashAtExtraction: "empreinte-fictive",
          extractionSchemaVersion: "2",
        },
      })
      await db.acquisitionDecisionJournal.create({
        data: {
          companyId, draftId: draft.id, decisionCode: "VALIDATION_PASS",
          reasons: [], scores: {}, idempotencyKey: `validation-${draft.id}`,
          metadata: { contentHash: "empreinte-fictive", extractionSchemaVersion: "2", draftVersion: 1 },
        },
      })
      if (source === "GMAIL") gmailDraftId = draft.id
    }
    assert.ok(gmailDraftId)
    const selection = createPrismaAutoDecisionSelectionPort(db)
    const candidates = await selection.listEligibleCandidates({ limit: 25, now: new Date(), maxPerCompany: 5 })
    assert.deepEqual(
      candidates.filter((candidate) => candidate.companyId === companyId).map((candidate) => candidate.draftId),
      [gmailDraftId],
    )
  } finally {
    await db.$disconnect()
  }
})
