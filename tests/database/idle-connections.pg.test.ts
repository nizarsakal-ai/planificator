/**
 * Reproduit une connexion du pool fermée côté serveur pendant l'inactivité (suspension Neon, instance Vercel gelée),
 * puis vérifie que les paramètres serverless la jettent à l'emprunt au lieu de faire échouer la requête (P1017).
 * Prérequis : DATABASE_IDLE_TEST_URL = base PostgreSQL locale jetable, rôle autorisé à pg_terminate_backend.
 */
import assert from "node:assert/strict"
import { test } from "node:test"
import { PrismaClient } from "@prisma/client"
import { withServerlessPoolDefaults } from "@/lib/database-url"

const base = process.env.DATABASE_IDLE_TEST_URL?.trim()
if (!base) throw new Error("DATABASE_IDLE_TEST_URL requis (base PostgreSQL locale jetable)")
if (!["localhost", "127.0.0.1", "[::1]"].includes(new URL(base).hostname)) throw new Error("DATABASE_IDLE_TEST_URL doit viser une base locale")

const POOL = 3
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function withParams(url: string, extra: Record<string, string>) {
  const parsed = new URL(url)
  for (const [key, value] of Object.entries(extra)) parsed.searchParams.set(key, value)
  return parsed.toString()
}

/** Ouvre POOL connexions, les fait fermer par le serveur, attend, puis renvoie le résultat de POOL + 1 requêtes. */
async function queriesAfterServerClose(url: string, idleMs: number) {
  const app = new PrismaClient({ datasources: { db: { url } }, log: [] })
  const admin = new PrismaClient({ datasources: { db: { url: withParams(base!, { application_name: "idle-admin", connection_limit: "1" }) } }, log: [] })
  try {
    await Promise.all(Array.from({ length: POOL }, () => app.$queryRawUnsafe("SELECT pg_sleep(0.2)::text AS s")))
    const [{ n }] = await admin.$queryRawUnsafe<{ n: number }[]>(
      "SELECT count(pg_terminate_backend(pid))::int AS n FROM pg_stat_activity WHERE application_name = 'idle-victim'",
    )
    assert.equal(n, POOL, "every pooled connection must be closed by the server")
    await sleep(idleMs)
    const outcomes: string[] = []
    for (let i = 0; i <= POOL; i++) {
      outcomes.push(await app.$queryRawUnsafe("SELECT 1").then(() => "ok", (error) => String(error.code ?? error.name)))
    }
    return outcomes
  } finally {
    await app.$disconnect()
    await admin.$disconnect()
  }
}

const victim = { application_name: "idle-victim", connection_limit: String(POOL) }

test("without the serverless defaults, each server-closed connection fails one query with P1017", async () => {
  const outcomes = await queriesAfterServerClose(withParams(base, victim), 2_000)
  assert.deepEqual(outcomes, [...Array(POOL).fill("P1017"), "ok"])
})

test("with the serverless defaults, idle server-closed connections are discarded before use", async () => {
  // 11 s : au-delà du délai d'inactivité de 10 s, en deçà du contrôle de santé du pool (15 s).
  const outcomes = await queriesAfterServerClose(withServerlessPoolDefaults(withParams(base, victim))!, 11_000)
  assert.deepEqual(outcomes, Array(POOL + 1).fill("ok"))
})
