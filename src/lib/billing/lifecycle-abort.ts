// ═══════════════════════════════════════════════════════════════════════════
// Abandon métier d'une transaction (mandat Codex §2.6, correctifs P1-03/P1-04/P1-06) : à l'intérieur d'un `$transaction`,
// un refus métier survenant APRÈS une première écriture doit annuler toute la transaction — jamais de persistance partielle,
// jamais de « return { ok: false } » qui laisserait Prisma committer. On lève `LifecycleAbort` ; `withLifecycleAbort`
// l'attrape HORS de la transaction (donc après ROLLBACK) et la convertit en `LifecycleResult` { ok: false }.
// Toute autre exception (contrainte différée, conflit, erreur technique) est propagée telle quelle.
// ═══════════════════════════════════════════════════════════════════════════
import type { LifecycleResult } from "@/lib/billing/quotes/quote-lifecycle.core"

export class LifecycleAbort extends Error {
  constructor(readonly userMessage: string) {
    super(userMessage)
    this.name = "LifecycleAbort"
  }
}

/** Exécute `fn` (qui ouvre sa propre transaction) ; un `LifecycleAbort` levé devient un résultat { ok: false }. */
export async function withLifecycleAbort<T>(fn: () => Promise<LifecycleResult<T>>): Promise<LifecycleResult<T>> {
  try {
    return await fn()
  } catch (e) {
    if (e instanceof LifecycleAbort) return { ok: false, error: e.userMessage }
    throw e
  }
}
