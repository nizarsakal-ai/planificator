/**
 * PLAN-ACQ-V2 R2 — Tests corrections blockers / majors.
 */
process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test"

import assert from "node:assert/strict"
import { describe, it } from "node:test"
import {
  buildAcquisitionGmailLookbackQuery,
  escapeGmailQueryTerm,
} from "@/lib/acquisition/connector/gmail-mail-provider.adapter"
import { GmailMailProviderAdapter } from "@/lib/acquisition/connector/gmail-mail-provider.adapter"
import { GmailProviderError } from "@/lib/acquisition/connector/gmail.errors"
import {
  buildAttachmentTextExcerpts,
} from "@/lib/acquisition/extraction/attachment-text-excerpts"
import {
  buildMinimalTextPdf,
  extractPdfTextLayer,
} from "@/lib/acquisition/extraction/pdf-text-extract"
import {
  normalizeAddressKey,
  normalizeStoredWorksiteAddress,
  findDuplicateWorksite,
} from "@/lib/acquisition/matching/client-match.service"
import { evaluateAutoDecision } from "@/lib/acquisition/policy/auto-decision.policy"
import { resolveValidatedSystemActor } from "@/lib/acquisition/policy/system-actor"
import { InMemoryAcquisitionOrchestratorLeaseRepository } from "@/lib/acquisition/orchestrator/acquisition-orchestrator-lease.repository"
import { ACQUISITION_ORCHESTRATOR_LEASE_KEY } from "@/lib/acquisition/orchestrator/acquisition-orchestrator-feature-flag"
import { NominatimGeocodeAdapter } from "@/lib/geo/geocode.port"

describe("R2 PDF text extract", () => {
  it("extrait texte d’un PDF minimal", async () => {
    const buf = buildMinimalTextPdf("Chantier Tour Alpha 120m2")
    const r = await extractPdfTextLayer(buf)
    assert.ok(
      r.status === "PDF_TEXT_EXTRACTED" || r.status === "PDF_TEXT_TRUNCATED"
    )
    assert.ok(r.text.includes("Chantier") || r.text.includes("Tour"))
  })

  it("PDF corrompu → PDF_PARSE_FAILED", async () => {
    const r = await extractPdfTextLayer(Buffer.from("not-a-pdf"))
    assert.equal(r.status, "PDF_PARSE_FAILED")
  })

  it("PDF sans texte → PDF_NO_TEXT_LAYER ou PARSE", async () => {
    const empty = Buffer.from(
      "%PDF-1.4\n1 0 obj<< /Type /Catalog >>endobj\ntrailer<< /Root 1 0 R >>\n%%EOF\n"
    )
    const r = await extractPdfTextLayer(empty)
    assert.ok(
      r.status === "PDF_NO_TEXT_LAYER" || r.status === "PDF_PARSE_FAILED"
    )
  })

  it("buildAttachmentTextExcerpts branche bytes PDF", async () => {
    const buf = buildMinimalTextPdf("Surface utile 80 m2")
    const { excerpts, outcomes } = await buildAttachmentTextExcerpts([
      {
        filename: "plan.pdf",
        mimeType: "application/pdf",
        category: "PLAN",
        bytes: buf,
      },
    ])
    assert.ok(outcomes.length === 1)
    assert.ok(
      outcomes[0].status === "PDF_TEXT_EXTRACTED" ||
        outcomes[0].status === "PDF_TEXT_TRUNCATED"
    )
    assert.ok(excerpts.length >= 1)
  })
})

describe("R2 anti-doublon normalisation", () => {
  it("draft key === stored worksite address key", () => {
    const draftKey = normalizeAddressKey({
      address: "10 Rue de Test",
      postalCode: "75001",
      city: "Paris",
    })
    const storedKey = normalizeStoredWorksiteAddress("10 Rue de Test, 75001, Paris")
    assert.equal(draftKey, storedKey)
  })

  it("variation casse / accents", () => {
    const a = normalizeAddressKey({
      address: "10 Rue de l'Été",
      postalCode: "69001",
      city: "Lyon",
    })
    const b = normalizeStoredWorksiteAddress("10 rue de l'ete, 69001, lyon")
    assert.equal(a, b)
  })

  it("adresses proches mais non identiques", () => {
    const a = normalizeAddressKey({
      address: "10 rue Test",
      postalCode: "75001",
      city: "Paris",
    })
    const b = normalizeAddressKey({
      address: "12 rue Test",
      postalCode: "75001",
      city: "Paris",
    })
    assert.notEqual(a, b)
  })

  it("findDuplicate detecte adresse normalisée", async () => {
    const draftKey = normalizeAddressKey({
      address: "1 Avenue Demo",
      postalCode: "33000",
      city: "Bordeaux",
    })
    const hit = await findDuplicateWorksite({
      companyId: "co1",
      addressKey: draftKey,
      postalCode: "33000",
      db: {
        worksite: {
          findMany: async () => [
            {
              id: "w1",
              address: "1 Avenue Demo, 33000, Bordeaux",
              name: "Chantier A",
            },
          ],
        } as never,
      },
    })
    assert.equal(hit.worksiteId, "w1")
    assert.equal(hit.matchKind, "ADDRESS")
  })
})

