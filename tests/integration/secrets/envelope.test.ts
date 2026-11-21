/**
 * PLAN-INTEGRATION-PLATFORM-001 — LOT-8A : coffre à secrets, règles pures (trousseau de KEK, chiffrement d'enveloppe).
 * Clés de test générées à la volée : aucune clé réelle, aucune base, aucun réseau.
 */
import assert from "node:assert/strict"
import { randomBytes } from "node:crypto"
import { readFileSync, readdirSync } from "node:fs"
import { describe, it } from "node:test"
import { loadKeyring, resolveSecretEnvironment } from "@/lib/integration/secrets/keyring"
import { openSecret, rewrapDek, sealSecret, secretAad, secretHint, type SecretAadFields } from "@/lib/integration/secrets/envelope"
import { SecretProviderError, type SecretErrorCode } from "@/lib/integration/secrets/secret-errors"

const k = () => randomBytes(32).toString("base64")
const K1 = k(), K2 = k()
const env1 = { INTEGRATION_KEK_ACTIVE_ID: "k1", INTEGRATION_KEK_K1: K1 }
const env2 = { INTEGRATION_KEK_ACTIVE_ID: "k2", INTEGRATION_KEK_K1: K1, INTEGRATION_KEK_K2: K2 }
const F: SecretAadFields = { companyId: "coA", connectionId: "conn1", credentialsRef: "cred_0123456789", secretKind: "API_KEY", environment: "production", secretVersion: 1 }
const SECRET = "valeur-de-test-fictive-0123456789abcd"
const code = (fn: () => unknown): SecretErrorCode | "NO_ERROR" | "OTHER" => {
  try { fn(); return "NO_ERROR" } catch (e) { return e instanceof SecretProviderError ? e.code : "OTHER" }
}

describe("trousseau de KEK (§6)", () => {
  it("lit la KEK active et toutes les KEK lisibles ; keyId en minuscules", () => {
    const r = loadKeyring(env2)
    assert.equal(r.activeKeyId, "k2")
    assert.deepEqual(r.keyIds, ["k1", "k2"])
    assert.equal(r.key("k1").length, 32)
  })
  it("fail-closed SECURITY_CONFIGURATION_INVALID : absente, mal formée, courte, dégénérée, active inconnue, doublon, égale à la clé Gmail", () => {
    const bad: Record<string, string | undefined>[] = [
      {},
      { INTEGRATION_KEK_ACTIVE_ID: "k1" },
      { INTEGRATION_KEK_ACTIVE_ID: "K1!", INTEGRATION_KEK_K1: K1 },
      { INTEGRATION_KEK_ACTIVE_ID: "k1", INTEGRATION_KEK_K1: randomBytes(16).toString("base64") },
      { INTEGRATION_KEK_ACTIVE_ID: "k1", INTEGRATION_KEK_K1: Buffer.alloc(32, 7).toString("base64") },
      { INTEGRATION_KEK_ACTIVE_ID: "k9", INTEGRATION_KEK_K1: K1 },
      { INTEGRATION_KEK_ACTIVE_ID: "k1", INTEGRATION_KEK_K1: K1, INTEGRATION_KEK_K2: K1 },
      { INTEGRATION_KEK_ACTIVE_ID: "k1", INTEGRATION_KEK_K1: K1, GMAIL_TOKEN_ENCRYPTION_KEY: K1 },
      { INTEGRATION_KEK_ACTIVE_ID: "k1", INTEGRATION_KEK_K1: "pas-du-base64" },
    ]
    for (const e of bad) assert.equal(code(() => loadKeyring(e)), "SECURITY_CONFIGURATION_INVALID", JSON.stringify(Object.keys(e)))
  })
  it("environnement : VERCEL_ENV, sinon test/development ; valeur inconnue refusée", () => {
    assert.equal(resolveSecretEnvironment({ VERCEL_ENV: "production" }), "production")
    assert.equal(resolveSecretEnvironment({ VERCEL_ENV: "preview" }), "preview")
    assert.equal(resolveSecretEnvironment({ NODE_ENV: "test" }), "test")
    assert.equal(resolveSecretEnvironment({}), "development")
    assert.equal(code(() => resolveSecretEnvironment({ VERCEL_ENV: "staging" })), "SECURITY_CONFIGURATION_INVALID")
  })
})

