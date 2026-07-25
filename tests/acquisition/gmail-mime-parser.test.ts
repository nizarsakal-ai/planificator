import { describe, it } from "node:test"
import assert from "node:assert/strict"
import {
  buildDeterministicAttachmentFilename,
  extractAttachmentMetadataFromPayload,
  getGmailHeader,
  isDownloadableGmailAttachmentPart,
  parseReceivedAt,
  sanitizeAttachmentFilename,
} from "@/lib/acquisition/connector/gmail-mime-parser"
import { mapGmailMessageToAcquisitionInput } from "@/lib/acquisition/connector/gmail-message.mapper"
import { registerIncomingMessageSchema } from "@/lib/validations/acquisition"
import type { CanonicalMailMessage } from "@/lib/acquisition/connector/connector.types"

describe("gmail-mime-parser", () => {
  it("message sans pièce jointe", () => {
    const payload = {
      mimeType: "text/plain",
      body: { size: 120 },
    }
    assert.deepEqual(extractAttachmentMetadataFromPayload(payload), [])
  })

  it("attachment réel : attachmentId + filename conservés", () => {
    const payload = {
      parts: [
        {
          partId: "1",
          mimeType: "application/pdf",
          filename: "devis.pdf",
          body: { attachmentId: "ANGjdJ8x", size: 4096 },
        },
      ],
    }
    const attachments = extractAttachmentMetadataFromPayload(payload)
    assert.equal(attachments.length, 1)
    assert.equal(attachments[0].externalAttachmentId, "ANGjdJ8x")
    assert.equal(attachments[0].partId, "1")
    assert.equal(attachments[0].filename, "devis.pdf")
    assert.equal(attachments[0].sizeBytes, 4096)
  })

  it("attachmentId vide / absent → entrée ignorée", () => {
    const payload = {
      parts: [
        {
          partId: "2",
          mimeType: "image/png",
          filename: "plan.png",
          body: { size: 2048 },
        },
        {
          partId: "3",
          mimeType: "image/jpeg",
          filename: "inline.jpg",
          body: { attachmentId: "", size: 100 },
        },
        {
          partId: "4",
          mimeType: "image/gif",
          filename: "spaces.jpg",
          body: { attachmentId: "   ", size: 100 },
        },
      ],
    }
    assert.deepEqual(extractAttachmentMetadataFromPayload(payload), [])
  })

  it("filename vide + attachmentId valide → nom déterministe", () => {
    const payload = {
      parts: [
        {
          partId: "1.2",
          mimeType: "application/pdf",
          filename: "",
          body: { attachmentId: "ATT-EMPTY-NAME", size: 50 },
        },
      ],
    }
    const attachments = extractAttachmentMetadataFromPayload(payload)
    assert.equal(attachments.length, 1)
    assert.equal(attachments[0].externalAttachmentId, "ATT-EMPTY-NAME")
    assert.equal(attachments[0].filename, "attachment-1.2.pdf")
    registerIncomingMessageSchema.parse({
      companyId: "c1",
      source: "GMAIL",
      externalMessageId: "m1",
      senderEmail: "a@lauralu.fr",
      subject: "",
      receivedAt: new Date(),
      attachments,
    })
  })

  it("deux pseudo-attachments invalides → ignorés ; Zod OK sur message", () => {
    const payload = {
      mimeType: "multipart/mixed",
      parts: [
        {
          partId: "0",
          mimeType: "text/html",
          filename: "",
          body: { attachmentId: "", size: 10 },
        },
        {
          partId: "1",
          mimeType: "image/png",
          filename: "cid-image.png",
          // inline-like : filename présent, pas d'attachmentId Gmail
          body: { size: 20 },
        },
        {
          partId: "2",
          mimeType: "application/pdf",
          filename: "real.pdf",
          body: { attachmentId: "REAL-1", size: 99 },
        },
      ],
    }
    const attachments = extractAttachmentMetadataFromPayload(payload)
    assert.equal(attachments.length, 1)
    assert.equal(attachments[0].filename, "real.pdf")
    const input = mapGmailMessageToAcquisitionInput(
      {
        externalMessageId: "gmail-poison-fix",
        threadId: "t1",
        fromHeader: "ops@lauralu.fr",
        subject: "ok",
        receivedAt: new Date("2026-07-25T00:00:00.000Z"),
        labels: [],
        snippet: null,
        attachments,
        providerMetadata: {},
      },
      "company-1"
    )
    const parsed = registerIncomingMessageSchema.parse(input)
    assert.equal(parsed.attachments.length, 1)
  })

  it("image inline / part MIME sans attachmentId → non persistée", () => {
    const payload = {
      parts: [
        {
          partId: "1",
          mimeType: "image/png",
          filename: "logo.png",
          headers: [{ name: "Content-ID", value: "<logo@mail>" }],
          body: { size: 512 },
        },
      ],
    }
    assert.equal(isDownloadableGmailAttachmentPart(payload.parts[0]), false)
    assert.deepEqual(extractAttachmentMetadataFromPayload(payload), [])
  })

  it("multipart imbriqué — vraies PJ conservées, ordre stable", () => {
    const payload = {
      mimeType: "multipart/mixed",
      parts: [
        { partId: "0", mimeType: "text/plain", body: { size: 10 } },
        {
          partId: "1",
          mimeType: "multipart/alternative",
          parts: [
            { partId: "1.1", mimeType: "text/plain", body: { size: 5 } },
            {
              partId: "1.2",
              mimeType: "application/pdf",
              filename: "a.pdf",
              body: { attachmentId: "A1", size: 100 },
            },
          ],
        },
        {
          partId: "2",
          mimeType: "application/zip",
          filename: "b.zip",
          body: { attachmentId: "B1", size: 200 },
        },
      ],
    }
    const attachments = extractAttachmentMetadataFromPayload(payload)
    assert.deepEqual(
      attachments.map((a) => a.filename),
      ["a.pdf", "b.zip"]
    )
    assert.equal(attachments[0].partId, "1.2")
    assert.equal(attachments[1].partId, "2")
  })

  it("stabilité : même payload → mêmes filenames/keys ; retry sans doublon", () => {
    const payload = {
      parts: [
        {
          partId: "9",
          mimeType: "image/jpeg",
          filename: "",
          body: { attachmentId: "STABLE-ID", size: 1 },
        },
        {
          partId: "9",
          mimeType: "image/jpeg",
          filename: "",
          body: { attachmentId: "STABLE-ID", size: 1 },
        },
      ],
    }
    const a = extractAttachmentMetadataFromPayload(payload)
    const b = extractAttachmentMetadataFromPayload(payload)
    assert.equal(a.length, 1)
    assert.deepEqual(a, b)
    assert.equal(a[0].filename, "attachment-9.jpg")
    // Clé stable alignée sur buildAttachmentKey (ext:<id>) — sans importer le service Prisma.
    assert.equal(`ext:${a[0].externalAttachmentId}`, "ext:STABLE-ID")
    assert.equal(`ext:${b[0].externalAttachmentId}`, "ext:STABLE-ID")
  })

  it("sanitize filename : strip path, conserve basename", () => {
    assert.equal(sanitizeAttachmentFilename("../../etc/passwd.pdf"), "passwd.pdf")
    assert.equal(sanitizeAttachmentFilename("  "), "")
    assert.equal(
      buildDeterministicAttachmentFilename({
        partId: "2",
        ordinal: 0,
        mimeType: "application/pdf",
      }),
      "attachment-2.pdf"
    )
  })

  it("ignore les parties inline sans filename ni attachmentId", () => {
    const payload = {
      parts: [
        { partId: "0", mimeType: "text/html", body: { size: 500, data: "PGh0bWw+" } },
      ],
    }
    assert.deepEqual(extractAttachmentMetadataFromPayload(payload), [])
  })

  it("évite les doublons de parts", () => {
    const part = {
      partId: "1",
      mimeType: "application/pdf",
      filename: "dup.pdf",
      body: { attachmentId: "SAME", size: 100 },
    }
    const payload = { parts: [part, { ...part }] }
    assert.equal(extractAttachmentMetadataFromPayload(payload).length, 1)
  })

  it("getGmailHeader insensible à la casse", () => {
    assert.equal(
      getGmailHeader([{ name: "From", value: "a@lauralu.fr" }], "from"),
      "a@lauralu.fr"
    )
  })

  it("parseReceivedAt préfère internalDate", () => {
    const d = parseReceivedAt("1720000000000", "Mon, 1 Jan 2024 00:00:00 +0000")
    assert.equal(d.toISOString(), new Date(1720000000000).toISOString())
  })
})

