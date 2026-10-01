/**
 * Harness staging — RUN MANUEL de création de chantier CIBLÉE (un seul draft).
 * Aucune route HTTP, aucun scan, aucun cron. NE PAS exécuter sans autorisation explicite.
 *
 * Usage (staging uniquement) :
 *   TARGETED_STAGING_WORKSITE_CREATION_RUN_ENABLED=true \
 *   TARGETED_STAGING_EXPECTED_DATABASE_HOST=<hôte staging> \
 *   TARGETED_STAGING_EXPECTED_DATABASE_NAME=<base staging> \
 *   TARGETED_STAGING_FORBIDDEN_DATABASE_HOST=<hôte production>        (OBLIGATOIRE) \
 *   TARGETED_STAGING_FORBIDDEN_DATABASE_NAME=<base production>        (optionnel) \
 *   TARGETED_STAGING_ATTACHMENT_NOT_READY_COMPANY_ID=<companyId> \
 *   TARGETED_STAGING_ATTACHMENT_NOT_READY_DRAFT_ID=<draftId> \
 *   ACQUISITION_SYSTEM_ACTOR_USER_ID=<userId système> \
 *   DATABASE_URL=<url staging> \
 *   npx tsx scripts/run-targeted-staging-worksite-creation.ts --confirm=RUN_TARGETED_STAGING_WORKSITE_CREATION
 *
 * Mode CHECK (même environnement, aucune écriture) :
 *   ... --confirm=CHECK_TARGETED_STAGING_WORKSITE_CREATION
 *   exécute les étapes 1 et 2 ci-dessous puis s'arrête : ni wiring, ni lease, ni worker, ni conversion.
 * Le mode est porté UNIQUEMENT par la confirmation exacte ; toute autre valeur → refus (jamais RUN implicite).
 *
 * Ordre garanti (fail-closed, aucun fallback vers l'exécution) :
 *   1. gardes PURES (aucune I/O) : confirmation, gate, marqueurs production, identité URL
 *      (hôte + nom de base attendus, hôte production interdit obligatoire et distinct ; hôtes
 *      normalisés : trim, minuscules, un point final retiré ; formes ambiguës refusées), cible env ;
 *   2. phase READ-ONLY (transaction READ ONLY) : current_database() + empreinte de la cible ;
 *   3. seulement ensuite runTargetedWorksiteCreationUnderOrchestratorLease (1re écriture = lease).
 * Aucun secret n'est affiché (ni DATABASE_URL, ni hôte, ni nom de base).
 */
import { pathToFileURL } from "node:url"
import { runTargetedWorksiteCreationUnderOrchestratorLease } from "@/lib/acquisition/orchestrator/acquisition-orchestrator-workers"
import { prisma } from "@/lib/prisma"

export const TARGETED_WORKSITE_CREATION_CONFIRMATION = "RUN_TARGETED_STAGING_WORKSITE_CREATION" as const
export const TARGETED_WORKSITE_CREATION_CHECK_CONFIRMATION = "CHECK_TARGETED_STAGING_WORKSITE_CREATION" as const
export const TARGETED_WORKSITE_CREATION_RUN_GATE = "TARGETED_STAGING_WORKSITE_CREATION_RUN_ENABLED" as const
export const TARGETED_EXPECTED_DATABASE_HOST_ENV = "TARGETED_STAGING_EXPECTED_DATABASE_HOST" as const
export const TARGETED_EXPECTED_DATABASE_NAME_ENV = "TARGETED_STAGING_EXPECTED_DATABASE_NAME" as const
export const TARGETED_FORBIDDEN_DATABASE_HOST_ENV = "TARGETED_STAGING_FORBIDDEN_DATABASE_HOST" as const
export const TARGETED_FORBIDDEN_DATABASE_NAME_ENV = "TARGETED_STAGING_FORBIDDEN_DATABASE_NAME" as const
const COMPANY_ENV = "TARGETED_STAGING_ATTACHMENT_NOT_READY_COMPANY_ID"
const DRAFT_ENV = "TARGETED_STAGING_ATTACHMENT_NOT_READY_DRAFT_ID"

