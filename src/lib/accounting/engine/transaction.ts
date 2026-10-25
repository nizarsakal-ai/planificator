// Exécution d'une transaction comptable avec reprise bornée des seules erreurs transitoires de concurrence.
// Une transaction qui compose plusieurs opérations (plusieurs sociétés, exercices ou utilisateurs) peut
// rencontrer un interblocage 40P01 face à une autre qui verrouille dans un ordre différent : PostgreSQL
// annule l'une d'elles entièrement ; on la rejoue alors en entier. Les erreurs métier (AccountingError, dont
// SOURCE_CONFLICT) et toute autre erreur ne sont jamais rejouées.
import type { Prisma, PrismaClient } from "@prisma/client"
import { AccountingError } from "./posting"

const TRANSIENT_SQLSTATES = ["40P01", "40001"] as const

export function isTransientConcurrencyError(error: unknown): boolean {
  if (error instanceof AccountingError) return false
  if (typeof error !== "object" || error === null) return false
  const code = (error as { code?: unknown }).code
  if (code === "P2034") return true // Prisma : conflit d'écriture ou interblocage, transaction à rejouer
  const message = String((error as { message?: unknown }).message ?? "")
  return TRANSIENT_SQLSTATES.some((s) => message.includes(s)) || /deadlock detected|could not serialize access/i.test(message)
}

export interface AccountingTransactionOptions {
  maxAttempts?: number
  timeoutMs?: number
  maxWaitMs?: number
}

export async function runAccountingTransaction<T>(
  db: PrismaClient,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
  options: AccountingTransactionOptions = {}
): Promise<T> {
  const maxAttempts = options.maxAttempts ?? 3
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 10) throw new RangeError("maxAttempts ∈ [1, 10]")
  for (let attempt = 1; ; attempt++) {
    try {
      return await db.$transaction(fn, { timeout: options.timeoutMs ?? 15000, maxWait: options.maxWaitMs ?? 10000 })
    } catch (error) {
      if (attempt >= maxAttempts || !isTransientConcurrencyError(error)) throw error
      await new Promise((r) => setTimeout(r, 20 * attempt + Math.floor(Math.random() * 30)))
    }
  }
}
