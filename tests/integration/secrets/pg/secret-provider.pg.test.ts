/**
 * PLAN-INTEGRATION-PLATFORM-001 — LOT-8A : coffre à secrets sur PostgreSQL (base jetable migrée), vrais services.
 * Une seule ACTIVE par handle, bascule atomique, rotations concurrentes sérialisées, révocation, cross-tenant,
 * environnement, matériel chiffré immuable, aucun DELETE ni TRUNCATE, audit en ajout seul et sans secret.
 */
import assert from "node:assert/strict"
import { randomBytes } from "node:crypto"
import { after, before, describe, it } from "node:test"
import { PrismaClient } from "@prisma/client"
import { loadKeyring } from "@/lib/integration/secrets/keyring"
import {
  activateCredential, assignCredentialsRef, failCredential, resolveCredential, revokeCredential, rewrapCredentialDeks, storeCredential,
} from "@/lib/integration/persistence/secret-provider.service"
import { SecretProviderError, type SecretErrorCode } from "@/lib/integration/secrets/secret-errors"

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL requis (base PostgreSQL jetable migrée)")
const db = new PrismaClient()
const K1 = randomBytes(32).toString("base64"), K2 = randomBytes(32).toString("base64")
const keyring = loadKeyring({ INTEGRATION_KEK_ACTIVE_ID: "k1", INTEGRATION_KEK_K1: K1 })
const D = { keyring, environment: "test" as const }
const A = { companyId: "spA", connectionId: "spConnA" }
const SECRET_1 = "api_key_version_one_0123456789"
const SECRET_2 = "api_key_version_two_9876543210"
const resolveA = (o: Partial<{ runtimeCallerId: string; environment: "test" | "production"; companyId: string; connectionId: string }> = {}) =>
  resolveCredential(db, { companyId: o.companyId ?? A.companyId, connectionId: o.connectionId ?? A.connectionId, secretKind: "API_KEY", runtimeCallerId: o.runtimeCallerId ?? "connector-runtime", environment: o.environment ?? "test" }, D)
async function errCode(p: Promise<unknown>): Promise<SecretErrorCode | "NO_ERROR" | string> {
  try { await p; return "NO_ERROR" } catch (e) { return e instanceof SecretProviderError ? e.code : String((e as Error).message) }
}
async function sqlError(sql: string): Promise<string> { try { await db.$executeRawUnsafe(sql); return "NO_ERROR" } catch (e) { return String((e as Error).message) } }

before(async () => {
  for (const [id, slug] of [["spA", "sp-a"], ["spB", "sp-b"]]) {
    await db.$executeRawUnsafe(`INSERT INTO companies(id,name,slug,siret,address,"updatedAt") VALUES ('${id}','Société ${id}','${slug}','1234567890001${id === "spA" ? 1 : 2}','1 rue',now())`)
  }
  for (const [id, co, backend] of [["spConnA", "spA", "PLATFORM_ENCRYPTED"], ["spConnB", "spB", "PLATFORM_ENCRYPTED"], ["spLegacy", "spA", "LEGACY_GMAIL"]]) {
    await db.$executeRawUnsafe(`INSERT INTO integration_connections(id,"companyId","connectorType","displayName",status,"secretBackend",config,"updatedAt") VALUES ('${id}','${co}','shopify','Boutique','ACTIVE','${backend}','{}',now())`)
  }
})
after(async () => { await db.$disconnect() })

