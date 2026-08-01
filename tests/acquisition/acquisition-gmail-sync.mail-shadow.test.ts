/**
 * LOT-1C — non-régression sync : 1 poll, shadow best-effort, budget, zéro Draft extra.
 */
import assert from "node:assert/strict"
import { describe, it } from "node:test"
import fs from "node:fs"
import path from "node:path"
import { syncAcquisitionMailForCompany } from "@/lib/acquisition/connector/acquisition-gmail-sync.service"
import { createMailShadowRunStats } from "@/lib/integration/connectors/mail-bridge/mail-shadow-run-stats"
import type { CanonicalMailMessage } from "@/lib/acquisition/connector/connector.types"
import type { MailShadowRunContext } from "@/lib/acquisition/connector/mail-shadow-hook"

function message(id: string): CanonicalMailMessage {
  return {
    externalMessageId: id,
    threadId: null,
    fromHeader: "a@example.com",
    subject: "S",
    receivedAt: new Date("2026-08-01T10:00:00.000Z"),
    labels: [],
    snippet: null,
    attachments: [],
    providerMetadata: {},
  }
}

describe("acquisition-gmail-sync mail-shadow non-régression", () => {
  it("un seul poll distant même avec shadow", async () => {
    let listCalls = 0
    let registerCalls = 0
    let projectCalls = 0

    const shadow: MailShadowRunContext = {
      connectionId: "conn1",
      deadlineAtMs: Date.now() + 60_000,
      stats: createMailShadowRunStats(),
      bridge: {
        project: async () => {
          projectCalls++
        },
      },
    }

    const result = await syncAcquisitionMailForCompany({
      companyId: "co1",
      mailShadow: shadow,
      provider: {
        source: "GMAIL",
        listMessagesPage: async () => {
          listCalls++
          return {
            messages: [message("m1"), message("m2")],
            nextPageToken: null,
            nextHistoryId: "h1",
            hasMore: false,
            paginationMode: "lookback" as const,
          }
        },
      } as never,
      ingestion: {
        isEnabled: () => true,
        registerIncomingMessage: async () => {
          registerCalls++
          return { outcome: "DRAFT_CREATED", created: true }
        },
      } as never,
      cursorRepository: {
        getOrCreate: async () => ({ lastHistoryId: null }),
        saveSuccessfulPage: async () => undefined,
        recordFailure: async () => undefined,
      } as never,
    })

    assert.equal(listCalls, 1)
    assert.equal(registerCalls, 2)
    assert.equal(projectCalls, 2)
    assert.equal(result.status, "SUCCESS")
    assert.equal(result.stats.ingested, 2)
  })

  it("erreur shadow n’altère pas stats/statut legacy", async () => {
    const shadow: MailShadowRunContext = {
      connectionId: "conn1",
      deadlineAtMs: Date.now() + 60_000,
      stats: createMailShadowRunStats(),
      bridge: {
        project: async () => {
          throw new Error("boom shadow")
        },
      },
    }

    const result = await syncAcquisitionMailForCompany({
      companyId: "co1",
      mailShadow: shadow,
      provider: {
        source: "GMAIL",
        listMessagesPage: async () => ({
          messages: [message("m1")],
          nextPageToken: null,
          nextHistoryId: "h1",
          hasMore: false,
          paginationMode: "lookback" as const,
        }),
      } as never,
      ingestion: {
        isEnabled: () => true,
        registerIncomingMessage: async () => ({
          outcome: "DRAFT_CREATED",
          created: true,
        }),
      } as never,
      cursorRepository: {
        getOrCreate: async () => ({ lastHistoryId: null }),
        saveSuccessfulPage: async () => undefined,
        recordFailure: async () => undefined,
      } as never,
    })

    assert.equal(result.status, "SUCCESS")
    assert.equal(result.stats.ingested, 1)
    assert.equal(result.stats.failed, 0)
    assert.ok((result.shadowStats?.shadowErrors ?? 0) >= 1)
  })

  it("admission refusée après budget — plus de project", async () => {
    let projectCalls = 0
    const shadow: MailShadowRunContext = {
      connectionId: "conn1",
      deadlineAtMs: Date.now() - 1,
      stats: createMailShadowRunStats(),
      bridge: {
        project: async () => {
          projectCalls++
        },
      },
    }

    await syncAcquisitionMailForCompany({
      companyId: "co1",
      mailShadow: shadow,
      provider: {
        source: "GMAIL",
        listMessagesPage: async () => ({
          messages: [message("m1"), message("m2")],
          nextPageToken: null,
          nextHistoryId: "h1",
          hasMore: false,
          paginationMode: "lookback" as const,
        }),
      } as never,
      ingestion: {
        isEnabled: () => true,
        registerIncomingMessage: async () => ({
          outcome: "DRAFT_CREATED",
          created: true,
        }),
      } as never,
      cursorRepository: {
        getOrCreate: async () => ({ lastHistoryId: null }),
        saveSuccessfulPage: async () => undefined,
        recordFailure: async () => undefined,
      } as never,
    })

    assert.equal(projectCalls, 0)
    assert.equal(shadow.stats.skippedBudget, 2)
  })

  it("mailShadow:false — zéro project", async () => {
    let projectCalls = 0
    await syncAcquisitionMailForCompany({
      companyId: "co1",
      mailShadow: false,
      provider: {
        source: "GMAIL",
        listMessagesPage: async () => ({
          messages: [message("m1")],
          nextPageToken: null,
          nextHistoryId: null,
          hasMore: false,
          paginationMode: "lookback" as const,
        }),
      } as never,
      ingestion: {
        isEnabled: () => true,
        registerIncomingMessage: async () => ({
          outcome: "DRAFT_CREATED",
          created: true,
        }),
      } as never,
      cursorRepository: {
        getOrCreate: async () => ({ lastHistoryId: null }),
        saveSuccessfulPage: async () => undefined,
        recordFailure: async () => undefined,
      } as never,
    })
    assert.equal(projectCalls, 0)
  })

  it("shadow OFF et ON → même nombre de Drafts legacy (registerIncomingMessage)", async () => {
    const messages = [message("d1"), message("d2"), message("d3")]
    let draftsOff = 0
    let draftsOn = 0

    const baseProvider = {
      source: "GMAIL",
      listMessagesPage: async () => ({
        messages,
        nextPageToken: null,
        nextHistoryId: "h1",
        hasMore: false,
        paginationMode: "lookback" as const,
      }),
    }
    const cursorRepository = {
      getOrCreate: async () => ({ lastHistoryId: null }),
      saveSuccessfulPage: async () => undefined,
      recordFailure: async () => undefined,
    }

    await syncAcquisitionMailForCompany({
      companyId: "co1",
      mailShadow: false,
      provider: baseProvider as never,
      ingestion: {
        isEnabled: () => true,
        registerIncomingMessage: async () => {
          draftsOff++
          return { outcome: "DRAFT_CREATED", created: true }
        },
      } as never,
      cursorRepository: cursorRepository as never,
    })

    const shadow: MailShadowRunContext = {
      connectionId: "conn1",
      deadlineAtMs: Date.now() + 60_000,
      stats: createMailShadowRunStats(),
      bridge: { project: async () => undefined },
    }

    await syncAcquisitionMailForCompany({
      companyId: "co1",
      mailShadow: shadow,
      provider: baseProvider as never,
      ingestion: {
        isEnabled: () => true,
        registerIncomingMessage: async () => {
          draftsOn++
          return { outcome: "DRAFT_CREATED", created: true }
        },
      } as never,
      cursorRepository: cursorRepository as never,
    })

    assert.equal(draftsOff, 3)
    assert.equal(draftsOn, 3)
    assert.equal(draftsOn, draftsOff)
  })

  it("erreur bridge shadow → aucun Draft legacy supplémentaire", async () => {
    let draftCreates = 0
    const shadow: MailShadowRunContext = {
      connectionId: "conn1",
      deadlineAtMs: Date.now() + 60_000,
      stats: createMailShadowRunStats(),
      bridge: {
        project: async () => {
          throw new Error("bridge fail")
        },
      },
    }

    const result = await syncAcquisitionMailForCompany({
      companyId: "co1",
      mailShadow: shadow,
      provider: {
        source: "GMAIL",
        listMessagesPage: async () => ({
          messages: [message("e1"), message("e2")],
          nextPageToken: null,
          nextHistoryId: "h1",
          hasMore: false,
          paginationMode: "lookback" as const,
        }),
      } as never,
      ingestion: {
        isEnabled: () => true,
        registerIncomingMessage: async () => {
          draftCreates++
          return { outcome: "DRAFT_CREATED", created: true }
        },
      } as never,
      cursorRepository: {
        getOrCreate: async () => ({ lastHistoryId: null }),
        saveSuccessfulPage: async () => undefined,
        recordFailure: async () => undefined,
      } as never,
    })

    // Exactement 1 register / message — pas de 2ᵉ création après échec shadow
    assert.equal(draftCreates, 2)
    assert.equal(result.stats.ingested, 2)
    assert.equal(result.status, "SUCCESS")
    assert.ok((result.shadowStats?.shadowErrors ?? 0) >= 1)
  })

  it("hook / helpers shadow n’importent aucun service Draft Platform", () => {
    const roots = [
      "src/lib/acquisition/connector/mail-shadow-hook.ts",
      "src/lib/acquisition/connector/mail-shadow-dto.mapper.ts",
      "src/lib/acquisition/connector/mail-shadow-connection.once.ts",
    ]
    const forbidden = [
      /draft-platform/i,
      /DraftPlatform/,
      /pipeline-admission/i,
      /PipelineAdmission/,
      /WorksiteImportDraft/,
      /import-draft/i,
      /createImportDraft/,
      /conversion\.service/,
    ]
    for (const rel of roots) {
      const src = fs.readFileSync(path.join(process.cwd(), rel), "utf8")
      for (const pattern of forbidden) {
        assert.equal(
          pattern.test(src),
          false,
          `${rel} ne doit pas référencer ${pattern}`
        )
      }
    }
  })
})
