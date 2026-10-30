/**
 * SPEC-WORKSITE-PHOTOS-001 Lot 2 — client REST Drive en fetch factice : requêtes émises, mapping des erreurs,
 * création idempotente (409 = DRIVE_ID_EXISTS), multipart conforme, jamais de jeton dans les erreurs.
 */
import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { FetchDriveApiClient, DRIVE_FOLDER_MIME } from "@/lib/worksite-photos/drive/drive-api.client"
import { DriveProviderError } from "@/lib/worksite-photos/drive/drive.errors"

type Call = { url: string; init: RequestInit }

function fakeFetch(responder: (call: Call, index: number) => Response | Promise<Response>) {
  const calls: Call[] = []
  const fetchImpl = async (url: string, init?: RequestInit) => {
    const call = { url, init: init ?? {} }
    calls.push(call)
    return responder(call, calls.length - 1)
  }
  return { calls, fetchImpl }
}

const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } })
const googleError = (status: number, reason: string, message = "x") =>
  new Response(JSON.stringify({ error: { code: status, message, errors: [{ reason, message }] } }), { status })

async function expectDriveError(promise: Promise<unknown>): Promise<DriveProviderError> {
  try { await promise } catch (error) { if (error instanceof DriveProviderError) return error; throw error }
  throw new Error("expected DriveProviderError")
}

