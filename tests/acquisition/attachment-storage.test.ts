process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test"

import { describe, it, afterEach } from "node:test"
import assert from "node:assert/strict"
import { v2 as cloudinary } from "cloudinary"
import {
  CloudinaryAttachmentStorageAdapter,
  isCloudinaryExistingAssetResponse,
  isCloudinaryStorageCollisionError,
} from "@/lib/acquisition/attachments/attachment-storage.port"

describe("Cloudinary collision detection", () => {
  it("http_code 409 = collision (champ structuré SDK)", () => {
    assert.equal(isCloudinaryStorageCollisionError({ http_code: 409, message: "x", name: "Error" }), true)
  })

  it("http_code 400 sans 409 ≠ collision", () => {
    assert.equal(isCloudinaryStorageCollisionError({ http_code: 400, message: "x", name: "Error" }), false)
  })

  it("existing:true = réponse collision documentée", () => {
    assert.equal(isCloudinaryExistingAssetResponse({ existing: true, public_id: "pid" }), true)
    assert.equal(isCloudinaryExistingAssetResponse({ existing: false }), false)
  })
})

describe("CloudinaryAttachmentStorageAdapter", () => {
  const originalUploadStream = cloudinary.uploader.upload_stream
  const originalDestroy = cloudinary.uploader.destroy

  afterEach(() => {
    cloudinary.uploader.upload_stream = originalUploadStream
    cloudinary.uploader.destroy = originalDestroy
  })

  it("store retourne created:true sur upload réussi", async () => {
    cloudinary.uploader.upload_stream = ((_opts, cb) => {
      const stream = {
        end: () => {
          if (!cb) return
          cb(undefined, {
            secure_url: "https://res.cloudinary.com/demo/raw/upload/v1/test/file",
            public_id: "planificator/co/acquisition/msg/att/file",
          } as Parameters<NonNullable<typeof cb>>[1])
        },
      }
      return stream as ReturnType<typeof cloudinary.uploader.upload_stream>
    }) as typeof cloudinary.uploader.upload_stream

    const adapter = new CloudinaryAttachmentStorageAdapter()
    const result = await adapter.store({
      companyId: "co",
      acquisitionMessageId: "msg",
      attachmentId: "att",
      buffer: Buffer.from("%PDF"),
      mimeType: "application/pdf",
      generatedFilename: "att-abc.pdf",
    })
    assert.equal(result.created, true)
    assert.ok(result.storageUrl)
  })

  it("store retourne created:false si existing:true (overwrite:false)", async () => {
    cloudinary.uploader.upload_stream = ((_opts, cb) => {
      const stream = {
        end: () => {
          if (!cb) return
          cb(undefined, {
            existing: true,
            public_id: "planificator/co/acquisition/msg/att/att-abc",
            secure_url: "https://res.cloudinary.com/demo/existing",
          } as unknown as Parameters<NonNullable<typeof cb>>[1])
        },
      }
      return stream as ReturnType<typeof cloudinary.uploader.upload_stream>
    }) as typeof cloudinary.uploader.upload_stream

    const adapter = new CloudinaryAttachmentStorageAdapter()
    const result = await adapter.store({
      companyId: "co",
      acquisitionMessageId: "msg",
      attachmentId: "att",
      buffer: Buffer.from("%PDF"),
      mimeType: "application/pdf",
      generatedFilename: "att-abc.pdf",
    })
    assert.equal(result.created, false)
    assert.equal(result.storageUrl, undefined)
    assert.equal(result.storagePublicId, "planificator/co/acquisition/msg/att/att-abc")
  })

  it("store retourne created:false si http_code 409 structuré", async () => {
    cloudinary.uploader.upload_stream = ((_opts, cb) => {
      const stream = {
        end: () => {
          if (!cb) return
          cb(undefined, {
            error: { http_code: 409, message: "Already exists", name: "Error" },
          } as unknown as Parameters<NonNullable<typeof cb>>[1])
        },
      }
      return stream as ReturnType<typeof cloudinary.uploader.upload_stream>
    }) as typeof cloudinary.uploader.upload_stream

    const adapter = new CloudinaryAttachmentStorageAdapter()
    const result = await adapter.store({
      companyId: "co",
      acquisitionMessageId: "msg",
      attachmentId: "att",
      buffer: Buffer.from("%PDF"),
      mimeType: "application/pdf",
      generatedFilename: "att-abc.pdf",
    })
    assert.equal(result.created, false)
    assert.match(result.storagePublicId, /planificator\/co\/acquisition\/msg\/att\/att-abc$/)
  })

  it("erreur Cloudinary non structurée → ATTACHMENT_STORAGE_FAILED", async () => {
    cloudinary.uploader.upload_stream = ((_opts, cb) => {
      const stream = {
        end: () => {
          if (!cb) return
          cb(new Error("network down") as Parameters<typeof cb>[0], undefined)
        },
      }
      return stream as ReturnType<typeof cloudinary.uploader.upload_stream>
    }) as typeof cloudinary.uploader.upload_stream

    const adapter = new CloudinaryAttachmentStorageAdapter()
    await assert.rejects(
      () =>
        adapter.store({
          companyId: "co",
          acquisitionMessageId: "msg",
          attachmentId: "att",
          buffer: Buffer.from("%PDF"),
          mimeType: "application/pdf",
          generatedFilename: "att-abc.pdf",
        }),
      /ATTACHMENT_STORAGE_FAILED/
    )
  })

  it("destroy considère not found comme succès", async () => {
    cloudinary.uploader.destroy = (async () => ({ result: "not found" })) as typeof cloudinary.uploader.destroy
    const adapter = new CloudinaryAttachmentStorageAdapter()
    await assert.doesNotReject(async () => adapter.destroy({ storagePublicId: "missing-id" }))
  })
})
