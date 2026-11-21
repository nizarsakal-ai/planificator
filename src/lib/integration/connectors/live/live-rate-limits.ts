/**
 * PLAN-INTEGRATION-PLATFORM-001 — LOT-8D : limites de débit des connexions réelles (SECURITY-SPEC §25, gate 2 du plan
 * LOT-8). Valeurs fixées ici, documentées dans `docs/runbooks/INTEGRATION-RATE-LIMITS.md`, comptées en base (aucun
 * compteur en mémoire, donc valables sur toutes les instances serverless).
 *
 * - Démarrage OAuth : 5 par utilisateur et par 10 minutes, 20 par société et par heure.
 * - Enregistrement d'identifiants (saisie ou retour OAuth) : 5 versions de secret par connexion et par 10 minutes.
 * - Échecs d'authentification répétés : 3 refus du service en 15 minutes verrouillent la connexion 15 minutes après le
 *   dernier refus. Verrou temporaire, sans destruction de données ; la clé active éventuelle reste en service.
 * - Synchronisation réelle : 1 par minute et par connecteur (`LIVE_SYNC_COOLDOWN_MS`, live-sync.service.ts), échecs
 *   compris ; résolution de secret et rafraîchissement OAuth en découlent (un seul par synchronisation, sérialisé).
 */
import type { PrismaClient } from "@prisma/client"

type Db = PrismaClient

export const RATE_LIMITS = {
  oauthStartPerUser: { max: 5, windowMs: 10 * 60_000 },
  oauthStartPerCompany: { max: 20, windowMs: 60 * 60_000 },
  credentialAttemptsPerConnection: { max: 5, windowMs: 10 * 60_000 },
  authFailuresLock: { max: 3, windowMs: 15 * 60_000, lockMs: 15 * 60_000 },
} as const

export const RATE_LIMIT_MESSAGES = {
  oauthStart: "Trop de tentatives de connexion : réessayez dans quelques minutes.",
  credentialAttempts: "Trop d'enregistrements d'identifiants pour ce service : réessayez dans 10 minutes.",
  authLocked: "Le service a refusé plusieurs identifiants de suite : connexion verrouillée 15 minutes, par sécurité. Vérifiez les identifiants avant de réessayer.",
} as const

const since = (now: Date, ms: number) => new Date(now.getTime() - ms)

/** Démarrage OAuth : `null` si autorisé, sinon le message de refus. */
export async function checkOAuthStartLimit(db: Db, ctx: { companyId: string; userId: string }, now: Date): Promise<string | null> {
  const { oauthStartPerUser: u, oauthStartPerCompany: c } = RATE_LIMITS
  const [byUser, byCompany] = await Promise.all([
    db.integrationOAuthState.count({ where: { companyId: ctx.companyId, userId: ctx.userId, createdAt: { gt: since(now, u.windowMs) } } }),
    db.integrationOAuthState.count({ where: { companyId: ctx.companyId, createdAt: { gt: since(now, c.windowMs) } } }),
  ])
  return byUser >= u.max || byCompany >= c.max ? RATE_LIMIT_MESSAGES.oauthStart : null
}

/**
 * Enregistrement d'identifiants sur une connexion : `null` si autorisé, sinon le message de refus. Vérifie d'abord le
 * verrou d'échecs répétés (refus du service journalisés `CREDENTIAL_FAILED`), puis le volume de versions récentes.
 */
export async function checkCredentialAttemptLimit(db: Db, ctx: { companyId: string }, connectionId: string, now: Date): Promise<string | null> {
  const { credentialAttemptsPerConnection: a, authFailuresLock: f } = RATE_LIMITS
  const failures = await db.integrationSecretAuditLog.findMany({
    where: { companyId: ctx.companyId, connectionId, action: "CREDENTIAL_FAILED", createdAt: { gt: since(now, f.windowMs) } },
    orderBy: { createdAt: "desc" }, take: f.max, select: { createdAt: true },
  })
  if (failures.length >= f.max && now.getTime() - failures[0].createdAt.getTime() < f.lockMs) return RATE_LIMIT_MESSAGES.authLocked
  const attempts = await db.integrationCredentialVersion.count({ where: { companyId: ctx.companyId, connectionId, createdAt: { gt: since(now, a.windowMs) } } })
  return attempts >= a.max ? RATE_LIMIT_MESSAGES.credentialAttempts : null
}