/**
 * Délai borné après une conversion réelle avant $disconnect : le géocodage post-commit
 * (fire-and-forget, abort Nominatim à 5 s) peut se terminer. Aucun process.exit().
 */
export const GEOCODE_SETTLE_MS = 10_000

export type ScriptTarget = { companyId: string; draftId: string }

export type ScriptGuardResult =
  | { ok: true; target: ScriptTarget; expectedDatabaseName: string }
  | { ok: false; code: string }

/** Défense SUPPLÉMENTAIRE uniquement (jamais preuve d'identité) : marqueur « prod » explicite. */
function hasProductionMarker(value: string): boolean {
  return /production/i.test(value) || /(^|[_\-.])prod($|[_\-.])/i.test(value)
}

/** Nom d'hôte DNS / IPv4 strict : labels [a-z0-9-], sans « - » en bordure, séparés par « . ». */
const HOSTNAME_RE = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/

/**
 * Normalisation minimale et déterministe d'un nom d'hôte : trim, minuscules, suppression d'UN
 * point final DNS. Le résultat doit ensuite être un nom d'hôte DNS/IPv4 strict ; toute autre
 * forme (vide, multi-hôtes « , », percent-encoding « % », IPv6 « [] », espaces internes,
 * « _ », points multiples…) → null (jamais « réparée » en forme acceptable).
 */
export function normalizeDatabaseHost(raw: string | undefined | null): string | null {
  if (typeof raw !== "string") return null
  const lowered = raw.trim().toLowerCase()
  const host = lowered.endsWith(".") ? lowered.slice(0, -1) : lowered
  return HOSTNAME_RE.test(host) ? host : null
}

export type DatabaseUrlIdentity = { ok: true; host: string; name: string } | { ok: false; code: string }

/**
 * Identité effective de DATABASE_URL, fail-closed : URL postgres parsable, autorité sans « @ »
 * multiple, aucun paramètre d'override d'hôte (host / hostaddr), un seul segment de chemin non
 * vide (nom de base), hôte unique normalisable.
 */
export function extractDatabaseUrlIdentity(rawUrl: string | undefined): DatabaseUrlIdentity {
  if (typeof rawUrl !== "string" || !rawUrl) return { ok: false, code: "DATABASE_URL_INVALID" }
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return { ok: false, code: "DATABASE_URL_INVALID" }
  }
  if (!/^postgres(ql)?:$/i.test(url.protocol)) return { ok: false, code: "DATABASE_URL_INVALID" }
  const authority = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)/i.exec(rawUrl)?.[1]
  if (authority === undefined) return { ok: false, code: "DATABASE_URL_INVALID" }
  if ((authority.match(/@/g) ?? []).length > 1) return { ok: false, code: "DATABASE_HOST_AMBIGUOUS" }
  for (const key of url.searchParams.keys()) {
    if (/^(host|hostaddr)$/i.test(key)) return { ok: false, code: "DATABASE_HOST_AMBIGUOUS" }
  }
  const host = normalizeDatabaseHost(url.hostname)
  if (!host) return { ok: false, code: "DATABASE_HOST_AMBIGUOUS" }
  const segments = url.pathname.replace(/^\//, "").split("/")
  if (segments.length !== 1 || !segments[0]) return { ok: false, code: "DATABASE_URL_INVALID" }
  let name: string
  try {
    name = decodeURIComponent(segments[0])
  } catch {
    return { ok: false, code: "DATABASE_URL_INVALID" }
  }
  if (!name) return { ok: false, code: "DATABASE_URL_INVALID" }
  return { ok: true, host, name }
}

