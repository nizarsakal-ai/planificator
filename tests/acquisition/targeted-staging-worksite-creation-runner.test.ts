/**
 * Runner manuel worksiteCreation ciblé — gardes d'identité de base AVANT toute écriture.
 * Ordre prouvé : gardes pures → phase read-only (identité + empreinte) → wiring (1re écriture).
 * Valeurs fictives uniquement ; le script n'est jamais exécuté.
 */
process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test"

import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import path from "node:path"
import { describe, it } from "node:test"
import { runTargetedWorksiteCreationUnderOrchestratorLease } from "@/lib/acquisition/orchestrator/acquisition-orchestrator-workers"
import { acquisitionOrchestratorLeaseRepository } from "@/lib/acquisition/orchestrator/acquisition-orchestrator-lease.repository"
import { importDraftConversionService } from "@/lib/acquisition/conversion/conversion.service"
import {
  TARGETED_WORKSITE_CREATION_CHECK_CONFIRMATION,
  TARGETED_WORKSITE_CREATION_CONFIRMATION,
  resolveTargetedWorksiteCreationMode,
  assertDistinctStagingAndProductionHosts,
  evaluateTargetedWorksiteCreationScriptGuards,
  extractDatabaseUrlIdentity,
  normalizeDatabaseHost,
  runGuardedTargetedWorksiteCreation,
  verifyDatabaseIdentityReadOnly,
  type DatabaseIdentityReadPort,
  type ScriptTarget,
} from "../../scripts/run-targeted-staging-worksite-creation"

const ROOT = path.resolve(__dirname, "../..")
const SCRIPT_PATH = "scripts/run-targeted-staging-worksite-creation.ts"

const COMPANY = "co-fict-target"
const DRAFT = "draft-fict-target"
const HOST = "db-staging.fictional.test"
const NAME = "fict_staging_db"
const ARGV = ["node", "script.ts", `--confirm=${TARGETED_WORKSITE_CREATION_CONFIRMATION}`]

function env(over: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    TARGETED_STAGING_WORKSITE_CREATION_RUN_ENABLED: "true",
    TARGETED_STAGING_EXPECTED_DATABASE_HOST: HOST,
    TARGETED_STAGING_EXPECTED_DATABASE_NAME: NAME,
    TARGETED_STAGING_FORBIDDEN_DATABASE_HOST: "db-live.fictional.test",
    DATABASE_URL: `postgresql://fict:fict@${HOST}:5432/${NAME}`,
    TARGETED_STAGING_ATTACHMENT_NOT_READY_COMPANY_ID: COMPANY,
    TARGETED_STAGING_ATTACHMENT_NOT_READY_DRAFT_ID: DRAFT,
    ...over,
  }
}

type Fingerprint = NonNullable<Awaited<ReturnType<DatabaseIdentityReadPort["readIdentity"]>>["fingerprint"]>

function fp(over: Partial<Fingerprint> = {}): Fingerprint {
  return { id: DRAFT, companyId: COMPANY, status: "APPROVED", version: 6, createdWorksiteId: null, ...over }
}

/** Spies : ordre des appels, cibles lues, appels du wiring (1re écriture réelle). */
function harness(identity: {
  currentDatabase?: string | null
  fingerprint?: Fingerprint | null
  throws?: boolean
} = {}) {
  const sequence: string[] = []
  const identityTargets: ScriptTarget[] = []
  const runTargets: ScriptTarget[] = []
  const identityPort: DatabaseIdentityReadPort = {
    async readIdentity(target) {
      sequence.push("identity")
      identityTargets.push(target)
      if (identity.throws) throw new Error("connection reset")
      return {
        currentDatabase: identity.currentDatabase === undefined ? NAME : identity.currentDatabase,
        fingerprint: identity.fingerprint === undefined ? fp() : identity.fingerprint,
      }
    },
  }
  const runWorksiteCreation = async (input: { target: ScriptTarget }) => {
    sequence.push("run")
    runTargets.push(input.target)
    return { outcome: "TARGET_NOT_AUTHORIZED" as const }
  }
  return { sequence, identityTargets, runTargets, identityPort, runWorksiteCreation }
}

async function run(e: Record<string, string | undefined>, h = harness(), argv = ARGV) {
  const result = await runGuardedTargetedWorksiteCreation({
    argv,
    env: e,
    identityPort: h.identityPort,
    runWorksiteCreation: h.runWorksiteCreation,
  })
  return { result, h }
}