describe("R2 policy gardes", () => {
  const base = {
    worksiteName: "Site",
    startDate: new Date("2026-08-01"),
    endDate: new Date("2026-08-02"),
    address: "10 rue A",
    postalCode: "75001",
    city: "Paris",
    clientName: "Client",
    clientEmail: "c@x.fr",
    confidenceData: {
      worksiteName: 0.9,
      requestedStartDate: 0.9,
      requestedEndDate: 0.9,
    },
    warningData: [] as unknown[],
    autoApproveEnabled: true,
    autoConvertEnabled: true,
    minConfidence: 0.75,
  }

  it("doublon → POTENTIAL_DUPLICATE", () => {
    const r = evaluateAutoDecision({ ...base, potentialDuplicate: true })
    assert.equal(r.code, "HUMAN_REVIEW_REQUIRED")
    assert.ok(r.reasons.includes("POTENTIAL_DUPLICATE"))
  })

  it("client ambigu → AMBIGUOUS_CLIENT", () => {
    const r = evaluateAutoDecision({ ...base, clientAmbiguous: true })
    assert.ok(r.reasons.includes("AMBIGUOUS_CLIENT"))
  })

  it("adresse incomplète → AMBIGUOUS_ADDRESS", () => {
    const r = evaluateAutoDecision({ ...base, city: null })
    assert.ok(r.reasons.includes("AMBIGUOUS_ADDRESS"))
  })

  it("dates incohérentes → INVALID_DATES", () => {
    const r = evaluateAutoDecision({
      ...base,
      startDate: new Date("2026-08-10"),
      endDate: new Date("2026-08-01"),
    })
    assert.ok(r.reasons.includes("INVALID_DATES"))
  })

  it("prompt injection → PROMPT_INJECTION_RISK", () => {
    const r = evaluateAutoDecision({
      ...base,
      warningData: [{ code: "POTENTIAL_PROMPT_INJECTION", blocking: false }],
    })
    assert.ok(r.reasons.includes("PROMPT_INJECTION_RISK"))
  })

  it("doc indispensable → REQUIRED_DOCUMENT_UNREADABLE", () => {
    const r = evaluateAutoDecision({
      ...base,
      requiredDocumentUnreadable: true,
    })
    assert.ok(r.reasons.includes("REQUIRED_DOCUMENT_UNREADABLE"))
  })
})

describe("R2 SYSTEM actor", () => {
  it("env unset → SYSTEM_ACTOR_MISSING", async () => {
    delete process.env.ACQUISITION_SYSTEM_ACTOR_USER_ID
    const r = await resolveValidatedSystemActor("co1", {
      user: { findFirst: async () => null },
    } as never)
    assert.equal(r.ok, false)
    if (!r.ok) assert.equal(r.code, "SYSTEM_ACTOR_MISSING")
  })

  it("user absent → SYSTEM_ACTOR_INVALID", async () => {
    process.env.ACQUISITION_SYSTEM_ACTOR_USER_ID = "u-missing"
    const r = await resolveValidatedSystemActor("co1", {
      user: { findFirst: async () => null },
    } as never)
    assert.equal(r.ok, false)
    if (!r.ok) {
      assert.equal(r.code, "SYSTEM_ACTOR_INVALID")
      assert.equal(r.reason, "user_not_found")
    }
  })

  it("mauvais tenant → tenant_mismatch", async () => {
    process.env.ACQUISITION_SYSTEM_ACTOR_USER_ID = "u1"
    const r = await resolveValidatedSystemActor("co1", {
      user: {
        findFirst: async () => ({
          id: "u1",
          companyId: "other",
          role: "ADMIN",
          active: true,
        }),
      },
    } as never)
    assert.equal(r.ok, false)
    if (!r.ok) assert.equal(r.reason, "tenant_mismatch")
  })

  it("rôle insuffisant → role_forbidden", async () => {
    process.env.ACQUISITION_SYSTEM_ACTOR_USER_ID = "u1"
    const r = await resolveValidatedSystemActor("co1", {
      user: {
        findFirst: async () => ({
          id: "u1",
          companyId: "co1",
          role: "EMPLOYEE",
          active: true,
        }),
      },
    } as never)
    assert.equal(r.ok, false)
    if (!r.ok) assert.equal(r.reason, "role_forbidden")
  })

  it("utilisateur valide ADMIN → ok", async () => {
    process.env.ACQUISITION_SYSTEM_ACTOR_USER_ID = "u1"
    const r = await resolveValidatedSystemActor("co1", {
      user: {
        findFirst: async () => ({
          id: "u1",
          companyId: "co1",
          role: "ADMIN",
          active: true,
        }),
      },
    } as never)
    assert.equal(r.ok, true)
    if (r.ok) assert.equal(r.userId, "u1")
  })

  it("utilisateur inactif → user_inactive", async () => {
    process.env.ACQUISITION_SYSTEM_ACTOR_USER_ID = "u1"
    const r = await resolveValidatedSystemActor("co1", {
      user: {
        findFirst: async () => ({
          id: "u1",
          companyId: "co1",
          role: "ADMIN",
          active: false,
        }),
      },
    } as never)
    assert.equal(r.ok, false)
    if (!r.ok) {
      assert.equal(r.code, "SYSTEM_ACTOR_INVALID")
      assert.equal(r.reason, "user_inactive")
    }
  })
})

