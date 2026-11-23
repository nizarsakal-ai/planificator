/**
 * PLAN-INTEGRATION-PLATFORM-001 — LOT-8A : Secret Provider PLATFORM_ENCRYPTED (SECURITY-SPEC §7 à §12, §14, §18).
 *
 * - Toute opération est bornée par (companyId, connectionId) ; le handle `credentialsRef` n'est jamais utilisé seul.
 * - Cycle de vie : version PENDING → ACTIVE (après validation par l'appelant) → RETIRED (bascule suivante) ou REVOKED ;
 *   PENDING → FAILED si la validation échoue. Bascule et révocation sous verrou `FOR UPDATE` de la connexion : deux
 *   rotations du même handle sont sérialisées (§9.2) ; la base refuse deux versions ACTIVE (index partiel).
 * - Résolution du clair réservée aux appelants techniques autorisés (§12), jamais à l'UI ni au domaine métier.
 * - Aucun cache de clair (§20). Aucune valeur secrète en journal ni en audit (§17, §18) ; erreurs = codes §21.
 */
import { randomUUID } from "node:crypto"
import type { Prisma, PrismaClient } from "@prisma/client"
import { loadKeyring, resolveSecretEnvironment, type Keyring, type SecretEnvironment } from "@/lib/integration/secrets/keyring"
import { openSecret, rewrapDek, sealSecret, secretHint, type SecretAadFields, type SecretKind } from "@/lib/integration/secrets/envelope"
import { SecretProviderError, type SecretErrorCode } from "@/lib/integration/secrets/secret-errors"

type Db = PrismaClient
type Tx = Prisma.TransactionClient

export interface SecretProviderDeps { keyring?: Keyring; environment?: SecretEnvironment; now?: () => Date }
interface ResolvedDeps { keyring: () => Keyring; environment: SecretEnvironment; now: () => Date }
function deps(d: SecretProviderDeps = {}): ResolvedDeps {
  let cached: Keyring | undefined = d.keyring
  return { keyring: () => (cached ??= loadKeyring()), environment: d.environment ?? resolveSecretEnvironment(), now: d.now ?? (() => new Date()) }
}

/** Appelants autorisés à obtenir un clair (§12). Toute autre identité est refusée. */
export const SECRET_RESOLVERS = ["connector-runtime", "rotation-service", "revocation-service"] as const
export type SecretResolver = (typeof SECRET_RESOLVERS)[number]

export type AuditAction = "CREDENTIAL_CREATED" | "CREDENTIAL_ACTIVATED" | "CREDENTIAL_RETIRED" | "CREDENTIAL_FAILED" | "CREDENTIAL_REVOKED" | "DEK_REWRAPPED" | "RESOLUTION_DENIED"
const fail = (code: SecretErrorCode): never => { throw new SecretProviderError(code) }

interface LockedConnection { id: string; companyId: string; secretBackend: string; credentialsRef: string | null; status: string; credentialStatus: string }
async function lockConnection(tx: Tx, companyId: string, connectionId: string): Promise<LockedConnection> {
  const rows = await tx.$queryRaw<LockedConnection[]>`
    SELECT "id", "companyId", "secretBackend"::text AS "secretBackend", "credentialsRef", "status"::text AS "status", "credentialStatus"::text AS "credentialStatus"
    FROM "integration_connections" WHERE "id" = ${connectionId} AND "companyId" = ${companyId} FOR UPDATE`
  const c = rows[0] ?? fail("CONNECTION_FORBIDDEN")
  if (c.secretBackend !== "PLATFORM_ENCRYPTED") fail("SECRET_BACKEND_MISMATCH")
  return c
}

async function audit(tx: Tx | Db, e: { companyId: string; connectionId: string; credentialsRef: string | null; action: AuditAction; outcome: "SUCCESS" | "FAILURE"; reasonCode?: string | null; secretVersion?: number | null; environment: SecretEnvironment; actorId: string }) {
  await tx.integrationSecretAuditLog.create({ data: { companyId: e.companyId, connectionId: e.connectionId, credentialsRef: e.credentialsRef, action: e.action, outcome: e.outcome, reasonCode: e.reasonCode ?? null, secretVersion: e.secretVersion ?? null, environment: e.environment, actorId: e.actorId } })
}