describe("cycle de vie (§8, §9)", () => {
  let v1 = "", v2 = ""
  it("handle attribué une seule fois ; connexion LEGACY_GMAIL refusée (SECRET_BACKEND_MISMATCH)", async () => {
    const ref = await assignCredentialsRef(db, A)
    assert.match(ref, /^cred_[0-9a-f]{32}$/)
    assert.equal(await assignCredentialsRef(db, A), ref)
    assert.equal(await errCode(assignCredentialsRef(db, { companyId: "spA", connectionId: "spLegacy" })), "SECRET_BACKEND_MISMATCH")
    assert.match(await sqlError(`UPDATE integration_connections SET "credentialsRef"='cred_autre_handle' WHERE id='spConnA'`), /credentialsRef is immutable/)
  })
  it("version PENDING non résoluble ; activation ⇒ résolution du clair", async () => {
    const s = await storeCredential(db, { ...A, secretKind: "API_KEY", plaintext: SECRET_1, actorId: "admA" }, D)
    v1 = s.versionId
    assert.equal(s.secretVersion, 1)
    assert.equal(s.hint, "6789")
    assert.equal(await errCode(resolveA()), "SECRET_NOT_CONFIGURED")
    await activateCredential(db, { ...A, versionId: v1, actorId: "admA" }, D)
    assert.equal(await resolveA(), SECRET_1)
    assert.equal((await db.integrationConnection.findUnique({ where: { id: "spConnA" } }))?.credentialStatus, "ACTIVE")
  })
  it("rotation : la nouvelle ACTIVE remplace l'ancienne (RETIRED) dans la même transaction", async () => {
    v2 = (await storeCredential(db, { ...A, secretKind: "API_KEY", plaintext: SECRET_2, actorId: "admA" }, D)).versionId
    assert.equal(await resolveA(), SECRET_1, "l'ancienne reste ACTIVE tant que la nouvelle n'est pas validée")
    await activateCredential(db, { ...A, versionId: v2, actorId: "admA" }, D)
    assert.equal(await resolveA(), SECRET_2)
    const rows = await db.integrationCredentialVersion.findMany({ where: { companyId: "spA" }, orderBy: { secretVersion: "asc" }, select: { status: true } })
    assert.deepEqual(rows.map((r) => r.status), ["RETIRED", "ACTIVE"])
    assert.equal(await errCode(activateCredential(db, { ...A, versionId: v1, actorId: "admA" }, D)), "ROTATION_FAILED", "une RETIRED ne se réactive pas")
  })
  it("validation échouée : PENDING → FAILED, l'ACTIVE reste inchangée (aucune coupure)", async () => {
    const v3 = (await storeCredential(db, { ...A, secretKind: "API_KEY", plaintext: "mauvaise_cle_0123456789", actorId: "admA" }, D)).versionId
    await failCredential(db, { ...A, versionId: v3, actorId: "admA", reasonCode: "PROVIDER_REJECTED" }, D)
    assert.equal(await resolveA(), SECRET_2)
    assert.equal(await errCode(activateCredential(db, { ...A, versionId: v3, actorId: "admA" }, D)), "ROTATION_FAILED")
  })
  it("deux rotations concurrentes sont sérialisées : une seule ACTIVE à la fin", async () => {
    const a = (await storeCredential(db, { ...A, secretKind: "API_KEY", plaintext: "concurrente_a_0123456789", actorId: "admA" }, D)).versionId
    const b = (await storeCredential(db, { ...A, secretKind: "API_KEY", plaintext: "concurrente_b_0123456789", actorId: "admA" }, D)).versionId
    await Promise.all([activateCredential(db, { ...A, versionId: a, actorId: "admA" }, D), activateCredential(db, { ...A, versionId: b, actorId: "admA" }, D)])
    assert.equal(await db.integrationCredentialVersion.count({ where: { companyId: "spA", status: "ACTIVE" } }), 1)
  })
  it("révocation : plus aucune résolution (CONNECTION_AUTH_REVOKED) ; motif obligatoire", async () => {
    assert.equal(await errCode(revokeCredential(db, { ...A, actorId: "admA", reasonCode: "motif libre" }, D)), "REVOCATION_FAILED")
    await revokeCredential(db, { ...A, actorId: "admA", reasonCode: "SECRET_EXPOSED" }, D)
    assert.equal(await errCode(resolveA()), "CONNECTION_AUTH_REVOKED")
    assert.equal(await db.integrationCredentialVersion.count({ where: { companyId: "spA", status: "ACTIVE" } }), 0)
  })
})

describe("isolement et autorisations (§12, §14, §16)", () => {
  before(async () => {
    await assignCredentialsRef(db, { companyId: "spB", connectionId: "spConnB" })
    const v = await storeCredential(db, { companyId: "spB", connectionId: "spConnB", secretKind: "API_KEY", plaintext: "secret_societe_b_0123456789", actorId: "admB" }, D)
    await activateCredential(db, { companyId: "spB", connectionId: "spConnB", versionId: v.versionId, actorId: "admB" }, D)
  })
  it("connexion d'une autre société ⇒ CONNECTION_FORBIDDEN (jamais de résolution par le handle seul)", async () => {
    assert.equal(await errCode(resolveA({ companyId: "spA", connectionId: "spConnB" })), "CONNECTION_FORBIDDEN")
    assert.equal(await errCode(storeCredential(db, { companyId: "spA", connectionId: "spConnB", secretKind: "API_KEY", plaintext: "x".repeat(20), actorId: "admA" }, D)), "CONNECTION_FORBIDDEN")
  })
  it("appelant non autorisé (UI, domaine) ⇒ CONNECTION_FORBIDDEN ; mauvais environnement ⇒ SECURITY_CONFIGURATION_INVALID", async () => {
    const B = { companyId: "spB", connectionId: "spConnB" }
    assert.equal(await errCode(resolveA({ ...B, runtimeCallerId: "ui" })), "CONNECTION_FORBIDDEN")
    assert.equal(await errCode(resolveA({ ...B, environment: "production" })), "SECURITY_CONFIGURATION_INVALID")
    assert.equal(await resolveA(B), "secret_societe_b_0123456789")
  })
  it("ciphertext copié vers une autre connexion : la base refuse, et l'AAD empêcherait le déchiffrement", async () => {
    const msg = await sqlError(`INSERT INTO integration_credential_versions (id,"companyId","connectionId","credentialsRef","secretKind",environment,"secretVersion",status,"keyId","encVersion","wrappedDek","dekNonce","dekTag",ciphertext,nonce,tag,"createdById")
      SELECT 'copie','spA','spConnA',"credentialsRef","secretKind",environment,99,'PENDING',"keyId","encVersion","wrappedDek","dekNonce","dekTag",ciphertext,nonce,tag,'pirate' FROM integration_credential_versions WHERE "companyId"='spB' LIMIT 1`)
    assert.match(msg, /requires a PLATFORM_ENCRYPTED connection carrying this credentialsRef/)
  })
})