/**
 * Constat pré-RUN (pur, sans I/O) : l'hôte staging attendu et l'hôte production interdit sont
 * présents, valides et DISTINCTS après normalisation. Identiques → FORBIDDEN_DATABASE_IDENTITY
 * (RUN bloqué : l'hôte seul ne suffit plus à distinguer staging de production).
 */
export function assertDistinctStagingAndProductionHosts(input: {
  expectedHost: string | undefined
  forbiddenHost: string | undefined
}):
  | { ok: true; expectedHost: string; forbiddenHost: string }
  | { ok: false; code: "DATABASE_IDENTITY_CONFIG_MISSING" | "DATABASE_IDENTITY_CONFIG_INVALID" | "FORBIDDEN_DATABASE_IDENTITY" } {
  if (!(input.expectedHost ?? "").trim() || !(input.forbiddenHost ?? "").trim()) {
    return { ok: false, code: "DATABASE_IDENTITY_CONFIG_MISSING" }
  }
  const expectedHost = normalizeDatabaseHost(input.expectedHost)
  const forbiddenHost = normalizeDatabaseHost(input.forbiddenHost)
  if (!expectedHost || !forbiddenHost) return { ok: false, code: "DATABASE_IDENTITY_CONFIG_INVALID" }
  if (expectedHost === forbiddenHost) return { ok: false, code: "FORBIDDEN_DATABASE_IDENTITY" }
  return { ok: true, expectedHost, forbiddenHost }
}

export type TargetedWorksiteCreationMode = "CHECK" | "RUN"

/**
 * Mode explicite, porté exclusivement par l'unique argument de confirmation exacte.
 * Absent / inconnu / argument supplémentaire / ambigu → null (refus ; jamais RUN implicite).
 */
export function resolveTargetedWorksiteCreationMode(argv: string[]): TargetedWorksiteCreationMode | null {
  const args = argv.slice(2)
  if (args.length !== 1) return null
  if (args[0] === `--confirm=${TARGETED_WORKSITE_CREATION_CHECK_CONFIRMATION}`) return "CHECK"
  if (args[0] === `--confirm=${TARGETED_WORKSITE_CREATION_CONFIRMATION}`) return "RUN"
  return null
}

/**
 * Gardes fail-closed, PURES (aucune I/O, aucune connexion). Ordre : confirmation exacte (CHECK ou
 * RUN), aucun autre argument, gate dédié, marqueurs production d'environnement, configuration
 * d'identité, URL, identité production interdite, identité attendue (hôte + base), cible env.
 * Identiques pour CHECK et RUN.
 */
