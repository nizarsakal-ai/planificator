process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test"

import { describe, it, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import type { Role } from "@prisma/client"
import type {
  AttachmentAccessAuditRepositoryPort,
  AttachmentAccessFetcherPort,
  AttachmentAccessRepositoryPort,
  AttachmentUrlSignerPort,
} from "@/lib/acquisition/access/attachment-access.port"
import {
  accessAcquisitionAttachment,
  buildAccessResponseHeaders,
  mapAccessResultToStatus,
} from "@/lib/acquisition/access/attachment-access.service"
import type {
  AttachmentAccessContext,
  ConsultableAttachmentRecord,
} from "@/lib/acquisition/access/attachment-access.types"
import { getSignedUrlTtlSeconds } from "@/lib/acquisition/access/attachment-access.types"
import { CloudinaryAttachmentUrlSigner } from "@/lib/acquisition/access/attachment-url-signer"
import { v2 as cloudinary } from "cloudinary"

const STORED: ConsultableAttachmentRecord = {
  id: "att-1",
  companyId: "co-1",
  filename: "plan.pdf",
  mimeType: "application/pdf",
  sizeBytes: 100,
  storagePublicId: "planificator/co-1/acquisition/msg/att/file",
  sha256: "abc123",
  storedAt: new Date("2026-01-01"),
}

function adminContext(overrides: Partial<AttachmentAccessContext> = {}): AttachmentAccessContext {
  return {
    userId: "user-1",
    role: "ADMIN" as Role,
    companyId: "co-1",
    ...overrides,
  }
}

function streamBody(content = "pdf-bytes"): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(content))
      controller.close()
    },
  })
}