const versionSelect = { id: true, companyId: true, connectionId: true, credentialsRef: true, secretKind: true, environment: true, secretVersion: true, status: true, keyId: true, encVersion: true, wrappedDek: true, dekNonce: true, dekTag: true, ciphertext: true, nonce: true, tag: true } as const
type VersionRow = Prisma.IntegrationCredentialVersionGetPayload<{ select: typeof versionSelect }>
const aadOf = (v: VersionRow): SecretAadFields => ({ companyId: v.companyId, connectionId: v.connectionId, credentialsRef: v.credentialsRef, secretKind: v.secretKind as SecretKind, environment: v.environment as SecretEnvironment, secretVersion: v.secretVersion })
const sealedOf = (v: VersionRow) => ({ keyId: v.keyId, encVersion: v.encVersion, wrappedDek: Buffer.from(v.wrappedDek), dekNonce: Buffer.from(v.dekNonce), dekTag: Buffer.from(v.dekTag), ciphertext: Buffer.from(v.ciphertext), nonce: Buffer.from(v.nonce), tag: Buffer.from(v.tag) })

/** Donne à une connexion PLATFORM_ENCRYPTED son handle stable (créé une seule fois, jamais modifié ensuite). */
export async function assignCredentialsRef(db: Db, input: { companyId: string; connectionId: string }): Promise<string> {
  return db.$transaction(async (tx) => {
    const c = await lockConnection(tx, input.companyId, input.connectionId)
    if (c.credentialsRef) return c.credentialsRef
    const ref = `cred_${randomUUID().replace(/-/g, "")}`
    await tx.integrationConnection.update({ where: { id_companyId: { id: c.id, companyId: c.companyId } }, data: { credentialsRef: ref } })
    return ref
  })
}

/** Enregistre un nouveau secret en version PENDING (jamais utilisable avant `activateCredential`). */
export async function storeCredential(
  db: Db,
  input: { companyId: string; connectionId: string; secretKind: SecretKind; plaintext: string; actorId: string },
  d: SecretProviderDeps = {},
): Promise<{ versionId: string; secretVersion: number; hint: string | null }> {
  const x = deps(d)
  const keyring = x.keyring()
  return db.$transaction(async (tx) => storeInTx(tx, await lockConnection(tx, input.companyId, input.connectionId), input, x, keyring))
}

async function storeInTx(
  tx: Tx, c: LockedConnection, input: { secretKind: SecretKind; plaintext: string; actorId: string }, x: ResolvedDeps, keyring: Keyring,
): Promise<{ versionId: string; secretVersion: number; hint: string | null }> {
  const credentialsRef = c.credentialsRef ?? fail("SECRET_NOT_CONFIGURED")
  const last = await tx.integrationCredentialVersion.findFirst({ where: { companyId: c.companyId, credentialsRef }, orderBy: { secretVersion: "desc" }, select: { secretVersion: true } })
  const secretVersion = (last?.secretVersion ?? 0) + 1
  const aad: SecretAadFields = { companyId: c.companyId, connectionId: c.id, credentialsRef, secretKind: input.secretKind, environment: x.environment, secretVersion }
  const sealed = sealSecret(input.plaintext, aad, keyring)
  const hint = secretHint(input.plaintext)
  const v = await tx.integrationCredentialVersion.create({
    data: { companyId: c.companyId, connectionId: c.id, credentialsRef, secretKind: input.secretKind, environment: x.environment, secretVersion, ...sealed, hint, createdById: input.actorId },
    select: { id: true },
  })
  if (c.credentialStatus === "MISSING" || c.credentialStatus === "FAILED") {
    await tx.integrationConnection.update({ where: { id_companyId: { id: c.id, companyId: c.companyId } }, data: { credentialStatus: "PENDING" } })
  }
  await audit(tx, { companyId: c.companyId, connectionId: c.id, credentialsRef, action: "CREDENTIAL_CREATED", outcome: "SUCCESS", secretVersion, environment: x.environment, actorId: input.actorId })
  return { versionId: v.id, secretVersion, hint }
}

