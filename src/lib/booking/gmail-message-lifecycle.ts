/**
 * C-BOOK-001 — Cycle de vie ProcessedGmailMessage (Booking).
 * Acquisition n'utilise pas cette table.
 */

import type {
  BookingGmailMessageStatus,
  BookingGmailResultType,
  Prisma,
  PrismaClient,
  ProcessedGmailMessage,
} from "@prisma/client"
import { prisma } from "@/lib/prisma"
import {
  classifyBookingError,
  type ClassifiedBookingError,
} from "@/lib/booking/booking-gmail-errors"

/** Tentatives max avant PERMANENTLY_IGNORED (configurable via env). */
export function getBookingGmailMaxAttempts(): number {
  const raw = Number(process.env.BOOKING_GMAIL_MAX_ATTEMPTS)
  if (Number.isFinite(raw) && raw >= 1 && raw <= 20) return Math.floor(raw)
  return 5
}

/** TTL d'un PROCESSING abandonné (ms). Défaut 15 min. */
export function getBookingGmailProcessingStaleMs(): number {
  const raw = Number(process.env.BOOKING_GMAIL_PROCESSING_STALE_MS)
  if (Number.isFinite(raw) && raw >= 60_000 && raw <= 3_600_000) return Math.floor(raw)
  return 15 * 60 * 1000
}

const BASE_RETRY_MS = 5 * 60 * 1000
const MAX_RETRY_MS = 6 * 60 * 60 * 1000

export function computeNextRetryAt(attemptCount: number, now = new Date()): Date {
  const exp = Math.max(0, attemptCount - 1)
  const delay = Math.min(MAX_RETRY_MS, BASE_RETRY_MS * 2 ** exp)
  return new Date(now.getTime() + delay)
}

export type BookingLifecycleDb = PrismaClient | Prisma.TransactionClient

export type ClaimOutcome =
  | { action: "CLAIMED"; record: ProcessedGmailMessage; isNew: boolean }
  | { action: "SKIP"; reason: "SUCCEEDED" | "PERMANENTLY_IGNORED" | "NOT_DUE" | "IN_FLIGHT" }

export interface MarkSuccessInput {
  companyId: string
  messageId: string
  now?: Date
}

export interface MarkFailureInput {
  companyId: string
  messageId: string
  error: unknown
  now?: Date
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code: string }).code === "P2002"
  )
}

export class BookingGmailMessageLifecycle {
  constructor(private readonly db: BookingLifecycleDb = prisma) {}