describe("mapGmailMessageToAcquisitionInput — attachments", () => {
  const base = (attachments: CanonicalMailMessage["attachments"]): CanonicalMailMessage => ({
    externalMessageId: "gmail-msg-1",
    threadId: "thread-abc",
    fromHeader: "Carlene <carlenebourgine@lauralu.fr>",
    subject: "Nouveau chantier",
    receivedAt: new Date("2026-07-18T10:00:00.000Z"),
    labels: ["INBOX"],
    snippet: null,
    attachments,
    providerMetadata: {},
  })

  it("filtre les PJ sans attachmentId (défense mapper)", () => {
    const parsed = registerIncomingMessageSchema.parse(
      mapGmailMessageToAcquisitionInput(
        base([
          {
            externalAttachmentId: "att-1",
            partId: "1",
            filename: "plan.pdf",
            mimeType: "application/pdf",
            sizeBytes: 10,
          },
          {
            partId: "2",
            filename: "orphan.jpg",
            mimeType: "image/jpeg",
            sizeBytes: 5,
          },
          {
            externalAttachmentId: "",
            partId: "3",
            filename: "",
            mimeType: "image/png",
            sizeBytes: 1,
          },
        ]),
        "company-1"
      )
    )
    assert.equal(parsed.attachments.length, 1)
    assert.equal(parsed.attachments[0].filename, "plan.pdf")
  })

  it("filename vide + id valide → nom généré, Zod OK", () => {
    const parsed = registerIncomingMessageSchema.parse(
      mapGmailMessageToAcquisitionInput(
        base([
          {
            externalAttachmentId: "att-x",
            partId: "7",
            filename: "",
            mimeType: "image/png",
            sizeBytes: 3,
          },
        ]),
        "company-1"
      )
    )
    assert.equal(parsed.attachments[0].filename, "attachment-7.png")
  })

  it("message sans attachment inchangé", () => {
    const parsed = registerIncomingMessageSchema.parse(
      mapGmailMessageToAcquisitionInput(base([]), "company-1")
    )
    assert.deepEqual(parsed.attachments, [])
  })
})