describe("1. gardes PURES d'identité URL — 0 accès DB, 0 lease", () => {
  const cases: Array<[string, Record<string, string | undefined>, string]> = [
    ["hôte attendu absent", env({ TARGETED_STAGING_EXPECTED_DATABASE_HOST: undefined }), "DATABASE_IDENTITY_CONFIG_MISSING"],
    ["hôte attendu blanc", env({ TARGETED_STAGING_EXPECTED_DATABASE_HOST: "  " }), "DATABASE_IDENTITY_CONFIG_MISSING"],
    ["nom de base attendu absent", env({ TARGETED_STAGING_EXPECTED_DATABASE_NAME: undefined }), "DATABASE_IDENTITY_CONFIG_MISSING"],
    ["nom de base attendu vide", env({ TARGETED_STAGING_EXPECTED_DATABASE_NAME: "" }), "DATABASE_IDENTITY_CONFIG_MISSING"],
    ["DATABASE_URL absente", env({ DATABASE_URL: undefined }), "DATABASE_URL_INVALID"],
    ["DATABASE_URL non-URL", env({ DATABASE_URL: "not a url" }), "DATABASE_URL_INVALID"],
    ["schéma non postgres", env({ DATABASE_URL: `mysql://u:p@${HOST}/${NAME}` }), "DATABASE_URL_INVALID"],
    ["nom de base absent de l'URL", env({ DATABASE_URL: `postgresql://u:p@${HOST}:5432/` }), "DATABASE_URL_INVALID"],
    ["mauvais hôte", env({ DATABASE_URL: `postgresql://u:p@db-other.fictional.test:5432/${NAME}` }), "DATABASE_IDENTITY_MISMATCH"],
    ["hôte différent par la casse/sous-domaine", env({ DATABASE_URL: `postgresql://u:p@x.${HOST}:5432/${NAME}` }), "DATABASE_IDENTITY_MISMATCH"],
    ["mauvais nom de base", env({ DATABASE_URL: `postgresql://u:p@${HOST}:5432/other_db` }), "DATABASE_IDENTITY_MISMATCH"],
    ["nom de base préfixe", env({ DATABASE_URL: `postgresql://u:p@${HOST}:5432/${NAME}_copy` }), "DATABASE_IDENTITY_MISMATCH"],
    [
      "hôte = hôte production interdit",
      env({ DATABASE_URL: "postgresql://u:p@db-live.fictional.test:5432/" + NAME, TARGETED_STAGING_EXPECTED_DATABASE_HOST: "db-live.fictional.test" }),
      "FORBIDDEN_DATABASE_IDENTITY",
    ],
    [
      "identité attendue configurée = identité interdite",
      env({ TARGETED_STAGING_FORBIDDEN_DATABASE_HOST: HOST }),
      "FORBIDDEN_DATABASE_IDENTITY",
    ],
    [
      "hôte production interdit absent (nom interdit seul ne suffit pas)",
      env({ TARGETED_STAGING_FORBIDDEN_DATABASE_HOST: undefined, TARGETED_STAGING_FORBIDDEN_DATABASE_NAME: NAME }),
      "DATABASE_IDENTITY_CONFIG_MISSING",
    ],
    [
      "défense supplémentaire : marqueur production dans l'hôte",
      env({ DATABASE_URL: "postgresql://u:p@db-production.fictional.test:5432/" + NAME, TARGETED_STAGING_EXPECTED_DATABASE_HOST: "db-production.fictional.test" }),
      "FORBIDDEN_DATABASE_IDENTITY",
    ],
    [
      "défense supplémentaire : marqueur prod dans le nom",
      env({ DATABASE_URL: `postgresql://u:p@${HOST}:5432/app_prod`, TARGETED_STAGING_EXPECTED_DATABASE_NAME: "app_prod" }),
      "FORBIDDEN_DATABASE_IDENTITY",
    ],
    ["cible env absente", env({ TARGETED_STAGING_ATTACHMENT_NOT_READY_DRAFT_ID: " " }), "TARGET_UNSET"],
    ["gate absent", env({ TARGETED_STAGING_WORKSITE_CREATION_RUN_ENABLED: undefined }), "RUN_DISABLED"],
    ["VERCEL_ENV production", env({ VERCEL_ENV: "production" }), "PRODUCTION_FORBIDDEN"],
  ]
  for (const [label, e, code] of cases) {
    it(`${label} → ${code}, aucune lecture DB, aucun wiring`, async () => {
      const { result, h } = await run(e)
      assert.deepEqual(result, { ok: false, stage: "PURE_GUARDS", code })
      assert.deepEqual(h.sequence, [])
    })
  }

  it("sans confirmation → CONFIRMATION_REQUIRED, aucune lecture DB", async () => {
    const { result, h } = await run(env(), harness(), ["node", "script.ts"])
    assert.deepEqual(result, { ok: false, stage: "PURE_GUARDS", code: "CONFIRMATION_REQUIRED" })
    assert.deepEqual(h.sequence, [])
  })

  it("nom interdit identique mais hôte interdit fourni et différent → l'hôte discrimine (passe aux lectures)", async () => {
    const { result, h } = await run(env({ TARGETED_STAGING_FORBIDDEN_DATABASE_NAME: NAME }))
    assert.equal(result.ok, true)
    assert.deepEqual(h.sequence, ["identity", "run"])
  })

  it("comparaisons strictes : aucune normalisation de casse", () => {
    const r = evaluateTargetedWorksiteCreationScriptGuards({
      argv: ARGV,
      env: env({ DATABASE_URL: `postgresql://u:p@${HOST}:5432/${NAME.toUpperCase()}` }),
    })
    assert.deepEqual(r, { ok: false, code: "DATABASE_IDENTITY_MISMATCH" })
  })
})