  /**
   * Réserve un message pour traitement (création PROCESSING ou reprise).
   * Concurrence : contrainte unique + updateMany conditionnel.
   */
  async claimForProcessing(
    companyId: string,
    messageId: string,
    now = new Date(),
    _reentry = false
  ): Promise<ClaimOutcome> {
    const maxAttempts = getBookingGmailMaxAttempts()
    const staleBefore = new Date(now.getTime() - getBookingGmailProcessingStaleMs())

    try {
      const created = await this.db.processedGmailMessage.create({
        data: {
          companyId,
          messageId,
          status: "PROCESSING",
          attemptCount: 1,
          firstAttemptAt: now,
          lastAttemptAt: now,
          nextRetryAt: null,
          errorCode: null,
          errorMessage: null,
          resultType: null,
          resultEntityId: null,
          succeededAt: null,
        },
      })
      return { action: "CLAIMED", record: created, isNew: true }
    } catch (error) {
      if (!isUniqueViolation(error)) throw error
    }

    const existing = await this.db.processedGmailMessage.findUnique({
      where: { companyId_messageId: { companyId, messageId } },
    })
    if (!existing) {
      if (_reentry) throw new Error("BOOKING_GMAIL_CLAIM_RACE")
      return this.claimForProcessing(companyId, messageId, now, true)
    }

    if (existing.status === "SUCCEEDED") {
      return { action: "SKIP", reason: "SUCCEEDED" }
    }
    if (existing.status === "PERMANENTLY_IGNORED") {
      return { action: "SKIP", reason: "PERMANENTLY_IGNORED" }
    }

    if (existing.status === "RETRYABLE_FAILURE") {
      if (existing.attemptCount >= maxAttempts) {
        await this.db.processedGmailMessage.updateMany({
          where: {
            id: existing.id,
            status: "RETRYABLE_FAILURE",
            attemptCount: existing.attemptCount,
          },
          data: {
            status: "PERMANENTLY_IGNORED",
            errorCode: existing.errorCode ?? "MAX_ATTEMPTS_EXCEEDED",
            errorMessage: existing.errorMessage ?? "Nombre maximal de tentatives atteint",
            nextRetryAt: null,
            lastAttemptAt: now,
            resultType: "IGNORED",
          },
        })
        return { action: "SKIP", reason: "PERMANENTLY_IGNORED" }
      }
      if (existing.nextRetryAt && existing.nextRetryAt > now) {
        return { action: "SKIP", reason: "NOT_DUE" }
      }
      const updated = await this.db.processedGmailMessage.updateMany({
        where: {
          id: existing.id,
          status: "RETRYABLE_FAILURE",
          attemptCount: existing.attemptCount,
        },
        data: {
          status: "PROCESSING",
          attemptCount: { increment: 1 },
          lastAttemptAt: now,
          nextRetryAt: null,
          errorCode: null,
          errorMessage: null,
        },
      })
      if (updated.count === 0) return { action: "SKIP", reason: "IN_FLIGHT" }
      const record = await this.db.processedGmailMessage.findUniqueOrThrow({
        where: { id: existing.id },
      })
      return { action: "CLAIMED", record, isNew: false }
    }

    // PROCESSING stale → reclaim (updateMany conditionnel = anti-TOCTOU)
    if (existing.status === "PROCESSING") {
      const isFresh =
        existing.lastAttemptAt !== null && existing.lastAttemptAt > staleBefore
      if (isFresh) {
        return { action: "SKIP", reason: "IN_FLIGHT" }
      }
      if (existing.attemptCount >= maxAttempts) {
        await this.db.processedGmailMessage.updateMany({
          where: {
            id: existing.id,
            status: "PROCESSING",
            attemptCount: existing.attemptCount,
          },
          data: {
            status: "PERMANENTLY_IGNORED",
            errorCode: "MAX_ATTEMPTS_EXCEEDED",
            errorMessage: "PROCESSING abandonné — max tentatives",
            nextRetryAt: null,
            lastAttemptAt: now,
            resultType: "IGNORED",
          },
        })
        return { action: "SKIP", reason: "PERMANENTLY_IGNORED" }
      }
      const updated = await this.db.processedGmailMessage.updateMany({
        where: {
          id: existing.id,
          status: "PROCESSING",
          attemptCount: existing.attemptCount,
          OR: [
            { lastAttemptAt: { lte: staleBefore } },
            { lastAttemptAt: null },
          ],
        },
        data: {
          attemptCount: { increment: 1 },
          lastAttemptAt: now,
          nextRetryAt: null,
          errorCode: null,
          errorMessage: null,
        },
      })
      if (updated.count === 0) return { action: "SKIP", reason: "IN_FLIGHT" }
      const record = await this.db.processedGmailMessage.findUniqueOrThrow({
        where: { id: existing.id },
      })
      return { action: "CLAIMED", record, isNew: false }
    }

    return { action: "SKIP", reason: "IN_FLIGHT" }
  }

  /**
   * Succès atomique : le caller fournit un callback qui crée/récupère le résultat
   * dans la même transaction, puis le suivi passe en SUCCEEDED.
   */
  async markSucceededInTransaction(
    input: MarkSuccessInput,
    createOrGetResult: (
      tx: Prisma.TransactionClient
    ) => Promise<{ resultType: BookingGmailResultType; resultEntityId: string | null }>,
    txRunner: PrismaClient = prisma
  ): Promise<ProcessedGmailMessage> {
    const now = input.now ?? new Date()
    return txRunner.$transaction(async (tx) => {
      const { resultType, resultEntityId } = await createOrGetResult(tx)
      const updated = await tx.processedGmailMessage.updateMany({
        where: {
          companyId: input.companyId,
          messageId: input.messageId,
          status: "PROCESSING",
        },
        data: {
          status: "SUCCEEDED",
          succeededAt: now,
          lastAttemptAt: now,
          nextRetryAt: null,
          errorCode: null,
          errorMessage: null,
          resultType,
          resultEntityId,
        },
      })
      if (updated.count === 0) {
        throw new Error(BOOKING_GMAIL_SUCCESS_STATUS_UPDATE_FAILED)
      }
      return tx.processedGmailMessage.findUniqueOrThrow({
        where: {
          companyId_messageId: {
            companyId: input.companyId,
            messageId: input.messageId,
          },
        },
      })
    })
  }

