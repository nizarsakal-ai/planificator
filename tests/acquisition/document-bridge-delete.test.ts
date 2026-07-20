process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test"

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { shouldDestroyCloudinaryOnDocumentDelete } from "@/lib/documents/document-delete.policy"

describe("document bridge delete policy", () => {
  it("bridgé → aucun destroy", () => {
    assert.equal(
      shouldDestroyCloudinaryOnDocumentDelete({
        sourceAcquisitionAttachmentId: "att-1",
        url: null,
      }),
      false
    )
  })

  it("upload classique cloudinary → destroy autorisé", () => {
    assert.equal(
      shouldDestroyCloudinaryOnDocumentDelete({
        sourceAcquisitionAttachmentId: null,
        url: "https://res.cloudinary.com/demo/image/upload/v1/x.pdf",
      }),
      true
    )
  })

  it("url null sans bridge → pas de destroy", () => {
    assert.equal(
      shouldDestroyCloudinaryOnDocumentDelete({
        sourceAcquisitionAttachmentId: null,
        url: null,
      }),
      false
    )
  })

  it("storagePublicId seul sans bridge id → destroy si url cloudinary", () => {
    assert.equal(
      shouldDestroyCloudinaryOnDocumentDelete({
        sourceAcquisitionAttachmentId: null,
        url: "https://res.cloudinary.com/demo/raw/upload/v1/file.pdf",
      }),
      true
    )
  })
})