describe("2. phase READ-ONLY — refus avant tout lease / écriture", () => {
  const cases: Array<[string, Parameters<typeof harness>[0], string]> = [
    ["current_database() différent", { currentDatabase: "other_db" }, "DATABASE_NAME_MISMATCH"],
    ["current_database() null", { currentDatabase: null }, "DATABASE_NAME_MISMATCH"],
    ["cible absente", { fingerprint: null }, "TARGET_FINGERPRINT_ABSENT"],
    ["mauvaise company", { fingerprint: fp({ companyId: "co-other" }) }, "TARGET_FINGERPRINT_MISMATCH"],
    ["mauvais id", { fingerprint: fp({ id: "draft-other" }) }, "TARGET_FINGERPRINT_MISMATCH"],
    ["status PENDING_REVIEW", { fingerprint: fp({ status: "PENDING_REVIEW" }) }, "TARGET_FINGERPRINT_MISMATCH"],
    ["status CONVERTED", { fingerprint: fp({ status: "CONVERTED" }) }, "TARGET_FINGERPRINT_MISMATCH"],
    ["createdWorksiteId non null", { fingerprint: fp({ createdWorksiteId: "ws-1" }) }, "TARGET_FINGERPRINT_MISMATCH"],
    ["exception pendant la lecture", { throws: true }, "DATABASE_IDENTITY_CHECK_FAILED"],
  ]
  for (const [label, identity, code] of cases) {
    it(`${label} → ${code}, wiring jamais appelé (aucun lease, aucune écriture)`, async () => {
      const { result, h } = await run(env(), harness(identity))
      assert.deepEqual(result, { ok: false, stage: "READ_ONLY_IDENTITY", code })
      assert.deepEqual(h.sequence, ["identity"])
      assert.deepEqual(h.runTargets, [])
    })
  }

  it("la phase read-only lit exclusivement la cible env exacte", async () => {
    const { h } = await run(env())
    assert.deepEqual(h.identityTargets, [{ companyId: COMPANY, draftId: DRAFT }])
  })

  it("verifyDatabaseIdentityReadOnly : port qui retourne une forme invalide → refus", async () => {
    const bad: DatabaseIdentityReadPort = { readIdentity: async () => undefined as never }
    assert.deepEqual(
      await verifyDatabaseIdentityReadOnly({ port: bad, target: { companyId: COMPANY, draftId: DRAFT }, expectedDatabaseName: NAME }),
      { ok: false, code: "DATABASE_NAME_MISMATCH" }
    )
  })
})