export function evaluateTargetedWorksiteCreationScriptGuards(input: {
  argv: string[]
  env: Record<string, string | undefined>
}): ScriptGuardResult {
  if (resolveTargetedWorksiteCreationMode(input.argv) === null) {
    return { ok: false, code: "CONFIRMATION_REQUIRED" }
  }
  const env = input.env
  if (env[TARGETED_WORKSITE_CREATION_RUN_GATE] !== "true") return { ok: false, code: "RUN_DISABLED" }
  if (env.VERCEL_ENV === "production" || env.NODE_ENV === "production") {
    return { ok: false, code: "PRODUCTION_FORBIDDEN" }
  }

  // Identité : hôte staging attendu + nom de base attendu + hôte production interdit OBLIGATOIRES.
  const expectedName = (env[TARGETED_EXPECTED_DATABASE_NAME_ENV] ?? "").trim()
  if (!expectedName) return { ok: false, code: "DATABASE_IDENTITY_CONFIG_MISSING" }
  const hosts = assertDistinctStagingAndProductionHosts({
    expectedHost: env[TARGETED_EXPECTED_DATABASE_HOST_ENV],
    forbiddenHost: env[TARGETED_FORBIDDEN_DATABASE_HOST_ENV],
  })
  if (!hosts.ok) return { ok: false, code: hosts.code }
  const { expectedHost, forbiddenHost } = hosts
  const forbiddenName = (env[TARGETED_FORBIDDEN_DATABASE_NAME_ENV] ?? "").trim()

  const identity = extractDatabaseUrlIdentity(env.DATABASE_URL)
  if (!identity.ok) return { ok: false, code: identity.code }
  const { host, name } = identity

  // Hôte production (normalisé) : barrière obligatoire. Nom production : complément optionnel,
  // discriminant seulement s'il diffère du nom attendu (noms de base parfois identiques).
  if (host === forbiddenHost) return { ok: false, code: "FORBIDDEN_DATABASE_IDENTITY" }
  if (forbiddenName && forbiddenName !== expectedName && name === forbiddenName) {
    return { ok: false, code: "FORBIDDEN_DATABASE_IDENTITY" }
  }
  // Défense supplémentaire (jamais mécanisme principal).
  if (hasProductionMarker(host) || hasProductionMarker(name)) {
    return { ok: false, code: "FORBIDDEN_DATABASE_IDENTITY" }
  }

  if (host !== expectedHost || name !== expectedName) {
    return { ok: false, code: "DATABASE_IDENTITY_MISMATCH" }
  }

  const companyId = (env[COMPANY_ENV] ?? "").trim()
  const draftId = (env[DRAFT_ENV] ?? "").trim()
  if (!companyId || !draftId) return { ok: false, code: "TARGET_UNSET" }
  return { ok: true, target: { companyId, draftId }, expectedDatabaseName: expectedName }
}

/** Port READ-ONLY d'identité de base (lectures uniquement). */
export type DatabaseIdentityReadPort = {
  readIdentity(target: ScriptTarget): Promise<{
    currentDatabase: string | null
    fingerprint: {
      id: string
      companyId: string
      status: string
      version: number
      createdWorksiteId: string | null
    } | null
  }>
}

/**
 * Implémentation réelle : une transaction PostgreSQL READ ONLY (toute écriture y serait
 * rejetée par le moteur) contenant exactement deux lectures. Même client que le wiring
 * (singleton Prisma / DATABASE_URL).
 */
