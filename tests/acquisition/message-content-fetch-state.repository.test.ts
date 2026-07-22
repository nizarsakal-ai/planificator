/**
 * Transitions FetchState — store mémoire atomique (mutex par clé) simulant
 * INSERT ON CONFLICT DO NOTHING + incrément sans perte + terminalAt non clearé, sans DB.
 */
process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test"

import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { contentFetchBackoffMinutes } from "@/lib/acquisition/content/content-cron-feature-flag"
import type {
  ContentFetchOrchestratorRepository,
  MarkFailureResult,
} from "@/lib/acquisition/content/message-content-fetch-state.repository"

type StateRow = {
  companyId: string
  acquisitionMessageId: string
  attemptCount: number
  lastErrorCode: string | null
  lastErrorAt: Date | null
  nextRetryAt: Date | null
  terminalAt: Date | null
}

class AtomicInMemoryFetchStateRepo implements ContentFetchOrchestratorRepository {
  readonly states = new Map<string, StateRow>()
  readonly contents = new Set<string>()
  private readonly locks = new Map<string, Promise<void>>()

  private key(companyId: string, messageId: string): string {
    return `${companyId}::${messageId}`
  }

  private async withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(key) ?? Promise.resolve()
    let release!: () => void
    const gate = new Promise<void>((r) => {
      release = r
    })
    this.locks.set(
      key,
      prev.then(() => gate)
    )
    await prev
    try {
      return await fn()
    } finally {
      release()
    }
  }

  async listCompanyIdsWithEligibleContentFetch(): Promise<string[]> {
    return []
  }

  async listEligibleCandidatesForCompany(): Promise<[]> {
    return []
  }

  async hasContent(input: { companyId: string; acquisitionMessageId: string }): Promise<boolean> {
    return this.contents.has(this.key(input.companyId, input.acquisitionMessageId))
  }

  async markRetryableFailure(input: {
    companyId: string
    acquisitionMessageId: string
    errorCode: string
    now: Date
    maxAttempts: number
  }): Promise<MarkFailureResult> {
    const k = this.key(input.companyId, input.acquisitionMessageId)
    return this.withLock(k, async () => {
      if (this.contents.has(k)) {
        return { terminal: false, attemptCount: 0, skippedDueToContent: true }
      }
      const existing = this.states.get(k)
      const attemptCount = (existing?.attemptCount ?? 0) + 1
      const alreadyTerminal = existing?.terminalAt != null
      const terminal = alreadyTerminal || attemptCount >= input.maxAttempts
      this.states.set(k, {
        companyId: input.companyId,
        acquisitionMessageId: input.acquisitionMessageId,
        attemptCount,
        lastErrorCode: input.errorCode,
        lastErrorAt: input.now,
        nextRetryAt: terminal
          ? null
          : new Date(input.now.getTime() + contentFetchBackoffMinutes(attemptCount) * 60_000),
        terminalAt: existing?.terminalAt ?? (terminal ? input.now : null),
      })
      return { terminal, attemptCount }
    })
  }

  async markPermanentFailure(input: {
    companyId: string
    acquisitionMessageId: string
    errorCode: string
    now: Date
  }): Promise<MarkFailureResult> {
    const k = this.key(input.companyId, input.acquisitionMessageId)
    return this.withLock(k, async () => {
      if (this.contents.has(k)) {
        return { terminal: false, attemptCount: 0, skippedDueToContent: true }
      }
      const existing = this.states.get(k)
      const attemptCount = (existing?.attemptCount ?? 0) + 1
      this.states.set(k, {
        companyId: input.companyId,
        acquisitionMessageId: input.acquisitionMessageId,
        attemptCount,
        lastErrorCode: input.errorCode,
        lastErrorAt: input.now,
        nextRetryAt: null,
        terminalAt: existing?.terminalAt ?? input.now,
      })
      return { terminal: true, attemptCount }
    })
  }
}

