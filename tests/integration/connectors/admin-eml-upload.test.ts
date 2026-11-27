import assert from "node:assert/strict"
import { test } from "node:test"
import { handleAdminEmlUpload } from "../../../src/lib/integration/connectors/upload-eml/handle-admin-eml-upload"

test("refuse session, rôle, société et drapeau avant de lire le flux", async () => {
  const env: NodeJS.ProcessEnv = {
    NODE_ENV: "test", INTEGRATION_EML_UPLOAD_ENABLED: "true",
    INTEGRATION_PLATFORM_FOUNDATION_ENABLED: "true", INTEGRATION_ROUTING_ENABLED: "true",
    INTEGRATION_ROUTING_COMPANY_ALLOWLIST: "societe-fictive",
  }
  const admin = { id: "admin-fictif", role: "ADMIN", companyId: "societe-fictive" }
  const cases = [
    { actor: null, env, expected: 401 },
    { actor: { ...admin, role: "CLIENT" }, env, expected: 403 },
    { actor: { ...admin, companyId: null }, env, expected: 403 },
    { actor: { ...admin, companyId: "hors-pilote" }, env, expected: 404 },
    { actor: admin, env: { ...env, INTEGRATION_EML_UPLOAD_ENABLED: "false" }, expected: 404 },
  ]
  for (const entry of cases) {
    let reads = 0
    const request = new Request("https://example.invalid/import", {
      method: "POST", headers: { "Content-Type": "message/rfc822" },
    })
    Object.defineProperty(request, "body", {
      get() { reads++; throw new Error("Lecture inattendue") },
    })
    const response = await handleAdminEmlUpload(request, entry.actor, async () => {
      assert.fail("Admission inattendue")
    }, entry.env)
    assert.equal(response.status, entry.expected)
    assert.equal(reads, 0)
  }
})

test("répond 422 quand le flux échoue et ne transmet aucun contenu", async () => {
  const request = new Request("https://example.invalid/import", {
    method: "POST", headers: { "Content-Type": "message/rfc822" },
  })
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) { controller.error(new Error("Détail privé fictif")) },
  })
  Object.defineProperty(request, "body", { value: stream })
  const response = await handleAdminEmlUpload(
    request,
    { id: "admin-fictif", role: "ADMIN", companyId: "societe-fictive" },
    async () => assert.fail("Admission inattendue"),
    {
      NODE_ENV: "test", INTEGRATION_EML_UPLOAD_ENABLED: "true",
      INTEGRATION_PLATFORM_FOUNDATION_ENABLED: "true", INTEGRATION_ROUTING_ENABLED: "true",
      INTEGRATION_ROUTING_COMPANY_ALLOWLIST: "societe-fictive",
    },
  )
  assert.equal(response.status, 422)
  assert.deepEqual(await response.json(), { code: "EML_INVALID" })
})