describe("FetchDriveApiClient", () => {
  it("generateIds : requête bornée, ids validés", async () => {
    const { calls, fetchImpl } = fakeFetch(() => ok({ ids: ["a1", "b2"] }))
    const client = new FetchDriveApiClient(fetchImpl)
    assert.deepEqual(await client.generateIds("tok", 2), ["a1", "b2"])
    assert.match(calls[0].url, /\/drive\/v3\/files\/generateIds\?count=2&space=drive&type=files$/)
    assert.equal((calls[0].init.headers as Record<string, string>).Authorization, "Bearer tok")
    const { fetchImpl: bad } = fakeFetch(() => ok({ ids: [] }))
    assert.equal((await expectDriveError(new FetchDriveApiClient(bad).generateIds("tok", 1))).code, "DRIVE_INVALID_RESPONSE")
    const { calls: clamped, fetchImpl: clampFetch } = fakeFetch(() => ok({ ids: ["x"] }))
    await new FetchDriveApiClient(clampFetch).generateIds("tok", 5000)
    assert.match(clamped[0].url, /count=1000/)
  })

  it("createFolder : identifiant imposé, mime dossier, parent facultatif", async () => {
    const { calls, fetchImpl } = fakeFetch(() => ok({ id: "fid", name: "Chantiers", mimeType: DRIVE_FOLDER_MIME, parents: [] }))
    const meta = await new FetchDriveApiClient(fetchImpl).createFolder("tok", { id: "fid", name: "Chantiers", parentId: null })
    assert.equal(meta.id, "fid")
    const body = JSON.parse(String(calls[0].init.body))
    assert.deepEqual(body, { id: "fid", name: "Chantiers", mimeType: DRIVE_FOLDER_MIME })
    const { calls: withParent, fetchImpl: f2 } = fakeFetch(() => ok({ id: "d", name: "2026-10-30", mimeType: DRIVE_FOLDER_MIME, parents: ["w"] }))
    await new FetchDriveApiClient(f2).createFolder("tok", { id: "d", name: "2026-10-30", parentId: "w" })
    assert.deepEqual(JSON.parse(String(withParent[0].init.body)).parents, ["w"])
  })

  it("createFile : multipart/related avec métadonnées (id, parents, appProperties) puis octets exacts", async () => {
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3])
    const { calls, fetchImpl } = fakeFetch(() => ok({ id: "file1", name: "p.jpg", mimeType: "image/jpeg", size: "7", md5Checksum: "abc", parents: ["day"] }))
    const meta = await new FetchDriveApiClient(fetchImpl).createFile("tok", {
      id: "file1", name: "p.jpg", parentId: "day", mimeType: "image/jpeg", bytes, appProperties: { reservationId: "r1", photoId: "p1" },
    })
    assert.equal(meta.size, 7)
    assert.equal(meta.md5Checksum, "abc")
    assert.match(calls[0].url, /\/upload\/drive\/v3\/files\?uploadType=multipart&fields=/)
    const contentType = (calls[0].init.headers as Record<string, string>)["Content-Type"]
    const boundary = contentType.match(/boundary=(.+)$/)![1]
    const raw = Buffer.from(calls[0].init.body as Uint8Array)
    const text = raw.toString("latin1")
    assert.ok(text.startsWith(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n`))
    const metadata = JSON.parse(text.split("\r\n\r\n")[1].split(`\r\n--${boundary}`)[0])
    assert.deepEqual(metadata, { id: "file1", name: "p.jpg", parents: ["day"], mimeType: "image/jpeg", appProperties: { reservationId: "r1", photoId: "p1" } })
    assert.ok(text.endsWith(`\r\n--${boundary}--`))
    const payloadStart = raw.indexOf(Buffer.from(`Content-Type: image/jpeg\r\n\r\n`)) + `Content-Type: image/jpeg\r\n\r\n`.length
    assert.deepEqual([...raw.subarray(payloadStart, payloadStart + bytes.length)], [...bytes])
    assert.equal("Content-Length" in (calls[0].init.headers as Record<string, string>), false, "longueur laissée à fetch")
  })

  it("mapping des erreurs : 401, quota, rate limit, 403 autre, 404, 409 id existant / autre 409 / 409 sans corps, 5xx, réseau", async () => {
    const cases: Array<[Response | Error, string, number, boolean]> = [
      [googleError(401, "authError"), "DRIVE_UNAUTHORIZED", 503, true],
      [googleError(403, "storageQuotaExceeded"), "DRIVE_QUOTA_EXCEEDED", 503, false],
      [googleError(403, "userRateLimitExceeded"), "DRIVE_RATE_LIMITED", 503, true],
      [googleError(403, "insufficientFilePermissions"), "DRIVE_FORBIDDEN", 502, false],
      [googleError(404, "notFound"), "DRIVE_NOT_FOUND", 404, false],
      [googleError(409, "duplicate", "A file already exists with the provided ID."), "DRIVE_ID_EXISTS", 409, false],
      // L2-R5 : seule la collision d'identifiant reconnue vaut « déjà créé ».
      [googleError(409, "unrelatedConflict", "Conflict."), "DRIVE_CONFLICT", 409, false],
      [new Response("", { status: 409 }), "DRIVE_CONFLICT", 409, false],
      [googleError(429, "rateLimitExceeded"), "DRIVE_RATE_LIMITED", 503, true],
      [new Response("boom", { status: 503 }), "DRIVE_UNAVAILABLE", 502, true],
      [new Error("ECONNRESET"), "DRIVE_UNAVAILABLE", 502, true],
    ]
    for (const [response, code, status, retryable] of cases) {
      const { fetchImpl } = fakeFetch(() => { if (response instanceof Error) throw response; return response })
      const error = await expectDriveError(new FetchDriveApiClient(fetchImpl).getFile("secret-token", "id"))
      assert.equal(error.code, code, `code pour ${code}`)
      assert.equal(error.status, status, `status pour ${code}`)
      assert.equal(error.retryable, retryable, `retryable pour ${code}`)
      assert.equal(error.message.includes("secret-token"), false)
    }
  })

  it("downloadFile : alt=media, flux et longueur ; longueur ignorée si le corps est encodé (gzip)", async () => {
    const { calls, fetchImpl } = fakeFetch((_c, i) => new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: i === 0
      ? { "Content-Type": "image/jpeg", "Content-Length": "3" }
      : { "Content-Type": "image/jpeg", "Content-Length": "3", "Content-Encoding": "gzip" } }))
    const client = new FetchDriveApiClient(fetchImpl)
    const plain = await client.downloadFile("tok", "f 1")
    assert.match(calls[0].url, /\/files\/f%201\?alt=media$/)
    assert.equal(calls[0].init.method, "GET")
    assert.deepEqual([plain.contentType, plain.contentLength], ["image/jpeg", 3])
    assert.deepEqual(Array.from(new Uint8Array(await new Response(plain.stream).arrayBuffer())), [1, 2, 3])
    const encoded = await client.downloadFile("tok", "f2")
    assert.equal(encoded.contentLength, null)
    assert.equal((await expectDriveError(new FetchDriveApiClient(fakeFetch(() => googleError(404, "notFound")).fetchImpl).downloadFile("tok", "nope"))).code, "DRIVE_NOT_FOUND")
  })
  it("getFile / trashFile / deleteFile : verbes et champs", async () => {
    const { calls, fetchImpl } = fakeFetch((call) => call.init.method === "GET"
      ? ok({ id: "f", name: "n", mimeType: "image/jpeg", trashed: true })
      : new Response(null, { status: 204 }))
    const client = new FetchDriveApiClient(fetchImpl)
    const meta = await client.getFile("tok", "f/with space")
    assert.equal(meta.trashed, true)
    assert.match(calls[0].url, /\/files\/f%2Fwith%20space\?fields=/)
    await client.trashFile("tok", "f")
    assert.equal(calls[1].init.method, "PATCH")
    assert.deepEqual(JSON.parse(String(calls[1].init.body)), { trashed: true })
    await client.deleteFile("tok", "f")
    assert.equal(calls[2].init.method, "DELETE")
  })
})