describe("attachment-access.service", () => {
  const envBackup = {
    acquisition: process.env.PLANIFICATOR_ACQUISITION_ENABLED,
    access: process.env.ACQUISITION_ATTACHMENT_ACCESS_ENABLED,
    ttl: process.env.ACQUISITION_ATTACHMENT_SIGNED_URL_TTL_SECONDS,
  }

  beforeEach(() => {
    process.env.PLANIFICATOR_ACQUISITION_ENABLED = "true"
    process.env.ACQUISITION_ATTACHMENT_ACCESS_ENABLED = "true"
    delete process.env.ACQUISITION_ATTACHMENT_SIGNED_URL_TTL_SECONDS
  })

  afterEach(() => {
    process.env.PLANIFICATOR_ACQUISITION_ENABLED = envBackup.acquisition
    process.env.ACQUISITION_ATTACHMENT_ACCESS_ENABLED = envBackup.access
    if (envBackup.ttl === undefined) delete process.env.ACQUISITION_ATTACHMENT_SIGNED_URL_TTL_SECONDS
    else process.env.ACQUISITION_ATTACHMENT_SIGNED_URL_TTL_SECONDS = envBackup.ttl
  })

  it("flag désactivé → DISABLED", async () => {
    process.env.ACQUISITION_ATTACHMENT_ACCESS_ENABLED = "false"
    const r = await accessAcquisitionAttachment(
      { context: adminContext(), attachmentId: "att-1", mode: "VIEW" },
      { repository: mockRepo({ find: async () => STORED }) }
    )
    assert.equal(r.kind, "DISABLED")
  })

  it("session absente → UNAUTHORIZED", async () => {
    const r = await accessAcquisitionAttachment(
      { context: { userId: "", role: "ADMIN", companyId: "co-1" }, attachmentId: "att-1", mode: "VIEW" },
      { repository: mockRepo({}) }
    )
    assert.equal(r.kind, "UNAUTHORIZED")
  })

  it("ADMIN autorisé", async () => {
    const r = await accessAcquisitionAttachment(
      { context: adminContext({ role: "ADMIN" }), attachmentId: "att-1", mode: "VIEW" },
      depsWithStored()
    )
    assert.equal(r.kind, "OK")
  })

  it("TEAM_LEADER autorisé", async () => {
    const r = await accessAcquisitionAttachment(
      { context: adminContext({ role: "TEAM_LEADER" }), attachmentId: "att-1", mode: "VIEW" },
      depsWithStored()
    )
    assert.equal(r.kind, "OK")
  })

  it("EMPLOYEE refusé", async () => {
    const r = await accessAcquisitionAttachment(
      { context: adminContext({ role: "EMPLOYEE" }), attachmentId: "att-1", mode: "VIEW" },
      { repository: mockRepo({ find: async () => STORED }) }
    )
    assert.equal(r.kind, "FORBIDDEN")
  })

  it("CLIENT refusé", async () => {
    const r = await accessAcquisitionAttachment(
      { context: adminContext({ role: "CLIENT" }), attachmentId: "att-1", mode: "VIEW" },
      { repository: mockRepo({ find: async () => STORED }) }
    )
    assert.equal(r.kind, "FORBIDDEN")
  })

  it("SUPER_ADMIN sans companyId refusé", async () => {
    const r = await accessAcquisitionAttachment(
      { context: adminContext({ role: "SUPER_ADMIN", companyId: null }), attachmentId: "att-1", mode: "VIEW" },
      { repository: mockRepo({ find: async () => STORED }) }
    )
    assert.equal(r.kind, "FORBIDDEN")
  })

  it("SUPER_ADMIN avec companyId session autorisé", async () => {
    const r = await accessAcquisitionAttachment(
      { context: adminContext({ role: "SUPER_ADMIN", companyId: "co-1" }), attachmentId: "att-1", mode: "VIEW" },
      depsWithStored()
    )
    assert.equal(r.kind, "OK")
  })

  it("tenant A accède à son attachment STORED", async () => {
    const r = await accessAcquisitionAttachment(
      { context: adminContext({ companyId: "co-A" }), attachmentId: "att-A", mode: "VIEW" },
      depsWithStored({ ...STORED, id: "att-A", companyId: "co-A" })
    )
    assert.equal(r.kind, "OK")
  })

  it("tenant A tente id tenant B → NOT_FOUND + audit DENIED", async () => {
    const audits: unknown[] = []
    const r = await accessAcquisitionAttachment(
      { context: adminContext({ companyId: "co-A" }), attachmentId: "att-B", mode: "VIEW" },
      {
        repository: mockRepo({ find: async () => null }),
        auditRepository: mockAudit(audits),
      }
    )
    assert.equal(r.kind, "NOT_FOUND")
    assert.equal(audits.length, 1)
    assert.deepEqual((audits[0] as { outcome: string }).outcome, "DENIED")
    assert.equal((audits[0] as { attachmentId: string | null }).attachmentId, null)
    assert.equal((audits[0] as { companyId: string }).companyId, "co-A")
  })

  it("attachment non STORED → NOT_FOUND via repository", async () => {
    const r = await accessAcquisitionAttachment(
      { context: adminContext(), attachmentId: "att-1", mode: "VIEW" },
      {
        repository: mockRepo({ find: async () => null }),
        auditRepository: mockAudit([]),
      }
    )
    assert.equal(r.kind, "NOT_FOUND")
  })

  it("signature Cloudinary raw + authenticated + TTL", async () => {
    const original = cloudinary.utils.private_download_url
    const captured: {
      publicId: string
      format: string
      options: Record<string, unknown>
    }[] = []
    cloudinary.utils.private_download_url = ((publicId, format, options) => {
      captured.push({ publicId, format, options: options as Record<string, unknown> })
      return "https://api.cloudinary.com/v1_1/demo/raw/authenticated/signed"
    }) as typeof cloudinary.utils.private_download_url

    try {
      const signer = new CloudinaryAttachmentUrlSigner()
      const expiresAt = new Date("2026-07-19T00:00:00Z")
      expiresAt.setSeconds(expiresAt.getSeconds() + 120)
      await signer.createSignedUrl({ storagePublicId: "pid/file.pdf", expiresAt })
      assert.equal(captured[0]?.publicId, "pid/file.pdf")
      assert.equal(captured[0]?.format, "")
      assert.equal(captured[0]?.options.resource_type, "raw")
      assert.equal(captured[0]?.options.type, "authenticated")
      assert.ok(captured[0]?.options.expires_at)
    } finally {
      cloudinary.utils.private_download_url = original
    }
  })

  it("VIEW → inline Content-Disposition", async () => {
    const headers = buildAccessResponseHeaders({
      kind: "OK",
      stream: streamBody(),
      filename: "plan.pdf",
      mimeType: "application/pdf",
      contentLength: 9,
      mode: "VIEW",
    })
    assert.match(headers["Content-Disposition"], /^inline/)
  })

  it("DOWNLOAD → attachment Content-Disposition", async () => {
    const headers = buildAccessResponseHeaders({
      kind: "OK",
      stream: streamBody(),
      filename: "plan.pdf",
      mimeType: "application/pdf",
      contentLength: 9,
      mode: "DOWNLOAD",
    })
    assert.match(headers["Content-Disposition"], /^attachment/)
  })

  it("audit GRANTED écrit avant flux", async () => {
    const audits: unknown[] = []
    const r = await accessAcquisitionAttachment(
      { context: adminContext(), attachmentId: "att-1", mode: "VIEW" },
      depsWithStored(undefined, audits)
    )
    assert.equal(r.kind, "OK")
    assert.equal(audits.length, 1)
    assert.equal((audits[0] as { outcome: string }).outcome, "GRANTED")
  })

  it("échec audit GRANTED → SERVICE_UNAVAILABLE sans flux utilisable", async () => {
    let cancelCalls = 0
    const r = await accessAcquisitionAttachment(
      { context: adminContext(), attachmentId: "att-1", mode: "VIEW" },
      {
        ...depsWithStored(),
        fetcher: {
          fetchSignedResource: async () => ({
            ok: true,
            status: 200,
            body: new ReadableStream({
              cancel() {
                cancelCalls += 1
                return Promise.resolve()
              },
            }),
            contentLength: 8,
          }),
        },
        auditRepository: {
          record: async () => {
            throw new Error("db down")
          },
        },
      }
    )
    assert.equal(r.kind, "SERVICE_UNAVAILABLE")
    assert.equal(mapAccessResultToStatus(r), 503)
    assert.equal(cancelCalls, 1)
  })

  it("fetch Cloudinary échoué → BAD_GATEWAY", async () => {
    const r = await accessAcquisitionAttachment(
      { context: adminContext(), attachmentId: "att-1", mode: "VIEW" },
      {
        ...depsWithStored(),
        fetcher: {
          fetchSignedResource: async () => ({ ok: false, status: 502, body: null, contentLength: null }),
        },
      }
    )
    assert.equal(r.kind, "BAD_GATEWAY")
  })

  it("utilise ReadableStream sans arrayBuffer", async () => {
    let fetchCalled = false
    const r = await accessAcquisitionAttachment(
      { context: adminContext(), attachmentId: "att-1", mode: "VIEW" },
      {
        ...depsWithStored(),
        fetcher: {
          fetchSignedResource: async () => {
            fetchCalled = true
            return { ok: true, status: 200, body: streamBody(), contentLength: 8 }
          },
        },
      }
    )
    assert.equal(r.kind, "OK")
    assert.ok(fetchCalled)
    if (r.kind === "OK") {
      assert.ok(r.stream instanceof ReadableStream)
      const reader = r.stream.getReader()
      const chunk = await reader.read()
      assert.ok(chunk.value)
      await reader.cancel()
    }
  })

  it("TTL borné entre 30 et 300 secondes", () => {
    process.env.ACQUISITION_ATTACHMENT_SIGNED_URL_TTL_SECONDS = "10"
    assert.equal(getSignedUrlTtlSeconds(), 30)
    process.env.ACQUISITION_ATTACHMENT_SIGNED_URL_TTL_SECONDS = "9999"
    assert.equal(getSignedUrlTtlSeconds(), 300)
    process.env.ACQUISITION_ATTACHMENT_SIGNED_URL_TTL_SECONDS = "120"
    assert.equal(getSignedUrlTtlSeconds(), 120)
  })
})

function mockRepo(impl: {
  find?: AttachmentAccessRepositoryPort["findConsultableAttachment"]
}): AttachmentAccessRepositoryPort {
  return {
    findConsultableAttachment:
      impl.find ??
      (async () => null),
  }
}

function mockSigner(): AttachmentUrlSignerPort {
  return {
    createSignedUrl: async () => ({ url: "https://api.cloudinary.com/signed" }),
  }
}

function mockFetcher(): AttachmentAccessFetcherPort {
  return {
    fetchSignedResource: async () => ({
      ok: true,
      status: 200,
      body: streamBody(),
      contentLength: 8,
    }),
  }
}

function mockAudit(store: unknown[]): AttachmentAccessAuditRepositoryPort {
  return {
    record: async (entry) => {
      store.push(entry)
    },
  }
}

function depsWithStored(
  record: ConsultableAttachmentRecord = STORED,
  audits: unknown[] = []
) {
  return {
    repository: mockRepo({ find: async () => record }),
    signer: mockSigner(),
    fetcher: mockFetcher(),
    auditRepository: mockAudit(audits),
  }
}
