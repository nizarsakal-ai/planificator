import { describe, it } from "node:test"
import assert from "node:assert/strict"
import {
  extractAttachmentMetadataFromPayload,
  getGmailHeader,
  parseReceivedAt,
} from "@/lib/acquisition/connector/gmail-mime-parser"

describe("gmail-mime-parser", () => {
  it("message sans pièce jointe", () => {
    const payload = {
      mimeType: "text/plain",
      body: { size: 120 },
    }
    assert.deepEqual(extractAttachmentMetadataFromPayload(payload), [])
  })

  it("pièce jointe avec attachmentId", () => {
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

  it("pièce jointe sans attachmentId mais avec partId", () => {
    const payload = {
      parts: [
        {
          partId: "2",
          mimeType: "image/png",
          filename: "plan.png",
          body: { size: 2048 },
        },
      ],
    }
    const attachments = extractAttachmentMetadataFromPayload(payload)
    assert.equal(attachments.length, 1)
    assert.equal(attachments[0].externalAttachmentId, undefined)
    assert.equal(attachments[0].partId, "2")
  })

  it("multipart imbriqué — ordre MIME stable", () => {
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
