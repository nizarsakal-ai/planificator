process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test"

import { describe, it, afterEach, beforeEach } from "node:test"
import assert from "node:assert/strict"
import { v2 as cloudinary } from "cloudinary"
import {
  CloudinaryAttachmentStorageAdapter,
  isCloudinaryExistingAssetResponse,
  isCloudinaryStorageCollisionError,
} from "@/lib/acquisition/attachments/attachment-storage.port"
import { ACQUISITION_ATTACHMENT_CLOUDINARY_FOLDER_PREFIX_ENV } from "@/lib/acquisition/attachments/attachment-cloudinary-folder-prefix"

const ENV_KEY = ACQUISITION_ATTACHMENT_CLOUDINARY_FOLDER_PREFIX_ENV

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
  const previousPrefix = process.env[ENV_KEY]

  beforeEach(() => {
    delete process.env[ENV_KEY]
  })

  afterEach(() => {
    cloudinary.uploader.upload_stream = originalUploadStream
    cloudinary.uploader.destroy = originalDestroy
    if (previousPrefix === undefined) delete process.env[ENV_KEY]
    else process.env[ENV_KEY] = previousPrefix
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

  it("store Production historique : folder planificator/... + raw + authenticated", async () => {
    let captured: Record<string, unknown> | undefined
    cloudinary.uploader.upload_stream = ((opts, cb) => {
      captured = opts as Record<string, unknown>
      const stream = {
        end: () => {
          if (!cb) return
          cb(undefined, {
            secure_url: "https://res.cloudinary.com/demo/raw/authenticated/v1/file",
            public_id: "planificator/co/acquisition/msg/att/att-abc",
          } as Parameters<NonNullable<typeof cb>>[1])
        },
      }
      return stream as ReturnType<typeof cloudinary.uploader.upload_stream>
    }) as typeof cloudinary.uploader.upload_stream

    const adapter = new CloudinaryAttachmentStorageAdapter()
    await adapter.store({
      companyId: "co",
      acquisitionMessageId: "msg",
      attachmentId: "att",
      buffer: Buffer.from("%PDF"),
      mimeType: "application/pdf",
      generatedFilename: "att-abc.pdf",
    })

    assert.equal(captured?.folder, "planificator/co/acquisition/msg/att")
    assert.equal(captured?.resource_type, "raw")
    assert.equal(captured?.type, "authenticated")
  })

  it("store staging : chemin exact planificator-staging/{companyId}/acquisition/...", async () => {
    process.env[ENV_KEY] = "planificator-staging"
    let captured: Record<string, unknown> | undefined
    cloudinary.uploader.upload_stream = ((opts, cb) => {
      captured = opts as Record<string, unknown>
      const stream = {
        end: () => {
          if (!cb) return
          cb(undefined, {
            secure_url: "https://res.cloudinary.com/demo/raw/authenticated/v1/file",
            public_id:
              "planificator-staging/company-a/acquisition/msg-9/att-9/att-abc",
          } as Parameters<NonNullable<typeof cb>>[1])
        },
      }
      return stream as ReturnType<typeof cloudinary.uploader.upload_stream>
    }) as typeof cloudinary.uploader.upload_stream

    const adapter = new CloudinaryAttachmentStorageAdapter()
    await adapter.store({
      companyId: "company-a",
      acquisitionMessageId: "msg-9",
      attachmentId: "att-9",
      buffer: Buffer.from("%PDF"),
      mimeType: "application/pdf",
      generatedFilename: "att-abc.pdf",
    })

    assert.equal(
      captured?.folder,
      "planificator-staging/company-a/acquisition/msg-9/att-9"
    )
    assert.equal(captured?.resource_type, "raw")
    assert.equal(captured?.type, "authenticated")
  })

  it("préfixe invalide rejette avant tout appel Cloudinary", async () => {
    process.env[ENV_KEY] = "Planificator/Staging"
    let uploadCalled = false
    cloudinary.uploader.upload_stream = ((opts, cb) => {
      uploadCalled = true
      const stream = {
        end: () => {
          if (!cb) return
          cb(undefined, {
            secure_url: "https://x",
            public_id: "x",
          } as Parameters<NonNullable<typeof cb>>[1])
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
      /ATTACHMENT_CLOUDINARY_FOLDER_PREFIX_INVALID/
    )
    assert.equal(uploadCalled, false)
  })

  it("préfixe vide rejette avant tout appel Cloudinary", async () => {
    process.env[ENV_KEY] = ""
    let uploadCalled = false
    cloudinary.uploader.upload_stream = ((_opts, cb) => {
      uploadCalled = true
      const stream = {
        end: () => {
          if (!cb) return
          cb(undefined, {
            secure_url: "https://x",
            public_id: "x",
          } as Parameters<NonNullable<typeof cb>>[1])
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
      /ATTACHMENT_CLOUDINARY_FOLDER_PREFIX_INVALID/
    )
    assert.equal(uploadCalled, false)
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

  it("store retourne created:false si err Cloudinary direct http_code 409", async () => {
    cloudinary.uploader.upload_stream = ((_opts, cb) => {
      const stream = {
        end: () => {
          if (!cb) return
          cb(
            {
              http_code: 409,
              message: "Already exists",
              name: "Error",
            } as Parameters<typeof cb>[0],
            undefined
          )
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
    assert.match(
      result.storagePublicId,
      /planificator\/co\/acquisition\/msg\/att\/att-abc$/
    )
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

  it("destroy d'un ancien public_id inchangé (indépendant du préfixe env)", async () => {
    process.env[ENV_KEY] = "planificator-staging"
    const destroyCalls: Array<{ publicId: string; options: Record<string, unknown> }> = []
    cloudinary.uploader.destroy = (async (publicId, options) => {
      destroyCalls.push({ publicId, options: (options ?? {}) as Record<string, unknown> })
      return { result: "ok" }
    }) as typeof cloudinary.uploader.destroy

    const adapter = new CloudinaryAttachmentStorageAdapter()
    const legacyPublicId = "planificator/co-1/acquisition/msg-1/att-1/file-old"
    await adapter.destroy({ storagePublicId: legacyPublicId })

    assert.equal(destroyCalls.length, 1)
    assert.equal(destroyCalls[0]?.publicId, legacyPublicId)
    assert.equal(destroyCalls[0]?.options.resource_type, "raw")
    assert.equal(destroyCalls[0]?.options.type, "authenticated")
  })

  it("destroy considère not found comme succès", async () => {
    cloudinary.uploader.destroy = (async () => ({ result: "not found" })) as typeof cloudinary.uploader.destroy
    const adapter = new CloudinaryAttachmentStorageAdapter()
    await assert.doesNotReject(async () => adapter.destroy({ storagePublicId: "missing-id" }))
  })
})
