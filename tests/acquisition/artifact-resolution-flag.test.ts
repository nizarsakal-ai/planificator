/**
 * LOT-4B — flag fail-closed de la résolution par capacité, chemin historique préservé, panne transitoire reprise.
 */
import { describe, it } from "node:test"
import assert from "node:assert/strict"
import type { PrismaClient } from "@prisma/client"
import { isArtifactResolutionActiveForCompany } from "@/lib/integration/flags/platform-flags"
import { resolveMailArtifactProvider } from "@/lib/acquisition/artifacts/resolve-mail-artifact-provider"
import { legacyMailArtifactSources } from "@/lib/acquisition/artifacts/legacy-mail-artifact-sources"
import { classifyContentFetchError } from "@/lib/acquisition/content/message-content-fetch-error-policy"
import { isRetryableAttachmentErrorCode } from "@/lib/acquisition/attachments/attachment-retry.policy"

const ON = {
  INTEGRATION_PLATFORM_FOUNDATION_ENABLED: "true",
  INTEGRATION_ARTIFACT_RESOLUTION_ENABLED: "true",
  INTEGRATION_ARTIFACT_RESOLUTION_COMPANY_ALLOWLIST: "coA",
}

/** Base qui échoue au moindre accès : prouve qu'aucune lecture n'a lieu. */
function untouchableDb(accessed: string[]): PrismaClient {
  return new Proxy({} as PrismaClient, { get: (_t, p) => { accessed.push(String(p)); throw new Error("lecture interdite") } })
}
/** Base fictive : seule la recherche d'une boîte par (id, société) est servie ; toute autre lecture échoue. */
function mailboxDb(reads: string[], owners: Record<string, string>): PrismaClient {
  return new Proxy({} as PrismaClient, {
    get: (_t, model) => model === "acquisitionGmailConnection"
      ? { findFirst: async ({ where }: { where: { id: string; companyId: string } }) => { reads.push("acquisitionGmailConnection.findFirst"); return owners[where.id] === where.companyId ? { id: where.id } : null } }
      : (() => { throw new Error(`lecture interdite : ${String(model)}`) })(),
  })
}
const message = { companyId: "coA", sourceMailboxKey: "boite-fictive", externalMessageId: "msg-fictif-1" }
const meta = { id: "att-1", externalArtifactId: "ext-att-1" }

describe("isArtifactResolutionActiveForCompany", () => {
  it("défaut OFF ; strictement \"true\" ; foundation et allowlist requises", () => {
    assert.equal(isArtifactResolutionActiveForCompany("coA", {}), false)
    assert.equal(isArtifactResolutionActiveForCompany("coA", ON), true)
    assert.equal(isArtifactResolutionActiveForCompany("coB", ON), false)
    assert.equal(isArtifactResolutionActiveForCompany("", ON), false)
    for (const [k, v] of [
      ["INTEGRATION_ARTIFACT_RESOLUTION_ENABLED", "TRUE"], ["INTEGRATION_ARTIFACT_RESOLUTION_ENABLED", "1"],
      ["INTEGRATION_PLATFORM_FOUNDATION_ENABLED", "false"], ["INTEGRATION_ARTIFACT_RESOLUTION_COMPANY_ALLOWLIST", ""],
    ] as const) {
      assert.equal(isArtifactResolutionActiveForCompany("coA", { ...ON, [k]: v }), false, `${k}=${v}`)
    }
  })
})

describe("resolveMailArtifactProvider", () => {
  it("flag coupé : chemin historique ; seule l'appartenance de la boîte est lue ; aucun journal en cas de succès", async () => {
    const reads: string[] = []
    const logs: unknown[] = []
    const r = await resolveMailArtifactProvider(mailboxDb(reads, { "boite-fictive": "coA" }), message, "ARTIFACT_FETCH", meta, { env: {}, log: (f) => logs.push(f) })
    assert.deepEqual(r, { ok: true, path: "LEGACY", connectionId: "boite-fictive", provider: legacyMailArtifactSources, artifact: undefined })
    assert.deepEqual([reads, logs], [["acquisitionGmailConnection.findFirst"], []])
  })
  it("flag coupé : boîte d'une autre société → refus MAILBOX_NOT_OWNED, non repris, journalisé sans valeur", async () => {
    const logs: Record<string, unknown>[] = []
    const r = await resolveMailArtifactProvider(mailboxDb([], { "boite-fictive": "coB" }), message, "ARTIFACT_FETCH", meta, { env: {}, log: (f) => logs.push(f) })
    assert.deepEqual(r, { ok: false, code: "ARTIFACT_CAPABILITY_UNAVAILABLE", reason: "MAILBOX_NOT_OWNED" })
    assert.equal(isRetryableAttachmentErrorCode(r.ok ? null : r.code), false)
    assert.deepEqual(logs.map((l) => [l.outcome, l.reason, l.path]), [["ARTIFACT_CAPABILITY_UNAVAILABLE", "MAILBOX_NOT_OWNED", null]])
    assert.doesNotMatch(JSON.stringify(logs), /msg-fictif-1|ext-att-1|boite-fictive/)
  })
  it("flag coupé : panne de lecture (clé vide ou explicite) → ARTIFACT_RESOLUTION_FAILED au lieu d'une exception", async () => {
    for (const sourceMailboxKey of ["", "boite-fictive"]) {
      const r = await resolveMailArtifactProvider(untouchableDb([]), { ...message, sourceMailboxKey }, "CONTENT_FETCH", meta, { env: {}, log: () => undefined })
      assert.deepEqual(r, { ok: false, code: "ARTIFACT_RESOLUTION_FAILED", reason: "READ_FAILED" }, `clé « ${sourceMailboxKey} »`)
    }
  })
  it("les deux chemins rendent le même refus pour une boîte d'une autre société", async () => {
    const off = await resolveMailArtifactProvider(mailboxDb([], { "boite-fictive": "coB" }), message, "CONTENT_FETCH", meta, { env: {}, log: () => undefined })
    const on = await resolveMailArtifactProvider(mailboxDb([], { "boite-fictive": "coB" }), message, "CONTENT_FETCH", meta, { env: ON, log: () => undefined })
    assert.deepEqual(off, on)
  })
  it("flag posé : panne de lecture → ARTIFACT_RESOLUTION_FAILED, journal sans identifiant externe", async () => {
    const logs: Record<string, unknown>[] = []
    const r = await resolveMailArtifactProvider(untouchableDb([]), message, "ARTIFACT_FETCH", meta, { env: ON, log: (f) => logs.push(f) })
    assert.deepEqual(r, { ok: false, code: "ARTIFACT_RESOLUTION_FAILED", reason: "READ_FAILED" })
    assert.equal(logs.length, 1)
    assert.equal(logs[0]!.outcome, "ARTIFACT_RESOLUTION_FAILED")
    assert.doesNotMatch(JSON.stringify(logs), /msg-fictif-1|ext-att-1|boite-fictive/)
  })
})

describe("classement des pannes", () => {
  it("ARTIFACT_RESOLUTION_FAILED repris pour le contenu et les pièces ; capacité absente non reprise", () => {
    assert.equal(classifyContentFetchError("ARTIFACT_RESOLUTION_FAILED"), "RETRYABLE")
    assert.equal(isRetryableAttachmentErrorCode("ARTIFACT_RESOLUTION_FAILED"), true)
    assert.equal(classifyContentFetchError("ARTIFACT_CAPABILITY_UNAVAILABLE"), "CONFIG_TENANT")
    assert.equal(isRetryableAttachmentErrorCode("ARTIFACT_CAPABILITY_UNAVAILABLE"), false)
  })
})