describe("3. ordre : gardes pures → identité read-only → SEULEMENT ensuite le wiring", () => {
  it("empreinte valide → wiring appelé exactement une fois, après l'identité, avec la cible env", async () => {
    const { result, h } = await run(env())
    assert.equal(result.ok, true)
    assert.deepEqual(h.sequence, ["identity", "run"])
    assert.deepEqual(h.runTargets, [{ companyId: COMPANY, draftId: DRAFT }])
  })

  it("la version n'est pas une identité : v6 et v9 passent (concurrence protégée par le worker)", async () => {
    for (const version of [6, 9]) {
      const { h } = await run(env(), harness({ fingerprint: fp({ version }) }))
      assert.deepEqual(h.sequence, ["identity", "run"])
    }
  })

  it("source : main injecte le port Prisma réel et le wiring réel ; aucun fallback ; aucun process.exit", () => {
    const src = readFileSync(path.join(ROOT, SCRIPT_PATH), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "")
    const main = src.slice(src.indexOf("async function main()"), src.indexOf("const isDirectRun"))
    assert.match(main, /identityPort: prismaDatabaseIdentityReadPort/)
    assert.match(main, /runWorksiteCreation: runTargetedWorksiteCreationUnderOrchestratorLease/)
    assert.ok(!/process\.exit\(/.test(src))
    const guarded = src.slice(
      src.indexOf("export async function runGuardedTargetedWorksiteCreation"),
      src.indexOf("async function main()")
    )
    const iGuard = guarded.indexOf("evaluateTargetedWorksiteCreationScriptGuards(")
    const iIdentity = guarded.indexOf("verifyDatabaseIdentityReadOnly(")
    const iRun = guarded.indexOf("deps.runWorksiteCreation(")
    assert.ok(iGuard > 0 && iIdentity > iGuard && iRun > iIdentity)
    assert.match(guarded, /if \(!guard\.ok\) return/)
    assert.match(guarded, /if \(!identity\.ok\) return/)
  })

  it("source : port Prisma = transaction READ ONLY, 2 lectures, champs d'empreinte exacts", () => {
    const src = readFileSync(path.join(ROOT, SCRIPT_PATH), "utf8")
    const port = src.slice(
      src.indexOf("export const prismaDatabaseIdentityReadPort"),
      src.indexOf("export type IdentityCheckResult")
    )
    const iRo = port.indexOf("SET TRANSACTION READ ONLY")
    const iDb = port.indexOf("SELECT current_database()")
    const iFp = port.indexOf("worksiteImportDraft.findFirst(")
    assert.ok(iRo > 0 && iDb > iRo && iFp > iDb)
    assert.match(port, /where: \{ id: target\.draftId, companyId: target\.companyId \}/)
    assert.match(port, /select: \{ id: true, companyId: true, status: true, version: true, createdWorksiteId: true \}/)
    assert.ok(!/create\(|update|delete|upsert/.test(port.replace("SET TRANSACTION READ ONLY", "")))
  })
})

describe("4. hôte production interdit OBLIGATOIRE — 0 accès DB", () => {
  for (const [label, value] of [
    ["absent", undefined],
    ["vide", ""],
    ["whitespace", "   \t "],
  ] as const) {
    it(`hôte production interdit ${label} → DATABASE_IDENTITY_CONFIG_MISSING, 0 DB`, async () => {
      const { result, h } = await run(env({ TARGETED_STAGING_FORBIDDEN_DATABASE_HOST: value }))
      assert.deepEqual(result, { ok: false, stage: "PURE_GUARDS", code: "DATABASE_IDENTITY_CONFIG_MISSING" })
      assert.deepEqual(h.sequence, [])
    })
  }

  it("nom production interdit reste OPTIONNEL (absent → autorisable)", async () => {
    const { result, h } = await run(env({ TARGETED_STAGING_FORBIDDEN_DATABASE_NAME: undefined }))
    assert.equal(result.ok, true)
    assert.deepEqual(h.sequence, ["identity", "run"])
  })
})

describe("5. normalisation des hôtes (trim, minuscules, un point final) puis comparaison stricte", () => {
  it("normalizeDatabaseHost : casse, point final, trim ; formes ambiguës → null", () => {
    assert.equal(normalizeDatabaseHost("DB-Staging.Fictional.TEST"), HOST)
    assert.equal(normalizeDatabaseHost(`${HOST}.`), HOST)
    assert.equal(normalizeDatabaseHost(`  ${HOST.toUpperCase()}.  `), HOST)
    assert.equal(normalizeDatabaseHost("127.0.0.1"), "127.0.0.1")
    for (const bad of [
      "",
      "   ",
      ".",
      `${HOST}..`,
      `.${HOST}`,
      "db%2Estaging.fictional.test",
      "h1,h2",
      "[::1]",
      "db staging.fictional.test",
      "db_staging.fictional.test",
      "-db.fictional.test",
      "db-.fictional.test",
      "db..fictional.test",
      "db.fictional.test:5432",
      "user@db.fictional.test",
      undefined,
      null,
    ]) {
      assert.equal(normalizeDatabaseHost(bad as string | undefined), null, String(bad))
    }
  })

  it("staging == production (identiques) → FORBIDDEN_DATABASE_IDENTITY, 0 DB", async () => {
    const { result, h } = await run(env({ TARGETED_STAGING_FORBIDDEN_DATABASE_HOST: HOST }))
    assert.deepEqual(result, { ok: false, stage: "PURE_GUARDS", code: "FORBIDDEN_DATABASE_IDENTITY" })
    assert.deepEqual(h.sequence, [])
  })

  it("staging vs production : différence de casse seule → détectés identiques (interdit)", async () => {
    const { result, h } = await run(env({ TARGETED_STAGING_FORBIDDEN_DATABASE_HOST: HOST.toUpperCase() }))
    assert.deepEqual(result, { ok: false, stage: "PURE_GUARDS", code: "FORBIDDEN_DATABASE_IDENTITY" })
    assert.deepEqual(h.sequence, [])
  })

  it("staging vs production : point final seul → détectés identiques (interdit)", async () => {
    for (const over of [
      { TARGETED_STAGING_FORBIDDEN_DATABASE_HOST: `${HOST}.` },
      { TARGETED_STAGING_EXPECTED_DATABASE_HOST: `${HOST}.`, TARGETED_STAGING_FORBIDDEN_DATABASE_HOST: HOST },
    ]) {
      const { result, h } = await run(env(over))
      assert.deepEqual(result, { ok: false, stage: "PURE_GUARDS", code: "FORBIDDEN_DATABASE_IDENTITY" })
      assert.deepEqual(h.sequence, [])
    }
  })

  it("DATABASE_URL avec casse / point final différents → comparaison normalisée correcte (autorisable)", async () => {
    for (const urlHost of [HOST.toUpperCase(), `${HOST}.`, "Db-Staging.Fictional.Test."]) {
      const { result, h } = await run(env({ DATABASE_URL: `postgresql://fict:fict@${urlHost}:5432/${NAME}` }))
      assert.equal(result.ok, true, urlHost)
      assert.deepEqual(h.sequence, ["identity", "run"])
    }
  })

  it("hôte attendu avec casse / point final / espaces différents → correct (autorisable)", async () => {
    for (const expected of [HOST.toUpperCase(), `${HOST}.`, `  ${HOST}  `]) {
      const { result } = await run(env({ TARGETED_STAGING_EXPECTED_DATABASE_HOST: expected }))
      assert.equal(result.ok, true, expected)
    }
  })

  it("DATABASE_URL pointant la production (casse / point final quelconques) → toujours interdit, 0 DB", async () => {
    for (const urlHost of ["DB-LIVE.FICTIONAL.TEST", "db-live.fictional.test.", "Db-Live.Fictional.Test"]) {
      const { result, h } = await run(env({ DATABASE_URL: `postgresql://fict:fict@${urlHost}:5432/${NAME}` }))
      assert.deepEqual(result, { ok: false, stage: "PURE_GUARDS", code: "FORBIDDEN_DATABASE_IDENTITY" }, urlHost)
      assert.deepEqual(h.sequence, [])
    }
  })

  it("hôte production interdit avec casse / point final différents → toujours interdit", async () => {
    for (const forbidden of ["DB-LIVE.FICTIONAL.TEST", "db-live.fictional.test.", " Db-Live.Fictional.Test "]) {
      const { result, h } = await run(
        env({
          TARGETED_STAGING_FORBIDDEN_DATABASE_HOST: forbidden,
          DATABASE_URL: `postgresql://fict:fict@db-live.fictional.test:5432/${NAME}`,
        })
      )
      assert.deepEqual(result, { ok: false, stage: "PURE_GUARDS", code: "FORBIDDEN_DATABASE_IDENTITY" }, forbidden)
      assert.deepEqual(h.sequence, [])
    }
  })

  it("hôte staging réellement différent de la production → autorisable", async () => {
    const r = assertDistinctStagingAndProductionHosts({ expectedHost: HOST, forbiddenHost: "db-live.fictional.test" })
    assert.deepEqual(r, { ok: true, expectedHost: HOST, forbiddenHost: "db-live.fictional.test" })
    const { result } = await run(env())
    assert.equal(result.ok, true)
  })
})

describe("6. hôtes mal formés / ambigus → refus AVANT toute DB", () => {
  const cases: Array<[string, Record<string, string | undefined>, string]> = [
    ["percent-encoding dans l'hôte URL", { DATABASE_URL: `postgresql://u:p@db-staging%2Efictional.test:5432/${NAME}` }, "DATABASE_HOST_AMBIGUOUS"],
    ["multi-hôtes dans l'URL", { DATABASE_URL: `postgresql://u:p@${HOST},db-live.fictional.test/${NAME}` }, "DATABASE_HOST_AMBIGUOUS"],
    ["override ?host= dans l'URL", { DATABASE_URL: `postgresql://u:p@${HOST}:5432/${NAME}?host=db-live.fictional.test` }, "DATABASE_HOST_AMBIGUOUS"],
    ["override ?HOSTADDR= dans l'URL", { DATABASE_URL: `postgresql://u:p@${HOST}:5432/${NAME}?sslmode=require&HOSTADDR=10.0.0.1` }, "DATABASE_HOST_AMBIGUOUS"],
    ["« @ » multiple dans l'autorité", { DATABASE_URL: `postgresql://u:p@db-live.fictional.test@${HOST}:5432/${NAME}` }, "DATABASE_HOST_AMBIGUOUS"],
    ["IPv6 entre crochets", { DATABASE_URL: `postgresql://u:p@[::1]:5432/${NAME}` }, "DATABASE_HOST_AMBIGUOUS"],
    ["double point final", { DATABASE_URL: `postgresql://u:p@${HOST}..:5432/${NAME}` }, "DATABASE_HOST_AMBIGUOUS"],
    ["hôte vide", { DATABASE_URL: `postgresql:///${NAME}` }, "DATABASE_HOST_AMBIGUOUS"],
    ["chemin multi-segments", { DATABASE_URL: `postgresql://u:p@${HOST}:5432/${NAME}/extra` }, "DATABASE_URL_INVALID"],
    ["URL avec espace", { DATABASE_URL: `postgresql://u:p@ ${HOST}/${NAME}` }, "DATABASE_URL_INVALID"],
    ["hôte attendu mal formé (percent)", { TARGETED_STAGING_EXPECTED_DATABASE_HOST: "db-staging%2Efictional.test" }, "DATABASE_IDENTITY_CONFIG_INVALID"],
    ["hôte attendu multiple", { TARGETED_STAGING_EXPECTED_DATABASE_HOST: `${HOST},db-other.fictional.test` }, "DATABASE_IDENTITY_CONFIG_INVALID"],
    ["hôte interdit mal formé", { TARGETED_STAGING_FORBIDDEN_DATABASE_HOST: "db live.fictional.test" }, "DATABASE_IDENTITY_CONFIG_INVALID"],
    ["hôte interdit avec port", { TARGETED_STAGING_FORBIDDEN_DATABASE_HOST: "db-live.fictional.test:5432" }, "DATABASE_IDENTITY_CONFIG_INVALID"],
    ["NODE_ENV=production", { NODE_ENV: "production" }, "PRODUCTION_FORBIDDEN"],
  ]
  for (const [label, over, code] of cases) {
    it(`${label} → ${code}, 0 DB`, async () => {
      const { result, h } = await run(env(over))
      assert.deepEqual(result, { ok: false, stage: "PURE_GUARDS", code })
      assert.deepEqual(h.sequence, [])
    })
  }

  it("extractDatabaseUrlIdentity : identité normalisée, nom de base exact (sensible à la casse)", () => {
    assert.deepEqual(extractDatabaseUrlIdentity(`postgresql://u:p@DB-Staging.Fictional.Test.:5432/${NAME}?sslmode=require`), {
      ok: true,
      host: HOST,
      name: NAME,
    })
    assert.deepEqual(extractDatabaseUrlIdentity(`postgresql://u:p@${HOST}/Fict_Staging_DB`), {
      ok: true,
      host: HOST,
      name: "Fict_Staging_DB",
    })
  })
})

describe("7. constat pré-RUN : assertDistinctStagingAndProductionHosts (pur, sans I/O)", () => {
  it("identiques (exact / casse / point final / espaces) → FORBIDDEN_DATABASE_IDENTITY", () => {
    for (const forbidden of [HOST, HOST.toUpperCase(), `${HOST}.`, `  ${HOST}  `]) {
      assert.deepEqual(assertDistinctStagingAndProductionHosts({ expectedHost: HOST, forbiddenHost: forbidden }), {
        ok: false,
        code: "FORBIDDEN_DATABASE_IDENTITY",
      })
    }
  })

  it("absents / blancs → CONFIG_MISSING ; mal formés → CONFIG_INVALID", () => {
    for (const [e, f] of [[undefined, HOST], [HOST, undefined], ["  ", HOST], [HOST, "\t"]] as const) {
      assert.deepEqual(assertDistinctStagingAndProductionHosts({ expectedHost: e, forbiddenHost: f }), {
        ok: false,
        code: "DATABASE_IDENTITY_CONFIG_MISSING",
      })
    }
    for (const [e, f] of [["a,b", HOST], [HOST, "x%2Ey"], ["[::1]", HOST]] as const) {
      assert.deepEqual(assertDistinctStagingAndProductionHosts({ expectedHost: e, forbiddenHost: f }), {
        ok: false,
        code: "DATABASE_IDENTITY_CONFIG_INVALID",
      })
    }
  })

  it("staging configuré = production, même si DATABASE_URL vise un autre hôte → FORBIDDEN, 0 DB", async () => {
    const { result, h } = await run(
      env({
        TARGETED_STAGING_EXPECTED_DATABASE_HOST: "db-live.fictional.test",
        TARGETED_STAGING_FORBIDDEN_DATABASE_HOST: "DB-LIVE.fictional.test.",
        DATABASE_URL: `postgresql://fict:fict@db-other.fictional.test:5432/${NAME}`,
      })
    )
    assert.deepEqual(result, { ok: false, stage: "PURE_GUARDS", code: "FORBIDDEN_DATABASE_IDENTITY" })
    assert.deepEqual(h.sequence, [])
  })
})

// ---------------------------------------------------------------------------
// 8. Mode CHECK — gardes pures → identité READ ONLY → arrêt ; jamais wiring / lease / worker.
// ---------------------------------------------------------------------------

const CHECK_ARGV = ["node", "script.ts", `--confirm=${TARGETED_WORKSITE_CREATION_CHECK_CONFIRMATION}`]

/**
 * Espions sur le wiring RÉEL : opérations lease (acquire / assertOwned / renew / release) et
 * conversion. La cible env serveur est configurée : un appel accidentel du wiring passerait
 * l'autorisation de cible et atteindrait acquire (prouvé par le témoin RUN).
 */
function installRealWiringSpies() {
  const ops: string[] = []
  const repo = acquisitionOrchestratorLeaseRepository as unknown as Record<string, unknown>
  const saved = new Map<string, unknown>()
  for (const op of ["acquire", "assertOwned", "renew", "release"]) {
    saved.set(op, repo[op])
    repo[op] = async () => {
      ops.push(op)
      // acquire non obtenu → le wiring s'arrête sans worker ni DB métier.
      return op === "acquire" ? { outcome: "HELD_BY_OTHER" } : { outcome: "NOT_OWNER" }
    }
  }
  const conv = importDraftConversionService as unknown as Record<string, unknown>
  const savedConvert = conv.convertImportDraft
  conv.convertImportDraft = async () => {
    ops.push("convertImportDraft")
    throw new Error("CONVERSION MUST NOT BE CALLED")
  }
  const savedEnv = {
    company: process.env.TARGETED_STAGING_ATTACHMENT_NOT_READY_COMPANY_ID,
    draft: process.env.TARGETED_STAGING_ATTACHMENT_NOT_READY_DRAFT_ID,
  }
  process.env.TARGETED_STAGING_ATTACHMENT_NOT_READY_COMPANY_ID = COMPANY
  process.env.TARGETED_STAGING_ATTACHMENT_NOT_READY_DRAFT_ID = DRAFT
  const wiringCalls: ScriptTarget[] = []
  const realWiring = async (input: { target: ScriptTarget }) => {
    wiringCalls.push(input.target)
    return runTargetedWorksiteCreationUnderOrchestratorLease(input)
  }
  const restore = () => {
    for (const [op, fn] of saved) repo[op] = fn
    conv.convertImportDraft = savedConvert
    if (savedEnv.company === undefined) delete process.env.TARGETED_STAGING_ATTACHMENT_NOT_READY_COMPANY_ID
    else process.env.TARGETED_STAGING_ATTACHMENT_NOT_READY_COMPANY_ID = savedEnv.company
    if (savedEnv.draft === undefined) delete process.env.TARGETED_STAGING_ATTACHMENT_NOT_READY_DRAFT_ID
    else process.env.TARGETED_STAGING_ATTACHMENT_NOT_READY_DRAFT_ID = savedEnv.draft
  }
  return { ops, wiringCalls, realWiring, restore }
}

async function runWith(
  argv: string[],
  e: Record<string, string | undefined>,
  identity: Parameters<typeof harness>[0] = {}
) {
  const h = harness(identity)
  const spies = installRealWiringSpies()
  try {
    const result = await runGuardedTargetedWorksiteCreation({
      argv,
      env: e,
      identityPort: h.identityPort,
      runWorksiteCreation: spies.realWiring,
    })
    return { result, h, ops: [...spies.ops], wiringCalls: [...spies.wiringCalls] }
  } finally {
    spies.restore()
  }
}

describe("8. mode CHECK — gardes → identité READ ONLY → arrêt immédiat", () => {
  it("C1 — CHECK valide → CHECK_PASSED ; identité lue une fois ; wiring / acquire / heartbeat / worker / conversion / release = 0", async () => {
    const { result, h, ops, wiringCalls } = await runWith(CHECK_ARGV, env())
    assert.deepEqual(result, { ok: true, mode: "CHECK", code: "CHECK_PASSED" })
    assert.deepEqual(h.sequence, ["identity"])
    assert.deepEqual(h.identityTargets, [{ companyId: COMPANY, draftId: DRAFT }])
    assert.deepEqual(wiringCalls, [])
    assert.deepEqual(ops, [], "aucune opération lease ni conversion")
  })

  it("C1 témoin — mêmes espions en RUN : le wiring réel atteint acquire (les espions détectent bien)", async () => {
    const { result, h, ops, wiringCalls } = await runWith(ARGV, env())
    assert.deepEqual(h.sequence, ["identity"])
    assert.deepEqual(wiringCalls, [{ companyId: COMPANY, draftId: DRAFT }])
    assert.deepEqual(ops, ["acquire"])
    assert.equal(result.ok, true)
    if (result.ok && "summary" in result) {
      assert.equal(result.summary.outcome, "ALREADY_RUNNING")
      assert.equal(result.summary.exitCode, 1)
    }
  })

  it("C2 — CHECK + empreinte absente → READ_ONLY_IDENTITY / TARGET_FINGERPRINT_ABSENT, aucun wiring ni lease", async () => {
    const { result, h, ops, wiringCalls } = await runWith(CHECK_ARGV, env(), { fingerprint: null })
    assert.deepEqual(result, { ok: false, stage: "READ_ONLY_IDENTITY", code: "TARGET_FINGERPRINT_ABSENT" })
    assert.deepEqual(h.sequence, ["identity"])
    assert.deepEqual(wiringCalls, [])
    assert.deepEqual(ops, [])
  })

  const mismatches: Array<[string, Parameters<typeof harness>[0], string]> = [
    ["mauvaise company", { fingerprint: fp({ companyId: "co-other" }) }, "TARGET_FINGERPRINT_MISMATCH"],
    ["status PENDING_REVIEW", { fingerprint: fp({ status: "PENDING_REVIEW" }) }, "TARGET_FINGERPRINT_MISMATCH"],
    ["createdWorksiteId non null", { fingerprint: fp({ createdWorksiteId: "ws-1" }) }, "TARGET_FINGERPRINT_MISMATCH"],
    ["current_database() différent", { currentDatabase: "other_db" }, "DATABASE_NAME_MISMATCH"],
    ["exception de lecture", { throws: true }, "DATABASE_IDENTITY_CHECK_FAILED"],
  ]
  for (const [label, identity, code] of mismatches) {
    it(`C3 — CHECK + ${label} → ${code}, aucun wiring ni lease`, async () => {
      const { result, ops, wiringCalls } = await runWith(CHECK_ARGV, env(), identity)
      assert.deepEqual(result, { ok: false, stage: "READ_ONLY_IDENTITY", code })
      assert.deepEqual(wiringCalls, [])
      assert.deepEqual(ops, [])
    })
  }

  const pureFailures: Array<[string, Record<string, string | undefined>, string]> = [
    ["NODE_ENV production", env({ NODE_ENV: "production" }), "PRODUCTION_FORBIDDEN"],
    ["VERCEL_ENV production", env({ VERCEL_ENV: "production" }), "PRODUCTION_FORBIDDEN"],
    ["gate absent", env({ TARGETED_STAGING_WORKSITE_CREATION_RUN_ENABLED: undefined }), "RUN_DISABLED"],
    ["hôte interdit absent", env({ TARGETED_STAGING_FORBIDDEN_DATABASE_HOST: undefined }), "DATABASE_IDENTITY_CONFIG_MISSING"],
    ["URL = hôte production", env({ DATABASE_URL: `postgresql://u:p@db-live.fictional.test:5432/${NAME}` }), "FORBIDDEN_DATABASE_IDENTITY"],
    ["hôte ambigu", env({ DATABASE_URL: `postgresql://u:p@${HOST}:5432/${NAME}?host=db-live.fictional.test` }), "DATABASE_HOST_AMBIGUOUS"],
    ["cible env absente", env({ TARGETED_STAGING_ATTACHMENT_NOT_READY_DRAFT_ID: undefined }), "TARGET_UNSET"],
  ]
  for (const [label, e, code] of pureFailures) {
    it(`C4 — CHECK + garde pure invalide (${label}) → ${code}, aucune requête DB, aucun wiring`, async () => {
      const { result, h, ops, wiringCalls } = await runWith(CHECK_ARGV, e)
      assert.deepEqual(result, { ok: false, stage: "PURE_GUARDS", code })
      assert.deepEqual(h.sequence, [])
      assert.deepEqual(wiringCalls, [])
      assert.deepEqual(ops, [])
    })
  }

  const badModes: Array<[string, string[]]> = [
    ["absent", ["node", "script.ts"]],
    ["vide", ["node", "script.ts", ""]],
    ["--confirm=CHECK", ["node", "script.ts", "--confirm=CHECK"]],
    ["--confirm=RUN", ["node", "script.ts", "--confirm=RUN"]],
    ["minuscules", ["node", "script.ts", `--confirm=${TARGETED_WORKSITE_CREATION_CHECK_CONFIRMATION.toLowerCase()}`]],
    ["espace final", ["node", "script.ts", `--confirm=${TARGETED_WORKSITE_CREATION_CHECK_CONFIRMATION} `]],
    ["--mode=RUN", ["node", "script.ts", "--mode=RUN"]],
    ["valeur nue", ["node", "script.ts", TARGETED_WORKSITE_CREATION_CONFIRMATION]],
    ["CHECK + RUN (ambigu)", ["node", "script.ts", `--confirm=${TARGETED_WORKSITE_CREATION_CHECK_CONFIRMATION}`, `--confirm=${TARGETED_WORKSITE_CREATION_CONFIRMATION}`]],
    ["RUN + CHECK (ambigu)", ["node", "script.ts", `--confirm=${TARGETED_WORKSITE_CREATION_CONFIRMATION}`, `--confirm=${TARGETED_WORKSITE_CREATION_CHECK_CONFIRMATION}`]],
    ["CHECK dupliqué", ["node", "script.ts", `--confirm=${TARGETED_WORKSITE_CREATION_CHECK_CONFIRMATION}`, `--confirm=${TARGETED_WORKSITE_CREATION_CHECK_CONFIRMATION}`]],
    ["CHECK + argument de cible", ["node", "script.ts", `--confirm=${TARGETED_WORKSITE_CREATION_CHECK_CONFIRMATION}`, `--draftId=${DRAFT}`]],
  ]
  for (const [label, argv] of badModes) {
    it(`C5 — mode ${label} → CONFIRMATION_REQUIRED, jamais RUN implicite, aucune DB, aucun wiring`, async () => {
      assert.equal(resolveTargetedWorksiteCreationMode(argv), null)
      const { result, h, ops, wiringCalls } = await runWith(argv, env())
      assert.deepEqual(result, { ok: false, stage: "PURE_GUARDS", code: "CONFIRMATION_REQUIRED" })
      assert.deepEqual(h.sequence, [])
      assert.deepEqual(wiringCalls, [])
      assert.deepEqual(ops, [])
    })
  }

  it("C5 — résolution du mode : uniquement les deux confirmations exactes", () => {
    assert.equal(resolveTargetedWorksiteCreationMode(CHECK_ARGV), "CHECK")
    assert.equal(resolveTargetedWorksiteCreationMode(ARGV), "RUN")
    assert.notEqual(TARGETED_WORKSITE_CREATION_CHECK_CONFIRMATION, TARGETED_WORKSITE_CREATION_CONFIRMATION)
  })

  it("C6 — RUN inchangé : gardes → identité → wiring (une fois, cible env) ; forme de résultat historique sans clé mode", async () => {
    const { result, h } = await run(env())
    assert.deepEqual(h.sequence, ["identity", "run"])
    assert.deepEqual(h.runTargets, [{ companyId: COMPANY, draftId: DRAFT }])
    assert.deepEqual(result, {
      ok: true,
      summary: { outcome: "TARGET_NOT_AUTHORIZED", release: null, worker: null, converted: false, exitCode: 1 },
    })
    assert.ok(!("mode" in result))
  })

  it("C6 — RUN : gardes pures identiques à CHECK (même refus, même code)", () => {
    for (const e of [env({ NODE_ENV: "production" }), env({ TARGETED_STAGING_FORBIDDEN_DATABASE_HOST: undefined }), env()]) {
      assert.deepEqual(
        evaluateTargetedWorksiteCreationScriptGuards({ argv: CHECK_ARGV, env: e }),
        evaluateTargetedWorksiteCreationScriptGuards({ argv: ARGV, env: e })
      )
    }
  })

  it("source : branche CHECK retourne AVANT l'appel du wiring ; RUN exige mode === \"RUN\" explicite", () => {
    const src = readFileSync(path.join(ROOT, SCRIPT_PATH), "utf8")
    const guarded = src.slice(
      src.indexOf("export async function runGuardedTargetedWorksiteCreation"),
      src.indexOf("async function main()")
    )
    const iIdentity = guarded.indexOf("if (!identity.ok) return")
    const iCheck = guarded.indexOf('if (mode === "CHECK") return')
    const iNotRun = guarded.indexOf('if (mode !== "RUN") return')
    const iWiring = guarded.indexOf("deps.runWorksiteCreation(")
    assert.ok(iIdentity > 0 && iCheck > iIdentity && iNotRun > iCheck && iWiring > iNotRun)
    const main = src.slice(src.indexOf("async function main()"), src.indexOf("const isDirectRun"))
    assert.match(main, /if \("mode" in result\) \{[\s\S]*?process\.exitCode = 0\s*return\s*\}/)
  })
})