/** Bascule atomique (§9.1) : la version PENDING validée devient ACTIVE, l'ancienne ACTIVE devient RETIRED. */
export async function activateCredential(db: Db, input: { companyId: string; connectionId: string; versionId: string; actorId: string }, d: SecretProviderDeps = {}): Promise<void> {
  const x = deps(d)
  await db.$transaction(async (tx) => activateInTx(tx, await lockConnection(tx, input.companyId, input.connectionId), input, x))
}

async function activateInTx(tx: Tx, c: LockedConnection, input: { versionId: string; actorId: string }, x: ResolvedDeps): Promise<void> {
  const v = await tx.integrationCredentialVersion.findFirst({ where: { id: input.versionId, companyId: c.companyId, connectionId: c.id, credentialsRef: c.credentialsRef ?? "" }, select: { id: true, status: true, secretVersion: true, credentialsRef: true, environment: true } })
  if (!v || v.status !== "PENDING" || v.environment !== x.environment) fail("ROTATION_FAILED")
  const now = x.now()
  const previous = await tx.integrationCredentialVersion.findMany({ where: { companyId: c.companyId, credentialsRef: v!.credentialsRef, status: "ACTIVE" }, select: { id: true, secretVersion: true } })
  for (const p of previous) {
    await tx.integrationCredentialVersion.update({ where: { id: p.id }, data: { status: "RETIRED", retiredAt: now } })
    await audit(tx, { companyId: c.companyId, connectionId: c.id, credentialsRef: v!.credentialsRef, action: "CREDENTIAL_RETIRED", outcome: "SUCCESS", secretVersion: p.secretVersion, environment: x.environment, actorId: input.actorId })
  }
  await tx.integrationCredentialVersion.update({ where: { id: v!.id }, data: { status: "ACTIVE", activatedAt: now } })
  await tx.integrationConnection.update({ where: { id_companyId: { id: c.id, companyId: c.companyId } }, data: { credentialStatus: "ACTIVE" } })
  await audit(tx, { companyId: c.companyId, connectionId: c.id, credentialsRef: v!.credentialsRef, action: "CREDENTIAL_ACTIVATED", outcome: "SUCCESS", secretVersion: v!.secretVersion, environment: x.environment, actorId: input.actorId })
}

/** Validation échouée : PENDING → FAILED ; la version ACTIVE éventuelle reste inchangée (aucune coupure, §9.1). */
export async function failCredential(db: Db, input: { companyId: string; connectionId: string; versionId: string; actorId: string; reasonCode: string }, d: SecretProviderDeps = {}): Promise<void> {
  const x = deps(d)
  await db.$transaction(async (tx) => {
    const c = await lockConnection(tx, input.companyId, input.connectionId)
    const v = await tx.integrationCredentialVersion.findFirst({ where: { id: input.versionId, companyId: c.companyId, connectionId: c.id }, select: { id: true, status: true, secretVersion: true, credentialsRef: true } })
    if (!v || v.status !== "PENDING") fail("ROTATION_FAILED")
    await tx.integrationCredentialVersion.update({ where: { id: v!.id }, data: { status: "FAILED", failedAt: x.now() } })
    const hasActive = await tx.integrationCredentialVersion.count({ where: { companyId: c.companyId, credentialsRef: v!.credentialsRef, status: "ACTIVE" } })
    if (!hasActive) await tx.integrationConnection.update({ where: { id_companyId: { id: c.id, companyId: c.companyId } }, data: { credentialStatus: "FAILED" } })
    await audit(tx, { companyId: c.companyId, connectionId: c.id, credentialsRef: v!.credentialsRef, action: "CREDENTIAL_FAILED", outcome: "FAILURE", reasonCode: input.reasonCode, secretVersion: v!.secretVersion, environment: x.environment, actorId: input.actorId })
  })
}

