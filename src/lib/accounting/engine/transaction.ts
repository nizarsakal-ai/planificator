// Exécution d'une transaction comptable avec reprise bornée des seules erreurs transitoires de concurrence.
// Une transaction qui compose plusieurs opérations (plusieurs sociétés, exercices ou utilisateurs) peut
// rencontrer un interblocage 40P01 face à une autre qui verrouille dans un ordre différent : PostgreSQL
// annule l'une d'elles entièrement ; on la rejoue alors en entier. Les erreurs métier (AccountingError, dont
// SOURCE_CONFLICT) et toute autre erreur ne sont jamais rejouées.
import type { Prisma, PrismaClient } from "@prisma/client"
import { AccountingError } from "./posting"

const TRANSIENT_SQLSTATES: ReadonlySet<string> = new Set(["40P01", "40001"])
const SQLSTATE = /^[0-9A-Z]{5}$/

/**
 * Classification sur codes STRUCTURÉS uniquement (aucune recherche dans le texte du message) :
 * - Prisma (PrismaClientKnownRequestError) : P2034 (conflit d'écriture / interblocage de transaction) ;
 *   P2010 (requête brute) avec meta.code = SQLSTATE — forme observée pour les interblocages : P2010 + meta.code "40P01" ;
 * - erreur de pilote PostgreSQL : code = SQLSTATE ;
 * - sinon, examen de error.cause (profondeur bornée).
 * Une erreur métier (AccountingError, SQLSTATE P0001 levé par RAISE, tout autre code) n'est jamais rejouée.
 */
export function isTransientConcurrencyError(error: unknown, depth = 0): boolean {
  if (depth > 5 || typeof error !== "object" || error === null) return false
  if (error instanceof AccountingError) return false
  const e = error as { name?: unknown; code?: unknown; meta?: { code?: unknown }; cause?: unknown }
  if (e.name === "PrismaClientKnownRequestError") {
    if (e.code === "P2034") return true
    if (e.code === "P2010") return typeof e.meta?.code === "string" && TRANSIENT_SQLSTATES.has(e.meta.code)
    return false
  }
  if (typeof e.code === "string" && SQLSTATE.test(e.code)) return TRANSIENT_SQLSTATES.has(e.code)
  return e.cause !== undefined ? isTransientConcurrencyError(e.cause, depth + 1) : false
}

export interface AccountingTransactionOptions {
  maxAttempts?: number
  /** Observation des reprises (journalisation, métriques) ; ne doit pas lever. */
  onRetry?: (error: unknown, attempt: number) => void
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
      options.onRetry?.(error, attempt)
      await new Promise((r) => setTimeout(r, 20 * attempt + Math.floor(Math.random() * 30)))
    }
  }
}