describe("chiffrement d'enveloppe (§5)", () => {
  it("aller-retour ; DEK, nonce et ciphertext différents à chaque scellement (aucun chiffrement déterministe)", () => {
    const r = loadKeyring(env1)
    const a = sealSecret(SECRET, F, r), b = sealSecret(SECRET, F, r)
    assert.equal(openSecret(a, F, r), SECRET)
    assert.notDeepEqual(a.ciphertext, b.ciphertext)
    assert.notDeepEqual(a.nonce, b.nonce)
    assert.notDeepEqual(a.wrappedDek, b.wrappedDek)
    assert.equal(a.wrappedDek.length, 32)
    assert.equal(a.nonce.length, 12); assert.equal(a.tag.length, 16); assert.equal(a.dekNonce.length, 12); assert.equal(a.dekTag.length, 16)
    assert.equal(a.keyId, "k1"); assert.equal(a.encVersion, 1)
    assert.ok(!a.ciphertext.toString("latin1").includes("valeur-de-test"), "le clair n'apparaît pas dans le ciphertext")
  })
  it("AAD figé : changer UN champ (société, connexion, handle, type, environnement, version) ⇒ SECRET_DECRYPTION_FAILED", () => {
    const r = loadKeyring(env1)
    const s = sealSecret(SECRET, F, r)
    const variants: SecretAadFields[] = [
      { ...F, companyId: "coB" }, { ...F, connectionId: "conn2" }, { ...F, credentialsRef: "cred_9999999999" },
      { ...F, secretKind: "OAUTH_REFRESH_TOKEN" }, { ...F, environment: "preview" }, { ...F, secretVersion: 2 },
    ]
    for (const v of variants) assert.equal(code(() => openSecret(s, v, r)), "SECRET_DECRYPTION_FAILED", JSON.stringify(v))
  })
  it("altération du ciphertext, du tag ou de la DEK enveloppée ⇒ SECRET_DECRYPTION_FAILED ; KEK inconnue ⇒ SECURITY_CONFIGURATION_INVALID", () => {
    const r = loadKeyring(env1)
    const s = sealSecret(SECRET, F, r)
    const flip = (b: Buffer) => { const c = Buffer.from(b); c[0] ^= 1; return c }
    assert.equal(code(() => openSecret({ ...s, ciphertext: flip(s.ciphertext) }, F, r)), "SECRET_DECRYPTION_FAILED")
    assert.equal(code(() => openSecret({ ...s, tag: flip(s.tag) }, F, r)), "SECRET_DECRYPTION_FAILED")
    assert.equal(code(() => openSecret({ ...s, wrappedDek: flip(s.wrappedDek) }, F, r)), "SECRET_DECRYPTION_FAILED")
    assert.equal(code(() => openSecret({ ...s, encVersion: 2 }, F, r)), "SECRET_VERSION_UNSUPPORTED")
    const other = loadKeyring({ INTEGRATION_KEK_ACTIVE_ID: "k3", INTEGRATION_KEK_K3: k() })
    assert.equal(code(() => openSecret(s, F, other)), "SECURITY_CONFIGURATION_INVALID")
    // Même keyId mais autre clé : la DEK enveloppée ne s'ouvre pas.
    const impostor = loadKeyring({ INTEGRATION_KEK_ACTIVE_ID: "k1", INTEGRATION_KEK_K1: k() })
    assert.equal(code(() => openSecret(s, F, impostor)), "SECRET_DECRYPTION_FAILED")
  })
  it("rotation de KEK (§6.2) : réenveloppement sans rechiffrer le secret ; ancienne et nouvelle KEK lisibles pendant la fenêtre", () => {
    const s = sealSecret(SECRET, F, loadKeyring(env1))
    const during = loadKeyring(env2)
    assert.equal(openSecret(s, F, during), SECRET, "ancienne KEK encore lisible")
    const w = rewrapDek(s, F, during)
    assert.equal(w.keyId, "k2")
    const rewrapped = { ...s, ...w }
    assert.deepEqual(rewrapped.ciphertext, s.ciphertext, "secret non rechiffré")
    assert.equal(openSecret(rewrapped, F, loadKeyring({ INTEGRATION_KEK_ACTIVE_ID: "k2", INTEGRATION_KEK_K2: K2 })), SECRET, "lisible sans l'ancienne KEK")
  })
  it("indice : 4 derniers caractères seulement pour un secret d'au moins 16 caractères ; secret vide refusé", () => {
    assert.equal(secretHint(SECRET), "abcd")
    assert.equal(secretHint("court"), null)
    assert.equal(code(() => sealSecret("", F, loadKeyring(env1))), "SECRET_NOT_CONFIGURED")
    assert.equal(code(() => secretAad({ ...F, secretVersion: 0 })), "SECRET_VERSION_UNSUPPORTED")
  })
})

describe("contrôles statiques", () => {
  const dir = "src/lib/integration/secrets"
  const files = [...readdirSync(dir).filter((f) => f.endsWith(".ts")).map((f) => `${dir}/${f}`), "src/lib/integration/persistence/secret-provider.service.ts"]
  it("aucun module réseau, aucun journal, aucune dépendance au chiffrement Gmail historique", () => {
    for (const f of files) {
      const c = readFileSync(f, "utf8")
      assert.doesNotMatch(c, /\bfetch\(|from "node:(?:http|https|net|tls)"|console\.(?:log|info|warn|error)/, f)
      assert.doesNotMatch(c, /@\/lib\/encryption|GMAIL_TOKEN_ENCRYPTION_KEY\s*\)/, f)
    }
  })
  it("seul node:crypto chiffre ; AES-256-GCM, nonce aléatoire ; aucune option de chiffrement déterministe", () => {
    const c = readFileSync(`${dir}/envelope.ts`, "utf8")
    assert.match(c, /from "node:crypto"/)
    assert.match(c, /"aes-256-gcm"/)
    assert.match(c, /randomBytes\(NONCE\)/)
    assert.doesNotMatch(c, /createCipher\(|aes-\d+-(?:ecb|cbc)/i)
  })
  it("le service ne renvoie jamais le matériel chiffré et ne résout que pour les appelants techniques (§12)", () => {
    const c = readFileSync("src/lib/integration/persistence/secret-provider.service.ts", "utf8")
    assert.match(c, /SECRET_RESOLVERS = \["connector-runtime", "rotation-service", "revocation-service"\] as const/)
    assert.match(c, /FOR UPDATE/)
    assert.doesNotMatch(c, /plaintext[^\n]*audit|audit[^\n]*plaintext/)
  })
})
