import type { Prisma } from "@prisma/client"

/**
 * Prisma 5.x avale l'erreur levée au COMMIT d'une transaction interactive (`$transaction(async tx => …)`) :
 * la base annule bien la transaction, mais la promesse est résolue comme si tout avait réussi.
 * Toute contrainte ou tout trigger « DEFERRABLE INITIALLY DEFERRED » doit donc être évalué AVANT le COMMIT
 * en appelant cette fonction en dernière instruction de la transaction : une violation lève alors une
 * exception dans la transaction, propagée à l'appelant.
 *
 * - Sans `names` : `SET CONSTRAINTS ALL IMMEDIATE` (à appeler en DERNIER, l'état reste immédiat).
 * - Avec `names` : seules ces contraintes sont contrôlées maintenant puis remises en différé, ce qui ne
 *   préjuge pas des autres invariants différés d'une transaction englobante.
 */
const IDENTIFIER = /^[a-z_][a-z0-9_]{0,62}$/

export async function flushDeferredConstraints(tx: Prisma.TransactionClient, names?: readonly string[]): Promise<void> {
  if (!names) {
    await tx.$executeRawUnsafe(`SET CONSTRAINTS ALL IMMEDIATE`)
    return
  }
  if (names.length === 0) return
  for (const n of names) {
    if (!IDENTIFIER.test(n)) throw new Error(`flushDeferredConstraints: identifiant de contrainte invalide (${n}).`)
  }
  const list = names.map((n) => `"${n}"`).join(", ")
  await tx.$executeRawUnsafe(`SET CONSTRAINTS ${list} IMMEDIATE`)
  await tx.$executeRawUnsafe(`SET CONSTRAINTS ${list} DEFERRED`)
}