describe("R2 Gmail fail-closed + emails", () => {
  it("registre vide → NO_ACTIVE_PARTNER_IDENTITIES", () => {
    const q = buildAcquisitionGmailLookbackQuery(7, { domains: [], emails: [] })
    assert.equal(q.ok, false)
    if (!q.ok) assert.equal(q.code, "NO_ACTIVE_PARTNER_IDENTITIES")
  })

  it("emails-only", () => {
    const q = buildAcquisitionGmailLookbackQuery(7, {
      domains: [],
      emails: ["ops@partner.fr"],
    })
    assert.equal(q.ok, true)
    if (q.ok) {
      assert.ok(q.query.includes("from:ops@partner.fr"))
      assert.ok(q.query.startsWith("after:"))
      assert.ok(!/^after:\d{4}\/\d{2}\/\d{2}$/.test(q.query))
    }
  })

  it("domaines-only", () => {
    const q = buildAcquisitionGmailLookbackQuery(7, {
      domains: ["partner.fr"],
      emails: [],
    })
    assert.equal(q.ok, true)
    if (q.ok) assert.ok(q.query.includes("from:@partner.fr"))
  })

  it("mixte parentheses", () => {
    const q = buildAcquisitionGmailLookbackQuery(7, {
      domains: ["a.fr"],
      emails: ["b@c.fr"],
    })
    assert.equal(q.ok, true)
    if (q.ok) {
      assert.match(q.query, /after:\d{4}\/\d{2}\/\d{2} \(.+\)/)
      assert.ok(q.query.includes("from:b@c.fr"))
      assert.ok(q.query.includes("from:@a.fr"))
      assert.ok(q.query.includes(" OR "))
    }
  })

  it("escapeGmailQueryTerm", () => {
    assert.equal(escapeGmailQueryTerm("simple@x.fr"), "simple@x.fr")
    assert.ok(escapeGmailQueryTerm('a"b@x.fr').includes('"'))
  })

  it("adapter lookback sans identité → throw NO_ACTIVE", async () => {
    const adapter = new GmailMailProviderAdapter({
      lookbackDays: 7,
      connectionClient: {
        getValidAccessToken: async () => "tok",
      },
      apiClient: {
        getProfile: async () => ({ historyId: "1" }),
        listHistory: async () => ({}),
        listMessages: async () => ({ messages: [] }),
        getMessage: async () => ({ id: "x", payload: {} }),
        getAttachment: async () => ({ size: 0, data: "" }),
      },
      domainListing: {
        listActiveIdentities: async () => ({ domains: [], emails: [] }),
        listActiveDomains: async () => [],
      },
    })
    await assert.rejects(
      () =>
        adapter.listMessagesPage({
          companyId: "co",
          cursor: null,
          pageSize: 10,
        }),
      (e: unknown) =>
        e instanceof GmailProviderError &&
        e.code === "NO_ACTIVE_PARTNER_IDENTITIES"
    )
  })
})

describe("R2 lease renew", () => {
  it("renew prolonge si owned ; échoue si stolen", async () => {
    const repo = new InMemoryAcquisitionOrchestratorLeaseRepository()
    await repo.acquire({
      key: ACQUISITION_ORCHESTRATOR_LEASE_KEY,
      ownerRunId: "run-a",
      leaseTtlMs: 60_000,
    })
    const ok = await repo.renew({
      key: ACQUISITION_ORCHESTRATOR_LEASE_KEY,
      ownerRunId: "run-a",
      leaseTtlMs: 120_000,
    })
    assert.equal(ok.outcome, "OWNED")
    repo.forceOwner(ACQUISITION_ORCHESTRATOR_LEASE_KEY, "thief", 60_000)
    const bad = await repo.renew({
      key: ACQUISITION_ORCHESTRATOR_LEASE_KEY,
      ownerRunId: "run-a",
      leaseTtlMs: 120_000,
    })
    assert.equal(bad.outcome, "NOT_OWNER")
  })
})

describe("R2 géocode timeout", () => {
  it("AbortSignal timeout → null", async () => {
    const geo = new NominatimGeocodeAdapter(
      async (_url, init) => {
        await new Promise((_, reject) => {
          init?.signal?.addEventListener("abort", () => {
            const err = new Error("aborted")
            err.name = "AbortError"
            reject(err)
          })
        })
        return new Response("[]")
      },
      "Planificator/1.0",
      20
    )
    const r = await geo.geocodeAddress("10 rue Test Paris")
    assert.equal(r, null)
  })
})