describe("AcquisitionContentFetchState atomic transitions (in-memory)", () => {
  it("créations concurrentes → une seule row, ON CONFLICT DO NOTHING sémantique", async () => {
    const repo = new AtomicInMemoryFetchStateRepo()
    const now = new Date()
    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        repo.markRetryableFailure({
          companyId: "co1",
          acquisitionMessageId: "m1",
          errorCode: "GMAIL_RATE_LIMITED",
          now,
          maxAttempts: 50,
        })
      )
    )
    assert.equal(repo.states.size, 1)
    const row = repo.states.get("co1::m1")
    assert.ok(row)
    assert.equal(row.attemptCount, 20)
    assert.equal(results.reduce((s, r) => s + r.attemptCount, 0), (20 * 21) / 2)
    assert.equal(row.terminalAt, null)
  })

  it("incréments concurrents sans perte jusqu’au seuil", async () => {
    const repo = new AtomicInMemoryFetchStateRepo()
    const now = new Date()
    const maxAttempts = 5
    for (let i = 0; i < maxAttempts - 1; i++) {
      const r = await repo.markRetryableFailure({
        companyId: "co1",
        acquisitionMessageId: "m1",
        errorCode: "GMAIL_UNAVAILABLE",
        now,
        maxAttempts,
      })
      assert.equal(r.terminal, false)
      assert.equal(r.attemptCount, i + 1)
    }
    const last = await repo.markRetryableFailure({
      companyId: "co1",
      acquisitionMessageId: "m1",
      errorCode: "GMAIL_UNAVAILABLE",
      now,
      maxAttempts,
    })
    assert.equal(last.terminal, true)
    assert.equal(last.attemptCount, maxAttempts)
    assert.ok(repo.states.get("co1::m1")?.terminalAt)
  })

  it("content présent avant mark → skippedDueToContent, pas de terminal", async () => {
    const repo = new AtomicInMemoryFetchStateRepo()
    repo.contents.add("co1::m1")
    const r = await repo.markPermanentFailure({
      companyId: "co1",
      acquisitionMessageId: "m1",
      errorCode: "CONTENT_EMPTY",
      now: new Date(),
    })
    assert.equal(r.skippedDueToContent, true)
    assert.equal(r.terminal, false)
    assert.equal(repo.states.size, 0)
  })

  it("succès concurrent simulé pendant échec → pas de terminalisation", async () => {
    const repo = new AtomicInMemoryFetchStateRepo()
    const now = new Date()
    // Démarre mark, content apparaît avant la section critique via hasContent check
    const pending = repo.markRetryableFailure({
      companyId: "co1",
      acquisitionMessageId: "m1",
      errorCode: "GMAIL_RATE_LIMITED",
      now,
      maxAttempts: 5,
    })
    // Insère content pendant la course (après démarrage) — le lock sérialise :
    // on pose content puis mark voit content.
    await Promise.resolve()
    repo.contents.add("co1::m1")
    // Nouveau mark après content
    const r2 = await repo.markPermanentFailure({
      companyId: "co1",
      acquisitionMessageId: "m1",
      errorCode: "CONTENT_EMPTY",
      now,
    })
    await pending
    assert.equal(r2.skippedDueToContent, true)
    // Si le premier mark a gagné le lock avant content, une row peut exister ;
    // si content a été vu, skipped. Dans les deux cas pas de double row.
    assert.ok(repo.states.size <= 1)
  })

  it("isolation companyId", async () => {
    const repo = new AtomicInMemoryFetchStateRepo()
    const now = new Date()
    await repo.markPermanentFailure({
      companyId: "coA",
      acquisitionMessageId: "m1",
      errorCode: "CONTENT_EMPTY",
      now,
    })
    await repo.markRetryableFailure({
      companyId: "coB",
      acquisitionMessageId: "m1",
      errorCode: "GMAIL_RATE_LIMITED",
      now,
      maxAttempts: 5,
    })
    assert.equal(repo.states.size, 2)
    assert.ok(repo.states.get("coA::m1")?.terminalAt)
    assert.equal(repo.states.get("coB::m1")?.terminalAt, null)
    assert.equal(repo.states.get("coB::m1")?.attemptCount, 1)
  })

  it("état terminal : attemptCount au seuil exact", async () => {
    const repo = new AtomicInMemoryFetchStateRepo()
    const now = new Date()
    const maxAttempts = 3
    const results: MarkFailureResult[] = []
    for (let i = 0; i < maxAttempts; i++) {
      results.push(
        await repo.markRetryableFailure({
          companyId: "co1",
          acquisitionMessageId: "m2",
          errorCode: "CONTENT_FETCH_FAILED",
          now,
          maxAttempts,
        })
      )
    }
    assert.deepEqual(
      results.map((r) => r.terminal),
      [false, false, true]
    )
    assert.equal(repo.states.get("co1::m2")?.attemptCount, 3)
  })

  it("retryable après permanente → ne clear pas terminalAt", async () => {
    const repo = new AtomicInMemoryFetchStateRepo()
    const now = new Date()
    await repo.markPermanentFailure({
      companyId: "co1",
      acquisitionMessageId: "m1",
      errorCode: "CONTENT_EMPTY",
      now,
    })
    const priorTerminal = repo.states.get("co1::m1")?.terminalAt
    assert.ok(priorTerminal)
    const r = await repo.markRetryableFailure({
      companyId: "co1",
      acquisitionMessageId: "m1",
      errorCode: "GMAIL_RATE_LIMITED",
      now: new Date(now.getTime() + 1000),
      maxAttempts: 50,
    })
    assert.equal(r.terminal, true)
    assert.equal(r.attemptCount, 2)
    assert.equal(repo.states.get("co1::m1")?.terminalAt, priorTerminal)
    assert.equal(repo.states.get("co1::m1")?.nextRetryAt, null)
  })
})
