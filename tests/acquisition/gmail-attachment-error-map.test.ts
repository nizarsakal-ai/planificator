process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test"

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { GmailProviderError } from "@/lib/acquisition/connector/gmail.errors"
import { mapGmailAttachmentFetchFailure } from "@/lib/acquisition/attachments/gmail-attachment-error-map"

/** Constructeur strictement compatible HEAD (pas d’option httpStatus). */
function gmailErr(input: {
  code: ConstructorParameters<typeof GmailProviderError>[0]["code"]
  message?: string
  retryable: boolean
  global?: boolean
}) {
  return new GmailProviderError({
    code: input.code,
    message: input.message ?? input.code,
    retryable: input.retryable,
    global: input.global ?? true,
  })
}

describe("PLAN-ACQ-ATTACHMENTS-002-L2-R1 — mapGmailAttachmentFetchFailure (contrat HEAD)", () => {
  it("GMAIL_UNAUTHORIZED (401/403 mappés provider) → GMAIL_UNAUTHORIZED", () => {
    assert.equal(
      mapGmailAttachmentFetchFailure(
        gmailErr({ code: "GMAIL_UNAUTHORIZED", retryable: false })
      ),
      "GMAIL_UNAUTHORIZED"
    )
  })

  it("GMAIL_MESSAGE_NOT_FOUND (404) → GMAIL_ATTACHMENT_NOT_FOUND", () => {
    assert.equal(
      mapGmailAttachmentFetchFailure(
        gmailErr({ code: "GMAIL_MESSAGE_NOT_FOUND", retryable: false, global: false })
      ),
      "GMAIL_ATTACHMENT_NOT_FOUND"
    )
  })

  it("GMAIL_RATE_LIMITED (429) → GMAIL_RATE_LIMITED", () => {
    assert.equal(
      mapGmailAttachmentFetchFailure(
        gmailErr({ code: "GMAIL_RATE_LIMITED", retryable: true })
      ),
      "GMAIL_RATE_LIMITED"
    )
  })

  it("GMAIL_UNAVAILABLE (5xx) → GMAIL_UNAVAILABLE", () => {
    assert.equal(
      mapGmailAttachmentFetchFailure(
        gmailErr({ code: "GMAIL_UNAVAILABLE", retryable: true })
      ),
      "GMAIL_UNAVAILABLE"
    )
  })

  it("timeout / réseau → GMAIL_UNAVAILABLE", () => {
    assert.equal(
      mapGmailAttachmentFetchFailure(new Error("fetch failed")),
      "GMAIL_UNAVAILABLE"
    )
    const abort = new Error("aborted")
    abort.name = "AbortError"
    assert.equal(mapGmailAttachmentFetchFailure(abort), "GMAIL_UNAVAILABLE")
  })

  it("code Gmail inconnu retryable → GMAIL_UNAVAILABLE", () => {
    assert.equal(
      mapGmailAttachmentFetchFailure(
        gmailErr({ code: "GMAIL_HISTORY_EXPIRED", retryable: true })
      ),
      "GMAIL_UNAVAILABLE"
    )
  })

  it("code Gmail inconnu non retryable → GMAIL_PROVIDER_FAILED (pas NOT_FOUND)", () => {
    const code = mapGmailAttachmentFetchFailure(
      gmailErr({ code: "NO_ACTIVE_PARTNER_IDENTITIES", retryable: false })
    )
    assert.equal(code, "GMAIL_PROVIDER_FAILED")
    assert.notEqual(code, "GMAIL_ATTACHMENT_NOT_FOUND")
  })

  it("token refresh failed → GMAIL_UNAUTHORIZED", () => {
    assert.equal(
      mapGmailAttachmentFetchFailure(
        gmailErr({ code: "GMAIL_TOKEN_REFRESH_FAILED", retryable: false })
      ),
      "GMAIL_UNAUTHORIZED"
    )
  })

  it("payload / parse → ATTACHMENT_DECODE_FAILED", () => {
    assert.equal(
      mapGmailAttachmentFetchFailure(
        gmailErr({
          code: "GMAIL_MESSAGE_PARSE_ERROR",
          retryable: false,
          global: false,
        })
      ),
      "ATTACHMENT_DECODE_FAILED"
    )
  })

  it("GMAIL_NOT_CONNECTED → GMAIL_NOT_CONNECTED", () => {
    assert.equal(
      mapGmailAttachmentFetchFailure(
        gmailErr({ code: "GMAIL_NOT_CONNECTED", retryable: false })
      ),
      "GMAIL_NOT_CONNECTED"
    )
  })
})

describe("PLAN-ACQ-ATTACHMENTS-002-L2-R1 — autonomie : contrat HEAD sans champ DIAG", () => {
  it("fichiers source L2 : aucun accès au statut HTTP DIAG hors contrat HEAD", () => {
    const files = [
      "src/lib/acquisition/attachments/gmail-attachment-error-map.ts",
      "src/lib/acquisition/attachments/gmail-attachment-source.adapter.ts",
      "src/lib/acquisition/attachments/attachment-download.service.ts",
      "src/lib/acquisition/attachments/attachment-policy.ts",
      "src/lib/acquisition/attachments/attachment-retry.policy.ts",
      "src/lib/acquisition/attachments/attachment.types.ts",
    ].map((p) => join(process.cwd(), p))

    const hits: string[] = []
    for (const p of files) {
      const raw = readFileSync(p, "utf8")
      const stripped = raw
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/.*$/gm, "")
      // Accès propriété ou clé d’objet au champ DIAG (interdit L2).
      if (/\.\s*httpStatus\b/.test(stripped) || /\bhttpStatus\s*:/.test(stripped)) {
        hits.push(p)
      }
    }
    assert.deepEqual(hits, [], `dépendance DIAG dans: ${hits.join(", ")}`)
  })
})