export const prismaDatabaseIdentityReadPort: DatabaseIdentityReadPort = {
  async readIdentity(target) {
    return prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SET TRANSACTION READ ONLY`
      const rows = await tx.$queryRaw<Array<{ name: string }>>`SELECT current_database() AS name`
      const fingerprint = await tx.worksiteImportDraft.findFirst({
        where: { id: target.draftId, companyId: target.companyId },
        select: { id: true, companyId: true, status: true, version: true, createdWorksiteId: true },
      })
      return { currentDatabase: rows[0]?.name ?? null, fingerprint }
    })
  },
}

export type IdentityCheckResult = { ok: true } | { ok: false; code: string }

/** Phase READ-ONLY : nom de base réel + empreinte exacte de la cible. Exception → refus. */
export async function verifyDatabaseIdentityReadOnly(input: {
  port: DatabaseIdentityReadPort
  target: ScriptTarget
  expectedDatabaseName: string
}): Promise<IdentityCheckResult> {
  let identity: Awaited<ReturnType<DatabaseIdentityReadPort["readIdentity"]>>
  try {
    identity = await input.port.readIdentity(input.target)
  } catch {
    return { ok: false, code: "DATABASE_IDENTITY_CHECK_FAILED" }
  }
  if (!identity || identity.currentDatabase !== input.expectedDatabaseName) {
    return { ok: false, code: "DATABASE_NAME_MISMATCH" }
  }
  const fp = identity.fingerprint
  if (!fp) return { ok: false, code: "TARGET_FINGERPRINT_ABSENT" }
  if (
    fp.id !== input.target.draftId ||
    fp.companyId !== input.target.companyId ||
    fp.status !== "APPROVED" ||
    fp.createdWorksiteId !== null
  ) {
    return { ok: false, code: "TARGET_FINGERPRINT_MISMATCH" }
  }
  return { ok: true }
}

type WiringResult = Awaited<ReturnType<typeof runTargetedWorksiteCreationUnderOrchestratorLease>>

/** Sortie publique : aucun identifiant de lease / runId, aucun secret. */
export function summarizeRun(
  run: WiringResult
): { outcome: string; release: string | null; worker: unknown; converted: boolean; exitCode: number } {
  const release = "release" in run ? run.release : null
  if (run.outcome !== "WORKER_FINISHED") {
    return { outcome: run.outcome, release, worker: null, converted: false, exitCode: 1 }
  }
  const converted = run.worker.stats.converted === 1
  const ok = release === "RELEASED" && run.worker.status === "SUCCESS" && converted
  return { outcome: run.outcome, release, worker: run.worker, converted, exitCode: ok ? 0 : 1 }
}

export type GuardedRunResult =
  | { ok: false; stage: "PURE_GUARDS" | "READ_ONLY_IDENTITY"; code: string }
  | { ok: true; mode: "CHECK"; code: "CHECK_PASSED" }
  | { ok: true; summary: ReturnType<typeof summarizeRun> }

/**
 * Orchestration : gardes pures → phase read-only → CHECK : arrêt immédiat (aucun wiring) ;
 * RUN : SEULEMENT ensuite le wiring (1re écriture). Tout mode non explicitement RUN n'atteint
 * jamais le wiring. `main()` injecte toujours le port Prisma réel et le wiring réel.
 */
export async function runGuardedTargetedWorksiteCreation(deps: {
  argv: string[]
  env: Record<string, string | undefined>
  identityPort: DatabaseIdentityReadPort
  runWorksiteCreation: (input: { target: ScriptTarget }) => Promise<WiringResult>
}): Promise<GuardedRunResult> {
  const guard = evaluateTargetedWorksiteCreationScriptGuards({ argv: deps.argv, env: deps.env })
  if (!guard.ok) return { ok: false, stage: "PURE_GUARDS", code: guard.code }

  const identity = await verifyDatabaseIdentityReadOnly({
    port: deps.identityPort,
    target: guard.target,
    expectedDatabaseName: guard.expectedDatabaseName,
  })
  if (!identity.ok) return { ok: false, stage: "READ_ONLY_IDENTITY", code: identity.code }

  const mode = resolveTargetedWorksiteCreationMode(deps.argv)
  if (mode === "CHECK") return { ok: true, mode: "CHECK", code: "CHECK_PASSED" }
  if (mode !== "RUN") return { ok: false, stage: "PURE_GUARDS", code: "CONFIRMATION_REQUIRED" }

  const run = await deps.runWorksiteCreation({ target: guard.target })
  return { ok: true, summary: summarizeRun(run) }
}

async function main(): Promise<void> {
  const result = await runGuardedTargetedWorksiteCreation({
    argv: process.argv,
    env: process.env,
    identityPort: prismaDatabaseIdentityReadPort,
    runWorksiteCreation: runTargetedWorksiteCreationUnderOrchestratorLease,
  })
  if (!result.ok) {
    console.error(JSON.stringify(result))
    process.exitCode = 1
    return
  }
  if ("mode" in result) {
    console.info(JSON.stringify(result))
    process.exitCode = 0
    return
  }
  console.info(JSON.stringify(result.summary))
  process.exitCode = result.summary.exitCode
  if (result.summary.converted) {
    await new Promise((resolve) => setTimeout(resolve, GEOCODE_SETTLE_MS))
  }
}

const isDirectRun =
  typeof process.argv[1] === "string" &&
  import.meta.url === pathToFileURL(process.argv[1]).href

if (isDirectRun) {
  main()
    .catch(() => {
      console.error(JSON.stringify({ ok: false, code: "RUN_FAILED" }))
      process.exitCode = 1
    })
    .finally(async () => {
      await prisma.$disconnect()
    })
}