/** Révocation (§9.3) : la version ACTIVE devient REVOKED ; aucune résolution n'est plus possible. */
export async function revokeCredential(db: Db, input: { companyId: string; connectionId: string; actorId: string; reasonCode: string }, d: SecretProviderDeps = {}): Promise<void> {
  const x = deps(d)
  if (!/^[A-Z_]{2,60}$/.test(input.reasonCode)) fail("REVOCATION_FAILED")
  await db.$transaction(async (tx) => {
    const c = await lockConnection(tx, input.companyId, input.connectionId)
    const credentialsRef = c.credentialsRef ?? fail("REVOCATION_FAILED")
    const active = await tx.integrationCredentialVersion.findFirst({ where: { companyId: c.companyId, credentialsRef, status: "ACTIVE" }, select: { id: true, secretVersion: true } })
    if (!active) fail("REVOCATION_FAILED")
    await tx.integrationCredentialVersion.update({ where: { id: active!.id }, data: { status: "REVOKED", revokedAt: x.now(), revokedReason: input.reasonCode } })
    await tx.integrationConnection.update({ where: { id_companyId: { id: c.id, companyId: c.companyId } }, data: { credentialStatus: "REVOKED" } })
    await audit(tx, { companyId: c.companyId, connectionId: c.id, credentialsRef, action: "CREDENTIAL_REVOKED", outcome: "SUCCESS", reasonCode: input.reasonCode, secretVersion: active!.secretVersion, environment: x.environment, actorId: input.actorId })
  })
}

/**
 * Résolution du clair (§12) : version ACTIVE du handle de CETTE connexion, de CETTE société, du type demandé, dans
 * l'environnement courant. Refus par code générique ; le clair n'est ni journalisé ni mis en cache.
 */
export async function resolveCredential(
  db: Db,
  input: { companyId: string; connectionId: string; secretKind: SecretKind; runtimeCallerId: string; environment: SecretEnvironment },
  d: SecretProviderDeps = {},
): Promise<string> {
  const x = deps(d)
  if (!(SECRET_RESOLVERS as readonly string[]).includes(input.runtimeCallerId)) fail("CONNECTION_FORBIDDEN")
  if (input.environment !== x.environment) fail("SECURITY_CONFIGURATION_INVALID")
  const c = await db.integrationConnection.findFirst({ where: { id: input.connectionId, companyId: input.companyId }, select: { id: true, companyId: true, secretBackend: true, credentialsRef: true, status: true, credentialStatus: true } })
  if (!c) return fail("CONNECTION_FORBIDDEN")
  const deny = async (code: SecretErrorCode): Promise<never> => {
    await audit(db, { companyId: c.companyId, connectionId: c.id, credentialsRef: c.credentialsRef, action: "RESOLUTION_DENIED", outcome: "FAILURE", reasonCode: code, environment: x.environment, actorId: input.runtimeCallerId })
    return fail(code)
  }
  if (c.secretBackend !== "PLATFORM_ENCRYPTED") return deny("SECRET_BACKEND_MISMATCH")
  if (c.status === "DISABLED" || c.status === "ARCHIVED") return deny("CONNECTION_FORBIDDEN")
  if (c.credentialStatus === "REVOKED") return deny("CONNECTION_AUTH_REVOKED")
  if (!c.credentialsRef) return deny("SECRET_NOT_CONFIGURED")
  const v = await db.integrationCredentialVersion.findFirst({ where: { companyId: c.companyId, connectionId: c.id, credentialsRef: c.credentialsRef, status: "ACTIVE" }, select: versionSelect })
  if (!v || v.secretKind !== input.secretKind || v.environment !== x.environment) return deny("SECRET_NOT_CONFIGURED")
  return openSecret(sealedOf(v), aadOf(v), x.keyring())
}