  /**
   * Enregistre un échec uniquement si le message est encore PROCESSING.
   * Ne peut pas écraser SUCCEEDED / PERMANENTLY_IGNORED (course stale reclaim).
   */
  async markFailure(input: MarkFailureInput): Promise<ProcessedGmailMessage> {
    const now = input.now ?? new Date()
    const classified = classifyBookingError(input.error)
    const maxAttempts = getBookingGmailMaxAttempts()

    const existing = await this.db.processedGmailMessage.findUnique({
      where: {
        companyId_messageId: {
          companyId: input.companyId,
          messageId: input.messageId,
        },
      },
    })
    if (!existing) {
      throw new Error("BOOKING_GMAIL_TRACKING_NOT_FOUND")
    }

    // Un autre worker a déjà finalisé : ne pas régresser le statut.
    if (
      existing.status === "SUCCEEDED" ||
      existing.status === "PERMANENTLY_IGNORED"
    ) {
      return existing
    }
    if (existing.status !== "PROCESSING") {
      return existing
    }

    const attempts = existing.attemptCount
    let status: BookingGmailMessageStatus
    let nextRetryAt: Date | null = null

    if (classified.kind === "PERMANENT") {
      status = "PERMANENTLY_IGNORED"
    } else if (attempts >= maxAttempts) {
      status = "PERMANENTLY_IGNORED"
    } else {
      status = "RETRYABLE_FAILURE"
      nextRetryAt = computeNextRetryAt(attempts, now)
    }

    const updated = await this.db.processedGmailMessage.updateMany({
      where: {
        id: existing.id,
        status: "PROCESSING",
        attemptCount: existing.attemptCount,
      },
      data: {
        status,
        lastAttemptAt: now,
        nextRetryAt,
        errorCode:
          status === "PERMANENTLY_IGNORED" && classified.kind === "RETRYABLE"
            ? "MAX_ATTEMPTS_EXCEEDED"
            : classified.code,
        errorMessage:
          status === "PERMANENTLY_IGNORED" && classified.kind === "RETRYABLE"
            ? `Max tentatives (${maxAttempts}) — ${classified.message}`
            : classified.message,
        resultType: status === "PERMANENTLY_IGNORED" ? "IGNORED" : existing.resultType,
      },
    })

    if (updated.count === 0) {
      return this.db.processedGmailMessage.findUniqueOrThrow({
        where: { id: existing.id },
      })
    }

    return this.db.processedGmailMessage.findUniqueOrThrow({
      where: { id: existing.id },
    })
  }

  async markPermanentIgnored(
    companyId: string,
    messageId: string,
    error: ClassifiedBookingError,
    now = new Date()
  ): Promise<ProcessedGmailMessage> {
    const updated = await this.db.processedGmailMessage.updateMany({
      where: {
        companyId,
        messageId,
        status: "PROCESSING",
      },
      data: {
        status: "PERMANENTLY_IGNORED",
        lastAttemptAt: now,
        nextRetryAt: null,
        errorCode: error.code,
        errorMessage: error.message,
        resultType: "IGNORED",
        succeededAt: null,
      },
    })
    if (updated.count === 0) {
      return this.db.processedGmailMessage.findUniqueOrThrow({
        where: { companyId_messageId: { companyId, messageId } },
      })
    }
    return this.db.processedGmailMessage.findUniqueOrThrow({
      where: { companyId_messageId: { companyId, messageId } },
    })
  }
}

/** Erreur levée si le passage à SUCCEEDED échoue (souvent course concurrente). */
export const BOOKING_GMAIL_SUCCESS_STATUS_UPDATE_FAILED =
  "BOOKING_GMAIL_SUCCESS_STATUS_UPDATE_FAILED"

export const bookingGmailMessageLifecycle = new BookingGmailMessageLifecycle()
