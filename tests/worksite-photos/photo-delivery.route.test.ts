import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { before, beforeEach, mock, test } from "node:test"
import type { PhotoSession } from "@/lib/worksite-photos/photo.service"

const bytes = Buffer.from("synthetic JPEG bytes")
const serviceOrigin = "https://planificator.example.test"
const endpoint = `${serviceOrigin}/api/worksite-photos/worksites/worksite-test/delivery-preview`
const context = { params: Promise.resolve({ worksiteId: "worksite-test" }) }
const actor = { id: "super-admin", role: "SUPER_ADMIN", companyId: "company-test", name: "Admin test", active: true }
let session: PhotoSession | null
let role: string
let email: string
let claim: string | null
let sent: boolean
let ops: string[]
let mails: Array<{ to: string[]; attachments: Array<{ filename: string; content: string }> }>
let route: typeof import("../../src/app/api/worksite-photos/worksites/[worksiteId]/delivery-preview/route")

const dbOperations = {
  user: { findFirst: async () => ({ ...actor, role }) },
  company: { findFirst: async () => ({ id: actor.companyId, active: true }) },
  worksite: {
    async findFirst({ where }: { where: { companyId: string; id: string } }) {
      assert.deepEqual(where, { id: "worksite-test", companyId: actor.companyId })
      ops.push("worksite")
      return { name: "Chantier synthétique", photoRecipients: [{ label: "Client test", email }] }
    },
  },
  worksitePhotoEvent: {
    async create({ data }: { data: { action: string } }) { ops.push(data.action) },
  },
  async $queryRaw(parts: TemplateStringsArray, ...values: unknown[]) {
    if (!parts.join("").includes('FROM "worksite_truck_photos"')) return []
    assert.equal(values[0], actor.companyId)
    assert.equal(values[1], "worksite-test")
    return sent ? [] : ["a", "b"].map((id) => ({
      id, driveFileId: id, mimeType: "image/jpeg", sizeBytes: bytes.length, deliveryClaim: claim,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    }))
  },
  async $executeRaw(parts: TemplateStringsArray, ...values: unknown[]) {
    if (parts.join("").includes('"status" = \'SENT\'')) {
      assert.ok(values.includes("test-transport-receipt"))
      sent = true
      claim = null
    } else {
      claim = String(values[0])
    }
    return 2
  },
}

const db = {
  ...dbOperations,
  async $transaction<T>(fn: (tx: typeof dbOperations) => Promise<T>): Promise<T> {
    return fn(dbOperations)
  },
}

before(async () => {
  mock.module("@/lib/prisma", { namedExports: { prisma: db } })
  mock.module("@/lib/worksite-photos/photo.deps", { namedExports: {
    productionPhotoDeps: () => ({
      auth: async () => session,
      reviewDb: {
        findActor: async () => ({ ...actor, role }),
        findCompany: async () => ({ id: actor.companyId, active: true }),
        findEmployee: async () => null,
      },
      storage: { async download() {
        ops.push("download")
        return { stream: new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close() } }) }
      } },
    }),
  } })
  // Intercept all HTTP calls before importing the route. The real SDK serializes to a local fake response.
  mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input))
    assert.equal(url.pathname, "/emails")
    const headers = new Headers(init?.headers)
    assert.equal(headers.get("authorization"), "Bearer local-fake-key")
    assert.equal(headers.get("idempotency-key"), `worksite-photos/${claim}`)
    assert.equal(typeof init?.body, "string")
    ops.push("fake-send")
    mails.push(JSON.parse(String(init?.body)))
    return Response.json({ id: "test-transport-receipt" })
  })
  route = await import("../../src/app/api/worksite-photos/worksites/[worksiteId]/delivery-preview/route")
})

beforeEach(() => {
  process.env.PLANIFICATOR_WORKSITE_PHOTOS_ENABLED = "true"
  process.env.WORKSITE_PHOTOS_BATCH_SEND_ENABLED = "true"
  process.env.RESEND_API_KEY = "local-fake-key"
  session = { user: actor }
  role = actor.role
  email = "client@example.test"
  claim = null
  sent = false
  ops = []
  mails = []
})

async function preview() {
  const response = await route.GET(new Request(endpoint), context)
  assert.equal(response.status, 200, JSON.stringify({ response: await response.clone().json(), ops, claim }))
  assert.match(response.headers.get("cache-control") ?? "", /no-store/)
  return response.json()
}

function confirm(snapshot: string, origin = serviceOrigin) {
  return route.POST(new Request(endpoint, {
    method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ snapshot }),
  }), context)
}

test("preview performs no send and confirmation sends all attachments exactly once", async () => {
  const reviewed = await preview()
  assert.deepEqual(reviewed.recipients, [{ label: "Client test", email }])
  assert.equal(reviewed.photoCount, 2)
  assert.deepEqual(ops, ["worksite"])
  const response = await confirm(reviewed.snapshot)
  assert.equal(response.status, 200, JSON.stringify({ response: await response.clone().json(), ops, claim }))
  assert.deepEqual(await response.json(), { photoCount: 2 })
  assert.deepEqual(ops, ["worksite", "worksite", "download", "download", "worksite", "DELIVERY_REQUESTED", "fake-send", "SENT"])
  assert.deepEqual(mails[0].to, [email])
  assert.deepEqual(mails[0].attachments.map(({ content }) => content), [bytes.toString("base64"), bytes.toString("base64")])
  assert.equal((await confirm(reviewed.snapshot)).status, 409)
  assert.equal(mails.length, 1)
})

test("recipient changes, cross-origin confirmation and disabled send reach no transport", async () => {
  const reviewed = await preview()
  assert.equal((await confirm(reviewed.snapshot, "https://outside.example.test")).status, 403)
  email = "changed@example.test"
  const stale = await confirm(reviewed.snapshot)
  assert.equal(stale.status, 409)
  assert.equal((await stale.json()).code, "DELIVERY_CHANGED")
  process.env.WORKSITE_PHOTOS_BATCH_SEND_ENABLED = "false"
  const fresh = await preview()
  assert.equal(fresh.enabled, false)
  assert.equal((await confirm(fresh.snapshot)).status, 409)
  assert.equal(mails.length, 0)
  assert.ok(!ops.includes("download"))
})

test("a stale super-admin session cannot read the recipients", async () => {
  role = "ADMIN"
  const response = await route.GET(new Request(endpoint), context)
  assert.equal(response.status, 403)
  assert.deepEqual(ops, [])
})
