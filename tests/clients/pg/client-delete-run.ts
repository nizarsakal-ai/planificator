/**
 * Suppression de clients — lanceur de base PostgreSQL jetable (même pratique que LOT-1W-1b, lanceur distinct).
 *
 *   node --import tsx tests/clients/pg/client-delete-run.ts <create|migrate|target [fichier]|test|seed|dev|drop>
 *
 * Une seule variable : `CLIENT_DELETE_DATABASE_URL` — AUCUN repli (`DATABASE_URL` et les autres variables de
 * test sont ignorées). L'URL est validée (garde dépôt `assertSafeDisposableTestDatabaseUrl`, nom de base exact
 * `DB_NAME`, hôte local/Docker), puis transmise EXPLICITEMENT en `DATABASE_URL` (seule variable lue par
 * `prisma/schema.prisma`) aux sous-processus : `prisma migrate deploy`, le test PG, le seed et `next dev`.
 * L'URL n'est jamais affichée.
 *
 * `create` marque la base qu'il crée (`COMMENT ON DATABASE`) ; `drop` ne supprime qu'une base portant ce
 * marqueur et refuse toute base préexistante de même nom. `create` refuse de réutiliser une base existante.
 * `target` écrit une preuve de cible sans secret.
 */

import { spawn } from "node:child_process"
import { mkdirSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { PrismaClient } from "@prisma/client"
import { assertSafeDisposableTestDatabaseUrl } from "../../integration/persistence/helpers/safe-test-database-url"

export const DB_NAME = "planificator_client_delete_disposable"
export const DB_MARKER_PREFIX = "planificator client-delete disposable; created="
const ENV_VAR = "CLIENT_DELETE_DATABASE_URL"
const RUNNER_FLAG = "CLIENT_DELETE_RUNNER"
const PG_TEST = "tests/clients/pg/client-delete.pg.test.ts"
const SEED = "tests/clients/pg/client-delete-seed.ts"

function fail(message: string, code = 2): never {
  console.error(`[client-delete-run] REFUS — ${message}`)
  process.exit(code)
}

function isLocalHost(host: string): boolean {
  return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "postgres" || host.endsWith(".local")
}

/** URL validée ; jamais journalisée. */
export function resolveDisposableUrl(): string {
  const url = process.env[ENV_VAR]?.trim()
  if (!url) fail(`${ENV_VAR} absente — aucun repli vers une autre variable`)
  try {
    assertSafeDisposableTestDatabaseUrl(url)
  } catch (err) {
    fail(err instanceof Error ? err.message : "URL refusée")
  }
  const parsed = new URL(url)
  const dbName = decodeURIComponent(parsed.pathname.replace(/^\//, ""))
  if (dbName !== DB_NAME) fail(`nom de base attendu « ${DB_NAME} » (reçu : un autre nom, non journalisé)`)
  if (!isLocalHost(parsed.hostname.toLowerCase())) fail("hôte non local : seule une base locale/Docker est admise")
  return url
}

function adminUrl(url: string): string {
  const parsed = new URL(url)
  parsed.pathname = "/postgres"
  return parsed.toString()
}

function client(url: string): PrismaClient {
  return new PrismaClient({ datasources: { db: { url } } })
}

async function readMarker(admin: PrismaClient): Promise<{ exists: boolean; marker: string | null }> {
  const rows = await admin.$queryRawUnsafe<{ description: string | null }[]>(
    `SELECT pg_catalog.shobj_description(d.oid, 'pg_database') AS description FROM pg_database d WHERE d.datname = $1`,
    DB_NAME
  )
  if (rows.length === 0) return { exists: false, marker: null }
  return { exists: true, marker: rows[0].description }
}

async function cmdCreate(url: string): Promise<void> {
  const admin = client(adminUrl(url))
  try {
    const state = await readMarker(admin)
    if (state.exists) {
      if (state.marker?.startsWith(DB_MARKER_PREFIX)) fail(`la base ${DB_NAME} existe déjà avec le marqueur : exécutez « drop » d'abord (aucune réutilisation implicite)`, 3)
      fail(`la base ${DB_NAME} existe déjà SANS le marqueur : refus de la réutiliser ou de la supprimer`, 3)
    }
    const createdAt = new Date().toISOString()
    await admin.$executeRawUnsafe(`CREATE DATABASE "${DB_NAME}"`)
    await admin.$executeRawUnsafe(`COMMENT ON DATABASE "${DB_NAME}" IS '${DB_MARKER_PREFIX}${createdAt}'`)
    console.log(`[client-delete-run] base ${DB_NAME} créée et marquée (${createdAt})`)
  } finally {
    await admin.$disconnect()
  }
}

async function requireMarked(url: string): Promise<string> {
  const admin = client(adminUrl(url))
  try {
    const state = await readMarker(admin)
    if (!state.exists) fail(`la base ${DB_NAME} n'existe pas : exécutez « create »`, 3)
    if (!state.marker?.startsWith(DB_MARKER_PREFIX)) fail(`la base ${DB_NAME} ne porte pas le marqueur : refus`, 3)
    return state.marker
  } finally {
    await admin.$disconnect()
  }
}

function run(cmd: string, args: string[], env: NodeJS.ProcessEnv): Promise<number> {
  return new Promise((resolveExit) => {
    const child = spawn(cmd, args, { stdio: "inherit", env })
    child.on("exit", (code) => resolveExit(code ?? 1))
    child.on("error", () => resolveExit(1))
  })
}

async function cmdMigrate(url: string): Promise<void> {
  await requireMarked(url)
  const code = await run("npx", ["prisma", "migrate", "deploy"], { ...process.env, DATABASE_URL: url })
  if (code !== 0) fail(`prisma migrate deploy : code ${code}`, code)
}

async function cmdTarget(url: string, outFile: string): Promise<void> {
  const marker = await requireMarked(url)
  const db = client(url)
  try {
    const [info] = await db.$queryRawUnsafe<{ current_database: string; version: string }[]>(`SELECT current_database(), version()`)
    const [m] = await db.$queryRawUnsafe<{ count: bigint }[]>(`SELECT count(*)::bigint AS count FROM "_prisma_migrations" WHERE finished_at IS NOT NULL`)
    const [c] = await db.$queryRawUnsafe<{ count: bigint }[]>(`SELECT count(*)::bigint AS count FROM "clients"`)
    const lines = [
      `# Preuve de cible — base jetable suppression clients (aucun secret)`,
      `current_database = ${info.current_database}`,
      `version = ${info.version}`,
      `marker = ${marker}`,
      `migrations_applied = ${m.count}`,
      `clients_rows = ${c.count}`,
      `checked_at = ${new Date().toISOString()}`,
      `node = ${process.version}`,
      ``,
    ]
    mkdirSync(dirname(resolve(outFile)), { recursive: true })
    writeFileSync(outFile, lines.join("\n"))
    console.log(lines.join("\n"))
  } finally {
    await db.$disconnect()
  }
}

async function cmdTest(url: string): Promise<void> {
  await requireMarked(url)
  const code = await run(
    "node",
    ["--import", "tsx", "--experimental-test-module-mocks", "--test", PG_TEST],
    { ...process.env, DATABASE_URL: url, [RUNNER_FLAG]: "1" }
  )
  process.exit(code)
}

async function cmdSeed(url: string): Promise<void> {
  await requireMarked(url)
  const code = await run("node", ["--import", "tsx", SEED], { ...process.env, DATABASE_URL: url, [RUNNER_FLAG]: "1" })
  process.exit(code)
}

async function cmdDev(url: string): Promise<void> {
  await requireMarked(url)
  const code = await run("npx", ["next", "dev", "--port", process.env.CLIENT_DELETE_DEV_PORT ?? "3000"], {
    ...process.env,
    DATABASE_URL: url,
    RESEND_API_KEY: process.env.RESEND_API_KEY ?? "re_sink_dummy",
    NEXTAUTH_URL: process.env.NEXTAUTH_URL ?? `http://localhost:${process.env.CLIENT_DELETE_DEV_PORT ?? "3000"}`,
    NEXTAUTH_SECRET: process.env.NEXTAUTH_SECRET ?? "client-delete-local-dev-secret-not-for-production",
    AUTH_SECRET: process.env.AUTH_SECRET ?? "client-delete-local-dev-secret-not-for-production",
  })
  process.exit(code)
}

async function cmdDrop(url: string): Promise<void> {
  const admin = client(adminUrl(url))
  try {
    const state = await readMarker(admin)
    if (!state.exists) {
      console.log(`[client-delete-run] base ${DB_NAME} absente : rien à supprimer`)
      return
    }
    if (!state.marker?.startsWith(DB_MARKER_PREFIX)) fail(`la base ${DB_NAME} ne porte pas le marqueur : suppression refusée`, 3)
    await admin.$executeRawUnsafe(`DROP DATABASE "${DB_NAME}" WITH (FORCE)`)
    console.log(`[client-delete-run] base ${DB_NAME} supprimée (marqueur vérifié)`)
  } finally {
    await admin.$disconnect()
  }
}

async function main(): Promise<void> {
  const [command, arg] = process.argv.slice(2)
  const url = resolveDisposableUrl()
  switch (command) {
    case "create": return cmdCreate(url)
    case "migrate": return cmdMigrate(url)
    case "target": return cmdTarget(url, arg ?? "tests/clients/pg/pg-target.txt")
    case "test": return cmdTest(url)
    case "seed": return cmdSeed(url)
    case "dev": return cmdDev(url)
    case "drop": return cmdDrop(url)
    default: fail("commande attendue : create | migrate | target [fichier] | test | seed | dev | drop")
  }
}

main().catch((err) => {
  console.error("[client-delete-run] ERREUR —", err instanceof Error ? err.message : String(err))
  process.exit(1)
})
