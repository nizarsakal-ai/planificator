/**
 * LOT-2D — non-régression de la synchronisation Gmail avec le shadow matching (SPEC LOT-2 §20.3) :
 * un seul poll, aucun brouillon supplémentaire, statistiques et statut legacy identiques même en cas d'échec,
 * résultat L1 transmis à la comparaison, rien d'appelé sans contexte de routage.
 */
import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { syncAcquisitionMailForCompany } from "@/lib/acquisition/connector/acquisition-gmail-sync.service"
import { createMailShadowRunStats } from "@/lib/integration/connectors/mail-bridge/mail-shadow-run-stats"
import type { CanonicalMailMessage } from "@/lib/acquisition/connector/connector.types"
import type { MailShadowRunContext } from "@/lib/acquisition/connector/mail-shadow-hook"
import type { RoutingShadowInput } from "@/lib/integration/shadow/routing-shadow.service"

function message(id: string): CanonicalMailMessage {
  return {
    externalMessageId: id, threadId: null, fromHeader: "a@example.com", subject: "S",
    receivedAt: new Date("2026-08-01T10:00:00.000Z"), labels: [], snippet: null, attachments: [], providerMetadata: {},
  }
}

async function runSync(shadow: MailShadowRunContext | false, outcomes: string[]) {
  let listCalls = 0
  let registerCalls = 0
  const result = await syncAcquisitionMailForCompany({
    companyId: "co1",
    connectionId: "conn1",
    mailShadow: shadow,
    provider: {
      source: "GMAIL",
      listMessagesPage: async () => {
        listCalls++
        return { messages: outcomes.map((_, i) => message(`m${i + 1}`)), nextPageToken: null, nextHistoryId: "h1", hasMore: false, paginationMode: "lookback" as const }
      },
    } as never,
    ingestion: {
      isEnabled: () => true,
      registerIncomingMessage: async () => ({ outcome: outcomes[registerCalls++], created: true }),
    } as never,
    cursorRepository: {
      getOrCreate: async () => ({ lastHistoryId: null }),
      saveSuccessfulPage: async () => undefined,
      recordFailure: async () => undefined,
    } as never,
  })
  return { result, listCalls, registerCalls }
}

function ctx(observe: (i: RoutingShadowInput) => Promise<unknown>, project: () => Promise<void> = async () => undefined): MailShadowRunContext {
  return {
    connectionId: "conn1",
    deadlineAtMs: Date.now() + 60_000,
    stats: createMailShadowRunStats(),
    bridge: { project },
    routingShadow: { observe: observe as never },
  }
}

describe("acquisition-gmail-sync — shadow matching LOT-2D", () => {
  it("un seul poll ; résultat L1 de chaque message transmis à la comparaison ; statistiques legacy inchangées", async () => {
    const seen: RoutingShadowInput[] = []
    const { result, listCalls, registerCalls } = await runSync(ctx(async (i) => { seen.push(i); return { status: "OBSERVED" } }), ["DRAFT_CREATED", "REJECTED"])
    assert.deepEqual([listCalls, registerCalls], [1, 2])
    assert.deepEqual(seen.map((s) => [s.externalId, s.idempotencyKey, s.legacyOutcome, s.connectionId]), [["m1", "m1", "DRAFT_CREATED", "conn1"], ["m2", "m2", "REJECTED", "conn1"]])
    assert.deepEqual([result.status, result.stats.ingested, result.stats.rejected, result.stats.failed], ["SUCCESS", 1, 1, 0])
  })
  it("échec du shadow matching : statut et statistiques legacy identiques à une synchronisation sans shadow", async () => {
    const reference = await runSync(false, ["DRAFT_CREATED", "REJECTED"])
    const failing = await runSync(ctx(async () => { throw new Error("boom routing") }), ["DRAFT_CREATED", "REJECTED"])
    assert.equal(failing.result.status, reference.result.status)
    assert.deepEqual(failing.result.stats, reference.result.stats)
  })
  it("projection LOT-1C en échec : le Router n'est pas appelé", async () => {
    let calls = 0
    await runSync(ctx(async () => { calls++ }, async () => { throw new Error("boom shadow") }), ["DRAFT_CREATED"])
    assert.equal(calls, 0)
  })
  it("contexte sans routage (flags coupés) : aucun appel", async () => {
    const c = ctx(async () => { throw new Error("ne doit pas être appelé") })
    delete c.routingShadow
    const { result } = await runSync(c, ["DRAFT_CREATED"])
    assert.equal(result.status, "SUCCESS")
  })
  it("budget épuisé : chaque message ignoré reçoit tout de même une observation (sans routage ni projection)", async () => {
    const seen: RoutingShadowInput[] = []
    let projects = 0
    const c = ctx(async (i) => { seen.push(i); return { status: "OBSERVED" } }, async () => { projects++ })
    c.deadlineAtMs = 0
    const { result } = await runSync(c, ["DRAFT_CREATED", "REJECTED"])
    assert.equal(projects, 0)
    assert.deepEqual(seen.map((s) => [s.externalId, s.legacyOutcome, s.deadlineAtMs]), [["m1", "DRAFT_CREATED", 0], ["m2", "REJECTED", 0]])
    assert.deepEqual([result.status, result.stats.ingested, result.stats.rejected], ["SUCCESS", 1, 1])
  })
})
