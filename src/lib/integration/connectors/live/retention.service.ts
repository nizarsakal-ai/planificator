/**
 * PLAN-INTEGRATION-PLATFORM-001 — LOT-8D : rétention RGPD des connexions réelles (SECURITY-SPEC §28 ; fiche de traitement
 * validée par Nizar le 22/11/2026, voir docs/integration-platform-001-lot-8d-gates.plan.md).
 *
 * - Zone de transit : élément non synchronisé depuis plus de 365 jours ⇒ supprimé. L'âge est revérifié par la base
 *   (déclencheur, horloge du serveur) : une erreur d'horloge applicative ne peut rien supprimer de plus récent.
 * - Coffre : version REVOKED, RETIRED ou FAILED depuis plus de 90 jours ⇒ destruction cryptographique (DESTROYED) : DEK
 *   enveloppée et chiffré remplacés par des zéros, indice effacé. La ligne et le journal d'audit sont conservés.
 * - Effacement ciblé d'un élément (droit des personnes), par un ADMIN de la société de session, journalisé.
 * Aucune valeur, aucun contenu d'élément n'est journalisé : seulement des compteurs.
 */
import type { PrismaClient } from "@prisma/client"
import { resolveSecretEnvironment } from "@/lib/integration/secrets/keyring"

type Db = PrismaClient

export const RETENTION = { stagedDays: 365, credentialDays: 90 } as const
export const RETENTION_ACTOR = "retention-service"

const ZERO = (n: number) => Buffer.alloc(n)

export interface RetentionSummary { stagedPurged: number; credentialsDestroyed: number }

/** Supprime les éléments de zone de transit non synchronisés depuis plus de 365 jours (toutes sociétés). */
export async function purgeExpiredStagedRecords(db: Db): Promise<number> {
  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT set_config('planificator.retention_purge', 'on', true)`
    return tx.$executeRaw`DELETE FROM "connector_staged_records" WHERE "updatedAt" < (now() AT TIME ZONE 'UTC') - make_interval(days => ${RETENTION.stagedDays}::int)`
  })
}

/** Détruit cryptographiquement les versions de secret terminées depuis plus de 90 jours (toutes sociétés). */
export async function destroyExpiredCredentials(db: Db, environment = resolveSecretEnvironment()): Promise<number> {
  const due = await db.$queryRaw<{ id: string; companyId: string; connectionId: string; credentialsRef: string; secretVersion: number }[]>`
    SELECT "id", "companyId", "connectionId", "credentialsRef", "secretVersion" FROM "integration_credential_versions"
    WHERE ("status" = 'REVOKED' AND "revokedAt" < (now() AT TIME ZONE 'UTC') - make_interval(days => ${RETENTION.credentialDays}::int))
       OR ("status" = 'RETIRED' AND "retiredAt" < (now() AT TIME ZONE 'UTC') - make_interval(days => ${RETENTION.credentialDays}::int))
       OR ("status" = 'FAILED' AND "failedAt" < (now() AT TIME ZONE 'UTC') - make_interval(days => ${RETENTION.credentialDays}::int))
    ORDER BY "companyId", "id" LIMIT 500`
  let destroyed = 0
  for (const v of due) {
    await db.$transaction(async (tx) => {
      const r = await tx.integrationCredentialVersion.updateMany({
        where: { id: v.id, companyId: v.companyId, status: { in: ["REVOKED", "RETIRED", "FAILED"] } },
        data: { status: "DESTROYED", destroyedAt: new Date(), keyId: "destroyed", hint: null, wrappedDek: ZERO(32), dekNonce: ZERO(12), dekTag: ZERO(16), nonce: ZERO(12), tag: ZERO(16), ciphertext: ZERO(1) },
      })
      if (r.count !== 1) return
      await tx.integrationSecretAuditLog.create({ data: { companyId: v.companyId, connectionId: v.connectionId, credentialsRef: v.credentialsRef, action: "CREDENTIAL_DESTROYED", outcome: "SUCCESS", reasonCode: "RETENTION_EXPIRED", secretVersion: v.secretVersion, environment, actorId: RETENTION_ACTOR } })
      destroyed++
    })
  }
  return destroyed
}

export async function runConnectorRetention(db: Db): Promise<RetentionSummary> {
  const stagedPurged = await purgeExpiredStagedRecords(db)
  const credentialsDestroyed = await destroyExpiredCredentials(db)
  return { stagedPurged, credentialsDestroyed }
}

/** Effacement ciblé d'un élément de zone de transit de la société de session (droit des personnes), journalisé. */
export async function eraseStagedRecord(db: Db, ctx: { companyId: string; userId: string }, recordId: string): Promise<boolean> {
  return db.$transaction(async (tx) => {
    const rec = await tx.connectorStagedRecord.findFirst({ where: { id: recordId, companyId: ctx.companyId }, select: { id: true, connectorKey: true, resource: true } })
    if (!rec) return false
    await tx.$queryRaw`SELECT set_config('planificator.staged_erasure_id', ${rec.id}, true)`
    const n = await tx.$executeRaw`DELETE FROM "connector_staged_records" WHERE "id" = ${rec.id} AND "companyId" = ${ctx.companyId}`
    if (n !== 1) return false
    await tx.historyLog.create({ data: { companyId: ctx.companyId, actorId: ctx.userId, action: "STATUS_CHANGED", entityType: "ConnectorStagedRecord", entityId: rec.id, detail: `Effacement sur demande d'un élément reçu (${rec.connectorKey} / ${rec.resource})` } })
    return true
  })
}