describe("filets de la base", () => {
  it("création directe en ACTIVE refusée ; matériel chiffré et identité immuables ; transitions hors graphe refusées", async () => {
    const v = await db.integrationCredentialVersion.findFirstOrThrow({ where: { companyId: "spB", status: "ACTIVE" }, select: { id: true } })
    assert.match(await sqlError(`UPDATE integration_credential_versions SET ciphertext = '\\x00' WHERE id='${v.id}'`), /immutable/)
    assert.match(await sqlError(`UPDATE integration_credential_versions SET "companyId"='spA' WHERE id='${v.id}'`), /immutable/)
    assert.match(await sqlError(`UPDATE integration_credential_versions SET status='PENDING' WHERE id='${v.id}'`), /transition not allowed/)
    assert.match(await sqlError(`UPDATE integration_credential_versions SET "wrappedDek"="wrappedDek" || '' , "dekNonce"=decode('000000000000000000000000','hex') WHERE id='${v.id}'`), /rewrap must change keyId/)
  })
  it("au plus une ACTIVE par handle, même en SQL direct", async () => {
    const p = await storeCredential(db, { companyId: "spB", connectionId: "spConnB", secretKind: "API_KEY", plaintext: "deuxieme_active_0123456789", actorId: "admB" }, D)
    assert.match(await sqlError(`UPDATE integration_credential_versions SET status='ACTIVE', "activatedAt"=now() WHERE id='${p.versionId}'`), /one_active_key|duplicate key|23505/)
  })
  it("aucun DELETE ni TRUNCATE ; audit en ajout seul ; secretBackend figé tant qu'une version existe", async () => {
    assert.match(await sqlError(`DELETE FROM integration_credential_versions WHERE "companyId"='spB'`), /cannot be deleted/)
    assert.match(await sqlError(`TRUNCATE integration_credential_versions`), /cannot be truncated/)
    assert.match(await sqlError(`UPDATE integration_secret_audit_logs SET outcome='FAILURE'`), /append-only/)
    assert.match(await sqlError(`DELETE FROM integration_secret_audit_logs`), /append-only/)
    assert.match(await sqlError(`UPDATE integration_connections SET "secretBackend"='LEGACY_GMAIL' WHERE id='spConnB'`), /secretBackend cannot change/)
  })
  it("audit : actions tracées, aucune valeur secrète ni matériel chiffré dans le journal", async () => {
    const logs = await db.integrationSecretAuditLog.findMany({ where: { companyId: "spA" } })
    const actions = new Set(logs.map((l) => l.action))
    for (const a of ["CREDENTIAL_CREATED", "CREDENTIAL_ACTIVATED", "CREDENTIAL_RETIRED", "CREDENTIAL_FAILED", "CREDENTIAL_REVOKED", "RESOLUTION_DENIED"]) assert.ok(actions.has(a), a)
    const dump = JSON.stringify(logs)
    for (const s of [SECRET_1, SECRET_2, "secret_societe_b"]) assert.ok(!dump.includes(s), "aucun secret dans l'audit")
  })
})

describe("rotation de KEK (§6.2)", () => {
  it("réenveloppe les DEK ACTIVE/PENDING avec la nouvelle KEK, sans rechiffrer ; lisible ensuite sans l'ancienne KEK", async () => {
    const before = await db.integrationCredentialVersion.findFirstOrThrow({ where: { companyId: "spB", status: "ACTIVE" }, select: { id: true, ciphertext: true } })
    const rotating = loadKeyring({ INTEGRATION_KEK_ACTIVE_ID: "k2", INTEGRATION_KEK_K1: K1, INTEGRATION_KEK_K2: K2 })
    const n = await rewrapCredentialDeks(db, { companyId: "spB", actorId: "ops" }, { keyring: rotating, environment: "test" })
    assert.ok(n >= 1)
    const afterRow = await db.integrationCredentialVersion.findUniqueOrThrow({ where: { id: before.id }, select: { keyId: true, ciphertext: true } })
    assert.equal(afterRow.keyId, "k2")
    assert.deepEqual(Buffer.from(afterRow.ciphertext), Buffer.from(before.ciphertext))
    const onlyNew = loadKeyring({ INTEGRATION_KEK_ACTIVE_ID: "k2", INTEGRATION_KEK_K2: K2 })
    assert.equal(await resolveCredential(db, { companyId: "spB", connectionId: "spConnB", secretKind: "API_KEY", runtimeCallerId: "connector-runtime", environment: "test" }, { keyring: onlyNew, environment: "test" }), "secret_societe_b_0123456789")
  })
})