/**
 * Utilisation d'un secret sous verrou de la connexion, avec renouvellement éventuel (§9.2, §10.1) : UNE transaction et
 * donc UNE connexion du pool (aucune autre requête n'est ouverte pendant qu'elle est tenue, ce qui interdit l'interblocage
 * d'un pool à une seule connexion). Sous verrou `FOR UPDATE` de la connexion : relecture de la version ACTIVE (la
 * dernière, même si un appel concurrent vient de la renouveler), appel de `use` avec le clair, puis, si `use` renvoie un
 * remplaçant, nouvelle version ACTIVE et ancienne RETIRED, dans la même transaction. Deux appels pour la même connexion
 * sont donc sérialisés. Les refus sont d'abord vérifiés et audités par `resolveCredential`, hors transaction.
 */
export async function useCredentialUnderLock<T>(
  db: Db,
  input: { companyId: string; connectionId: string; secretKind: SecretKind; runtimeCallerId: string; environment: SecretEnvironment },
  use: (plaintext: string) => Promise<{ result: T; replacement: string | null }>,
  d: SecretProviderDeps = {},
  opts: { timeoutMs?: number } = {},
): Promise<T> {
  const x = deps(d)
  await resolveCredential(db, input, d) // refus audités (appelant, environnement, statuts) avant tout verrou
  const keyring = x.keyring()
  return db.$transaction(async (tx) => {
    const c = await lockConnection(tx, input.companyId, input.connectionId)
    if (c.status === "DISABLED" || c.status === "ARCHIVED") fail("CONNECTION_FORBIDDEN")
    if (c.credentialStatus === "REVOKED") fail("CONNECTION_AUTH_REVOKED")
    const credentialsRef = c.credentialsRef ?? fail("SECRET_NOT_CONFIGURED")
    const v = await tx.integrationCredentialVersion.findFirst({ where: { companyId: c.companyId, connectionId: c.id, credentialsRef, status: "ACTIVE" }, select: versionSelect })
    if (!v || v.secretKind !== input.secretKind || v.environment !== x.environment) fail("SECRET_NOT_CONFIGURED")
    const { result, replacement } = await use(openSecret(sealedOf(v!), aadOf(v!), keyring))
    if (replacement) {
      const stored = await storeInTx(tx, c, { secretKind: input.secretKind, plaintext: replacement, actorId: input.runtimeCallerId }, x, keyring)
      await activateInTx(tx, c, { versionId: stored.versionId, actorId: input.runtimeCallerId }, x)
    }
    return result
  }, { timeout: opts.timeoutMs ?? 25_000, maxWait: 10_000 })
}

/**
 * Rotation de KEK (§6.2, étape 3) : réenveloppe avec la KEK active les DEK des versions ACTIVE et PENDING encore
 * enveloppées par une autre KEK, sans rechiffrer les secrets. Renvoie le nombre de versions réenveloppées.
 */
export async function rewrapCredentialDeks(db: Db, input: { companyId: string; actorId: string }, d: SecretProviderDeps = {}): Promise<number> {
  const x = deps(d)
  const keyring = x.keyring()
  const stale = await db.integrationCredentialVersion.findMany({ where: { companyId: input.companyId, status: { in: ["ACTIVE", "PENDING"] }, keyId: { not: keyring.activeKeyId } }, select: versionSelect })
  let count = 0
  for (const v of stale) {
    const next = rewrapDek(sealedOf(v), aadOf(v), keyring)
    await db.$transaction(async (tx) => {
      const r = await tx.integrationCredentialVersion.updateMany({ where: { id: v.id, companyId: v.companyId, keyId: v.keyId }, data: next })
      if (r.count === 1) {
        await audit(tx, { companyId: v.companyId, connectionId: v.connectionId, credentialsRef: v.credentialsRef, action: "DEK_REWRAPPED", outcome: "SUCCESS", secretVersion: v.secretVersion, environment: x.environment, actorId: input.actorId })
        count++
      }
    })
  }
  return count
}
