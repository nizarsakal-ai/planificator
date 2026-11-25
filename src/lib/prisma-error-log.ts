/**
 * Journal des erreurs du moteur Prisma, sans le bruit des connexions fermées pendant l'inactivité.
 *
 * Quand Neon ferme une connexion dormante (suspension, instance Vercel gelée), le moteur écrit
 * « Error in PostgreSQL connection: Error { kind: Closed, cause: None } » au moment où il la jette.
 * La requête suivante ouvre une autre connexion et réussit (voir database-url.ts et
 * tests/database/idle-connections.pg.test.ts) : ce message n'est pas une erreur. Il apparaît à chaque
 * réveil, en plusieurs exemplaires, et noie les vraies erreurs.
 *
 * Seul ce message exact est écarté. Toute autre erreur reste écrite comme avant (« prisma:error … »),
 * et une vraie panne de base remonte de toute façon sur la requête (P1001, P1017…).
 */
const BENIGN_CLOSED_CONNECTION = /^Error in PostgreSQL connection: Error \{ kind: Closed, cause: None \}$/

export function isBenignClosedConnectionLog(message: string): boolean {
  return BENIGN_CLOSED_CONNECTION.test(message.trim())
}

export function logPrismaEngineError(
  event: { message: string },
  write: (line: string) => void = (line) => console.error(line),
): void {
  if (isBenignClosedConnectionLog(event.message)) return
  write(`prisma:error ${event.message}`)
}
