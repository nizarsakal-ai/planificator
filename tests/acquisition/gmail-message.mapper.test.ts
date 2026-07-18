process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test"

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { mapGmailMessageToAcquisitionInput } from "@/lib/acquisition/connector/gmail-message.mapper"
import type { CanonicalMailMessage } from "@/lib/acquisition/connector/connector.types"
import { registerIncomingMessageSchema } from "@/lib/validations/acquisition"

const baseMessage = (): CanonicalMailMessage => ({
  externalMessageId: "gmail-msg-1",
  threadId: "thread-abc",
  fromHeader: "Carlene <carlenebourgine@lauralu.fr>",
  subject: "Nouveau chantier",
  receivedAt: new Date("2026-07-18T10:00:00.000Z"),
  labels: ["INBOX", "UNREAD"],
  snippet: "Bonjour, voici les infos…",
  attachments: [
    {
      externalAttachmentId: "att-gmail-1",
      partId: "1.2",
      filename: "plan.pdf",
      mimeType: "application/pdf",
      sizeBytes: 4096,
    },
    {
      partId: "1.3",
      filename: "photo.jpg",
      mimeType: "image/jpeg",
      sizeBytes: 2048,
    },
  ],
  providerMetadata: { historyId: "12345" },
})

describe("mapGmailMessageToAcquisitionInput", () => {
  it("fixe source GMAIL et conserve le fromHeader réel", () => {
    const input = mapGmailMessageToAcquisitionInput(baseMessage(), "company-1")
    assert.equal(input.source, "GMAIL")
    assert.equal(input.senderEmail, "Carlene <carlenebourgine@lauralu.fr>")
    assert.equal(input.companyId, "company-1")
    assert.equal(input.externalMessageId, "gmail-msg-1")
  })

  it("produit un input valide pour le schéma Zod Acquisition", () => {
    const parsed = registerIncomingMessageSchema.parse(
      mapGmailMessageToAcquisitionInput(baseMessage(), "company-1")
    )
    assert.equal(parsed.subject, "Nouveau chantier")
    assert.equal(parsed.attachments.length, 2)
  })

  it("conserve externalAttachmentId et partId des pièces jointes", () => {
    const parsed = registerIncomingMessageSchema.parse(
      mapGmailMessageToAcquisitionInput(baseMessage(), "company-1")
    )
    assert.equal(parsed.attachments[0].externalAttachmentId, "att-gmail-1")
    assert.equal(parsed.attachments[0].partId, "1.2")
    assert.equal(parsed.attachments[1].partId, "1.3")
    assert.equal(parsed.attachments[1].externalAttachmentId, undefined)
  })

  it("préserve l'ordre MIME des pièces jointes (ordinal stable)", () => {
    const parsed = registerIncomingMessageSchema.parse(
      mapGmailMessageToAcquisitionInput(baseMessage(), "company-1")
    )
    assert.deepEqual(
      parsed.attachments.map((a) => a.filename),
      ["plan.pdf", "photo.jpg"]
    )
  })

  it("n propage aucune donnée secrète dans rawMetadata", () => {
    const msg = baseMessage()
    msg.providerMetadata = {
      historyId: "99",
      accessToken: "secret-token",
      refreshToken: "refresh-secret",
      authorization: "Bearer xxx",
    }
    const input = mapGmailMessageToAcquisitionInput(msg, "company-1")
    const meta = input.rawMetadata as Record<string, unknown>
    assert.equal(meta.historyId, "99")
    assert.equal(meta.accessToken, undefined)
    assert.equal(meta.refreshToken, undefined)
    assert.equal(meta.authorization, undefined)
    assert.deepEqual(meta.labels, ["INBOX", "UNREAD"])
    assert.equal(meta.threadId, "thread-abc")
  })
})
