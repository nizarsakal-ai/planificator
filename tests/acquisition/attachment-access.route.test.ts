process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test"

import { describe, it, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import type { Role } from "@prisma/client"
import { handleAcquisitionAttachmentAccess } from "@/lib/acquisition/access/attachment-access.handler"
import type { ConsultableAttachmentRecord } from "@/lib/acquisition/access/attachment-access.types"

const STORED: ConsultableAttachmentRecord = {
  id: "att-route-1",
  companyId: "co-route",
  filename: "plan.pdf",
  mimeType: "application/pdf",
  sizeBytes: 11,
  storagePublicId: "internal/public/id",
  sha256: "deadbeef",
  storedAt: new Date("2026-01-01"),
}

function streamBody(content = "hello-world"): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(content))
      controller.close()
    },
  })
}

function session(role: Role, companyId: string | null = "co-route") {
  return async () => ({
    user: {
      id: "user-route",
      role,
      companyId,
    },
  })
}

describe("GET /api/acquisition/attachments/[id] handler", () => {
  const envBackup = {
    acquisition: process.env.PLANIFICATOR_ACQUISITION_ENABLED,
    access: process.env.ACQUISITION_ATTACHMENT_ACCESS_ENABLED,
  }

  beforeEach(() => {
    process.env.PLANIFICATOR_ACQUISITION_ENABLED = "true"
    process.env.ACQUISITION_ATTACHMENT_ACCESS_ENABLED = "true"
  })

  afterEach(() => {
    process.env.PLANIFICATOR_ACQUISITION_ENABLED = envBackup.acquisition
    process.env.ACQUISITION_ATTACHMENT_ACCESS_ENABLED = envBackup.access
  })

  it("401 sans session", async () => {
    const res = await handleAcquisitionAttachmentAccess(new Request("http://localhost/api/x"), "att-1", {
      auth: async () => null,
    })
    assert.equal(res.status, 401)
  })

  it("403 rôle EMPLOYEE interdit", async () => {
    const res = await handleAcquisitionAttachmentAccess(new Request("http://localhost/api/x"), "att-1", {
      auth: session("EMPLOYEE"),
      repository: { findConsultableAttachment: async () => STORED },
    })
    assert.equal(res.status, 403)
  })

  it("404 cross-tenant", async () => {
    const res = await handleAcquisitionAttachmentAccess(new Request("http://localhost/api/x"), "foreign-att", {
      auth: session("ADMIN", "co-route"),
      repository: { findConsultableAttachment: async () => null },
      auditRepository: { record: async () => {} },
    })
    assert.equal(res.status, 404)
    const text = await res.text()
    assert.ok(!text.includes("cloudinary"))
    assert.ok(!text.includes("internal/public"))
  })

  it("200 VIEW avec headers sécurité", async () => {
    const res = await handleAcquisitionAttachmentAccess(new Request("http://localhost/api/x"), STORED.id, {
      auth: session("ADMIN"),
      repository: { findConsultableAttachment: async () => STORED },
      signer: { createSignedUrl: async () => ({ url: "https://api.cloudinary.com/signed" }) },
      fetcher: {
        fetchSignedResource: async () => ({
          ok: true,
          status: 200,
          body: streamBody(),
          contentLength: 11,
        }),
      },
      auditRepository: { record: async () => {} },
    })
    assert.equal(res.status, 200)
    assert.equal(res.headers.get("Cache-Control"), "private, no-store")
    assert.equal(res.headers.get("X-Content-Type-Options"), "nosniff")
    assert.match(res.headers.get("Content-Disposition") ?? "", /^inline/)
    const body = await res.text()
    assert.equal(body, "hello-world")
    assert.ok(!body.includes("cloudinary"))
    assert.ok(!JSON.stringify([...res.headers.entries()]).includes("internal/public"))
  })

  it("200 DOWNLOAD avec dl=1", async () => {
    const res = await handleAcquisitionAttachmentAccess(
      new Request("http://localhost/api/x?dl=1"),
      STORED.id,
      {
        auth: session("ADMIN"),
        repository: { findConsultableAttachment: async () => STORED },
        signer: { createSignedUrl: async () => ({ url: "https://api.cloudinary.com/signed" }) },
        fetcher: {
          fetchSignedResource: async () => ({
            ok: true,
            status: 200,
            body: streamBody("download"),
            contentLength: 8,
          }),
        },
        auditRepository: { record: async () => {} },
      }
    )
    assert.equal(res.status, 200)
    assert.match(res.headers.get("Content-Disposition") ?? "", /^attachment/)
  })
})
