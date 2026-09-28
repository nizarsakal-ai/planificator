/**
 * Preuve de concurrence PostgreSQL RÉELLE (REPEATABLE READ, verrous ligne, 40001)
 * pour le harness targeted-staging-validation-record.
 *
 * N'exécute rien sans PLANIFICATOR_RR_PROOF_DATABASE_URL (sinon : skip).
 * Garde fail-closed AVANT toute connexion :
 * - hôte local uniquement (localhost / 127.0.0.1 / ::1 / socket Unix)
 * - base jetable dont le nom commence par planificator_rr_proof_
 * Toutes les tables vivent dans un schéma de test dédié, supprimé en fin de test.
 * Connexions indépendantes (un PrismaClient par rôle, connection_limit=1).
 */

import assert from "node:assert/strict"
import { randomBytes } from "node:crypto"
import { readFileSync } from "node:fs"
import path from "node:path"
import { after, before, describe, it } from "node:test"
import { Prisma, PrismaClient } from "@prisma/client"

const RAW_URL = process.env.PLANIFICATOR_RR_PROOF_DATABASE_URL?.trim() ?? ""
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"])
const DB_NAME_RE = /^planificator_rr_proof_[a-z0-9_]{4,48}$/
const LEASE_KEY = "acquisition-orchestrator"
const WAIT_MS = 10_000

/** Garde fail-closed : lève si l'URL n'est pas une base jetable locale. N'ouvre aucune connexion. */
export function assertLocalDisposableDatabaseUrl(raw: string): URL {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error("RR_PROOF_URL_INVALID")
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new Error("RR_PROOF_URL_NOT_POSTGRES")
  }
  const socketHost = url.searchParams.get("host")
  const hostOk = url.hostname
    ? LOCAL_HOSTS.has(url.hostname)
    : socketHost != null && socketHost.startsWith("/")
  if (!hostOk) throw new Error("RR_PROOF_HOST_NOT_LOCAL")
  if (socketHost != null && !socketHost.startsWith("/")) throw new Error("RR_PROOF_HOST_NOT_LOCAL")
  const dbName = decodeURIComponent(url.pathname.replace(/^\//, ""))
  if (!DB_NAME_RE.test(dbName)) throw new Error("RR_PROOF_DATABASE_NOT_DISPOSABLE")
  return url
}

type Deferred<T = void> = { promise: Promise<T>; resolve: (v: T) => void }
function deferred<T = void>(): Deferred<T> {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => { resolve = r })
  return { promise, resolve }
}

function bounded<T>(p: Promise<T>, label: string, ms = WAIT_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  return Promise.race([
    p,
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`RR_PROOF_TIMEOUT ${label}`)), ms)
    }),
  ]).finally(() => clearTimeout(timer))
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms))
}

type Observed = { prismaCode: string | null; sqlstate: string | null; message: string | null }
function observe(err: unknown): Observed {
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    const meta = (err.meta ?? {}) as { code?: unknown; message?: unknown }
    return {
      prismaCode: err.code,
      sqlstate: typeof meta.code === "string" ? meta.code : null,
      message: typeof meta.message === "string" ? meta.message : err.message.split("\n").pop() ?? null,
    }
  }
  return { prismaCode: null, sqlstate: null, message: err instanceof Error ? err.message : String(err) }
}

function evidence(proof: string, data: Record<string, unknown>) {
  console.log(`[RR_PROOF] ${proof} ${JSON.stringify(data)}`)
}

const RR = { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 30_000, maxWait: 5_000 }
const RC = { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, timeout: 30_000, maxWait: 5_000 }

const enabled = RAW_URL.length > 0

describe("targeted validation record — real PostgreSQL concurrency proof", { skip: !enabled && "PLANIFICATOR_RR_PROOF_DATABASE_URL not set" }, () => {
  const schema = `rr_proof_${randomBytes(4).toString("hex")}`
  let H: PrismaClient
  let W: PrismaClient
  let M: PrismaClient
  let pidH = 0
  let pidW = 0

  function client(url: URL): PrismaClient {
    const u = new URL(url.toString())
    u.searchParams.set("schema", schema)
    u.searchParams.set("connection_limit", "1")
    return new PrismaClient({ datasources: { db: { url: u.toString() } } })
  }

  async function seedLease(owner: string | null, expiresInMs: number | null) {
    await M.$executeRawUnsafe(`DELETE FROM "acquisition_orchestrator_leases"`)
    await M.$executeRawUnsafe(`DELETE FROM "acquisition_decision_journals"`)
    await M.$executeRaw`
      INSERT INTO "acquisition_orchestrator_leases" ("key","ownerRunId","leaseExpiresAt","acquiredAt","updatedAt")
      VALUES (
        ${LEASE_KEY},
        ${owner},
        CASE WHEN ${expiresInMs}::bigint IS NULL THEN NULL
             ELSE clock_timestamp() + (${expiresInMs}::bigint * interval '1 millisecond') END,
        CASE WHEN ${owner}::text IS NULL THEN NULL ELSE clock_timestamp() END,
        clock_timestamp()
      )`
  }

  // Premier statement de H : INSERT idle identique au harness / à acquire (établit le snapshot RR).
  async function harnessLeaseInsert(tx: Prisma.TransactionClient) {
    await tx.$executeRaw`
        INSERT INTO "acquisition_orchestrator_leases" (
          "key",
          "ownerRunId",
          "leaseExpiresAt",
          "acquiredAt",
          "updatedAt"
        )
        VALUES (
          ${LEASE_KEY},
          NULL,
          NULL,
          NULL,
          clock_timestamp()
        )
        ON CONFLICT ("key") DO NOTHING
      `
  }

  // Verrou + disponibilité exactement comme le harness durci (ownerRunId IS NULL uniquement) ;
  // le prédicat « libre » de acquire n'est calculé qu'à titre de comparaison.
  async function harnessLeaseLock(tx: Prisma.TransactionClient) {
    return tx.$queryRaw<Array<{ key: string; available: boolean; acquireFree: boolean }>>`
    SELECT
      "key",
      ("ownerRunId" IS NULL) AS "available",
      ("ownerRunId" IS NULL OR ("leaseExpiresAt" IS NOT NULL AND "leaseExpiresAt" < clock_timestamp())) AS "acquireFree"
    FROM "acquisition_orchestrator_leases"
    WHERE "key" = ${LEASE_KEY}
    FOR UPDATE
  `
  }

  async function countMarkers(c: Prisma.TransactionClient | PrismaClient) {
    const rows = await c.$queryRaw<Array<{ n: bigint }>>`SELECT count(*)::bigint AS n FROM "acquisition_decision_journals"`
    return Number(rows[0]!.n)
  }

  async function insertMarker(c: Prisma.TransactionClient | PrismaClient, key: string) {
    await c.$executeRaw`
      INSERT INTO "acquisition_decision_journals" ("id","companyId","draftId","decisionCode","metadata","idempotencyKey")
      VALUES (${`row-${key}`}, 'co', 'draft', 'VALIDATION_FAIL_RETRYABLE', '{"attempt":2}'::jsonb, ${key})`
  }

  /** Attend (borné) que le backend H soit bloqué sur un verrou détenu par W. */
  async function waitUntilBlockedBy(waiterPid: number, blockerPid: number) {
    const deadline = Date.now() + WAIT_MS
    while (Date.now() < deadline) {
      const rows = await M.$queryRaw<Array<{ blocked: boolean; wait_event_type: string | null }>>`
        SELECT (${blockerPid}::int = ANY(pg_blocking_pids(${waiterPid}::int))) AS blocked, wait_event_type
        FROM pg_stat_activity WHERE pid = ${waiterPid}::int`
      if (rows[0]?.blocked) return rows[0]
      await sleep(25)
    }
    throw new Error("RR_PROOF_TIMEOUT waiter never blocked")
  }

  before(async () => {
    const url = assertLocalDisposableDatabaseUrl(RAW_URL)
    H = client(url)
    W = client(url)
    M = client(url)
    await M.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`)
    await M.$executeRawUnsafe(`
      CREATE TABLE "${schema}"."acquisition_orchestrator_leases" (
        "key" TEXT PRIMARY KEY,
        "ownerRunId" TEXT,
        "leaseExpiresAt" TIMESTAMP(3),
        "acquiredAt" TIMESTAMP(3),
        "updatedAt" TIMESTAMP(3) NOT NULL
      )`)
    await M.$executeRawUnsafe(`
      CREATE TABLE "${schema}"."acquisition_decision_journals" (
        "id" TEXT PRIMARY KEY,
        "companyId" TEXT NOT NULL,
        "draftId" TEXT NOT NULL,
        "decisionCode" TEXT NOT NULL,
        "metadata" JSONB,
        "idempotencyKey" TEXT UNIQUE,
        "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`)
    for (const c of [H, W, M]) {
      await c.$executeRawUnsafe(`SET lock_timeout = '10s'`)
      await c.$executeRawUnsafe(`SET statement_timeout = '15s'`)
    }
    pidH = Number((await H.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`)[0]!.pid)
    pidW = Number((await W.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`)[0]!.pid)
    const server = await M.$queryRaw<Array<{ v: string; db: string; addr: string | null }>>`
      SELECT current_setting('server_version') AS v, current_database() AS db, inet_server_addr()::text AS addr`
    evidence("SETUP", { schema, serverVersion: server[0]!.v, database: server[0]!.db, serverAddr: server[0]!.addr, pidH, pidW })
    assert.notEqual(pidH, pidW, "H and W must use independent connections")
  })

  after(async () => {
    if (M) {
      await M.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
      const left = await M.$queryRaw<Array<{ n: bigint }>>`
        SELECT count(*)::bigint AS n FROM information_schema.schemata WHERE schema_name = ${schema}`
      evidence("CLEANUP", { schemaDropped: Number(left[0]!.n) === 0 })
    }
    await Promise.all([H?.$disconnect(), W?.$disconnect(), M?.$disconnect()])
  })

  it("PROOF 1 — RR snapshot is taken by the lease INSERT; a later committed journal row stays invisible", async () => {
    await seedLease(null, null)
    const snapshotTaken = deferred()
    const wCommitted = deferred()
    let seenByH = -1
    const h = H.$transaction(async (tx) => {
      await harnessLeaseInsert(tx) // no-op sur ligne existante, établit le snapshot
      snapshotTaken.resolve()
      await bounded(wCommitted.promise, "P1 wait W")
      seenByH = await countMarkers(tx)
    }, RR)
    await bounded(snapshotTaken.promise, "P1 snapshot")
    await insertMarker(W, "p1") // auto-commit
    const seenByFresh = await countMarkers(M)
    wCommitted.resolve()
    await bounded(h, "P1 H")
    evidence("PROOF_1", { seenByH, seenByFreshConnection: seenByFresh })
    assert.equal(seenByFresh, 1)
    assert.equal(seenByH, 0, "OLD_SNAPSHOT_CONFIRMED expected")
  })

  it("PROOF 2 — lease renewed (UPDATE) after H's snapshot → H's SELECT … FOR UPDATE fails with 40001", async () => {
    await seedLease("run-W", 3_600_000)
    const snapshotTaken = deferred()
    const wCommitted = deferred()
    let observed: Observed | null = null
    let lockSucceeded = false
    const h = H.$transaction(async (tx) => {
      await harnessLeaseInsert(tx)
      snapshotTaken.resolve()
      await bounded(wCommitted.promise, "P2 wait W")
      try {
        await harnessLeaseLock(tx)
        lockSucceeded = true
      } catch (err) {
        observed = observe(err)
        throw err
      }
    }, RR).catch(() => undefined)
    await bounded(snapshotTaken.promise, "P2 snapshot")
    // Heartbeat renew (même forme que le repository).
    await W.$executeRaw`
      UPDATE "acquisition_orchestrator_leases"
      SET "leaseExpiresAt" = clock_timestamp() + (${3_600_000}::bigint * interval '1 millisecond'),
          "updatedAt" = clock_timestamp()
      WHERE "key" = ${LEASE_KEY} AND "ownerRunId" = 'run-W'
        AND "leaseExpiresAt" IS NOT NULL AND "leaseExpiresAt" >= clock_timestamp()`
    wCommitted.resolve()
    await bounded(h, "P2 H")
    evidence("PROOF_2", { lockSucceeded, observed })
    assert.equal(lockSucceeded, false, "expected a serialization failure, lock succeeded")
    const o = observed as Observed | null
    assert.ok(o, "no error observed")
    assert.ok(
      o.sqlstate === "40001" || o.prismaCode === "P2034",
      `expected SQLSTATE 40001, observed ${JSON.stringify(o)}`
    )
  })

  it("PROOF 3 — fence-style lock without lease UPDATE: H really waits, then marker invisible but lease LIVE", async () => {
    await seedLease("run-W", 3_600_000)
    const snapshotTaken = deferred()
    const wLocked = deferred()
    const hBlockedConfirmed = deferred()
    const wCommitted = deferred()
    const hIssuingLock = deferred()
    let hLockRows: Array<{ available: boolean; acquireFree: boolean }> = []
    let markersSeenByH = -1
    let hError: Observed | null = null

    const w = W.$transaction(async (tx) => {
      // Fence : SELECT … FOR UPDATE avec contrôle owner + expiration (aucun UPDATE de la lease).
      const owned = await tx.$queryRaw<Array<{ key: string }>>`
        SELECT "key" FROM "acquisition_orchestrator_leases"
        WHERE "key" = ${LEASE_KEY} AND "ownerRunId" = 'run-W'
          AND "leaseExpiresAt" IS NOT NULL AND "leaseExpiresAt" >= clock_timestamp()
        FOR UPDATE`
      assert.equal(owned.length, 1)
      wLocked.resolve()
      await bounded(hBlockedConfirmed.promise, "P3 wait H blocked")
      await insertMarker(tx, "p3")
    }, RC).then(() => wCommitted.resolve())

    const h = H.$transaction(async (tx) => {
      await harnessLeaseInsert(tx)
      snapshotTaken.resolve()
      await bounded(wLocked.promise, "P3 wait W lock")
      hIssuingLock.resolve()
      try {
        hLockRows = await harnessLeaseLock(tx)
      } catch (err) {
        hError = observe(err)
        throw err
      }
      markersSeenByH = await countMarkers(tx)
    }, RR).catch(() => undefined)

    await bounded(snapshotTaken.promise, "P3 snapshot")
    await bounded(hIssuingLock.promise, "P3 H issuing lock")
    const blocked = await waitUntilBlockedBy(pidH, pidW)
    hBlockedConfirmed.resolve()
    await bounded(w, "P3 W")
    await bounded(h, "P3 H")
    const markersCommitted = await countMarkers(M)
    evidence("PROOF_3", {
      hWasBlockedByW: blocked.blocked,
      waitEventType: blocked.wait_event_type,
      hError,
      markersCommitted,
      markersSeenByH,
      leaseAvailableForH: hLockRows[0]?.available ?? null,
    })
    assert.equal(blocked.blocked, true)
    assert.equal(hError, null, `H should acquire the lock without error, observed ${JSON.stringify(hError)}`)
    assert.equal(markersCommitted, 1)
    assert.equal(markersSeenByH, 0, "marker must be invisible to H's RR snapshot")
    assert.equal(hLockRows.length, 1)
    assert.equal(hLockRows[0]!.available, false, "MARKER_INVISIBLE_BUT_LEASE_LIVE expected: lease must be LIVE")
  })

  it("PROOF 4 — lease released (UPDATE) after H's snapshot → H's SELECT … FOR UPDATE fails with 40001", async () => {
    await seedLease("run-W", 3_600_000)
    const snapshotTaken = deferred()
    const wCommitted = deferred()
    let observed: Observed | null = null
    let lockSucceeded = false
    const h = H.$transaction(async (tx) => {
      await harnessLeaseInsert(tx)
      snapshotTaken.resolve()
      await bounded(wCommitted.promise, "P4 wait W")
      try {
        await harnessLeaseLock(tx)
        lockSucceeded = true
      } catch (err) {
        observed = observe(err)
        throw err
      }
    }, RR).catch(() => undefined)
    await bounded(snapshotTaken.promise, "P4 snapshot")
    // Release (même forme que le repository).
    await W.$executeRaw`
      UPDATE "acquisition_orchestrator_leases"
      SET "ownerRunId" = NULL, "leaseExpiresAt" = NULL, "updatedAt" = clock_timestamp()
      WHERE "key" = ${LEASE_KEY} AND "ownerRunId" = 'run-W'`
    wCommitted.resolve()
    await bounded(h, "P4 H")
    evidence("PROOF_4", { lockSucceeded, observed })
    assert.equal(lockSucceeded, false, "expected a serialization failure, lock succeeded")
    const o = observed as Observed | null
    assert.ok(o, "no error observed")
    assert.ok(
      o.sqlstate === "40001" || o.prismaCode === "P2034",
      `expected SQLSTATE 40001, observed ${JSON.stringify(o)}`
    )
  })

  it("PROOF 5 — fail-closed rule ownerRunId IS NULL: expired owned lease refused (incl. short-TTL window)", async () => {
    // 5a. Évaluation SQL des trois états.
    const states: Array<[string, string | null, number | null]> = [
      ["idle", null, null],
      ["owned-expired", "run-W", -60_000],
      ["owned-live", "run-W", 3_600_000],
    ]
    const table: Record<string, { acquireFree: boolean; harnessUsable: boolean }> = {}
    for (const [label, owner, ms] of states) {
      await seedLease(owner, ms)
      const rows = await M.$queryRaw<Array<{ acquireFree: boolean; harnessUsable: boolean }>>`
        SELECT
          ("ownerRunId" IS NULL OR ("leaseExpiresAt" IS NOT NULL AND "leaseExpiresAt" < clock_timestamp())) AS "acquireFree",
          ("ownerRunId" IS NULL) AS "harnessUsable"
        FROM "acquisition_orchestrator_leases" WHERE "key" = ${LEASE_KEY}`
      table[label] = rows[0]!
    }
    evidence("PROOF_5a", table)
    assert.deepEqual(table.idle, { acquireFree: true, harnessUsable: true })
    assert.deepEqual(table["owned-expired"], { acquireFree: true, harnessUsable: false })
    assert.deepEqual(table["owned-live"], { acquireFree: false, harnessUsable: false })

    // 5b. Fenêtre TTL courte (config pathologique) : W verrouille avant expiration, commit après ;
    //     H attend ; le marqueur reste invisible au snapshot de H — la règle du harness
    //     (ownerRunId IS NULL) refuse la lease possédée.
    await seedLease("run-W", 800)
    const snapshotTaken = deferred()
    const wLocked = deferred()
    const hBlockedConfirmed = deferred()
    const hIssuingLock = deferred()
    let hLockRows: Array<{ available: boolean; acquireFree: boolean }> = []
    let markersSeenByH = -1
    const w = W.$transaction(async (tx) => {
      const owned = await tx.$queryRaw<Array<{ key: string }>>`
        SELECT "key" FROM "acquisition_orchestrator_leases"
        WHERE "key" = ${LEASE_KEY} AND "ownerRunId" = 'run-W'
          AND "leaseExpiresAt" IS NOT NULL AND "leaseExpiresAt" >= clock_timestamp()
        FOR UPDATE`
      assert.equal(owned.length, 1, "fence must pass before expiry")
      wLocked.resolve()
      await bounded(hBlockedConfirmed.promise, "P5 wait H blocked")
      await sleep(1_200) // l'expiration passe pendant la transaction fencée
      await insertMarker(tx, "p5")
    }, RC)
    const h = H.$transaction(async (tx) => {
      await harnessLeaseInsert(tx)
      snapshotTaken.resolve()
      await bounded(wLocked.promise, "P5 wait W lock")
      hIssuingLock.resolve()
      hLockRows = await harnessLeaseLock(tx)
      markersSeenByH = await countMarkers(tx)
    }, RR)
    await bounded(snapshotTaken.promise, "P5 snapshot")
    await bounded(hIssuingLock.promise, "P5 H issuing lock")
    await waitUntilBlockedBy(pidH, pidW)
    hBlockedConfirmed.resolve()
    await bounded(w, "P5 W")
    await bounded(h, "P5 H")
    const markersCommitted = await countMarkers(M)
    evidence("PROOF_5b", {
      markersCommitted,
      markersSeenByH,
      harnessRuleAvailable: hLockRows[0]?.available ?? null,
      acquirePredicateFree: hLockRows[0]?.acquireFree ?? null,
    })
    assert.equal(markersCommitted, 1)
    assert.equal(markersSeenByH, 0)
    assert.equal(hLockRows[0]!.available, false, "harness rule (ownerRunId IS NULL) must refuse")

    // 5c. Lease possédée DÉJÀ expirée au moment du verrou : acquire la jugerait libre, le harness refuse.
    await seedLease("run-W", -60_000)
    const expiredRows = await H.$transaction(async (tx) => {
      await harnessLeaseInsert(tx)
      return harnessLeaseLock(tx)
    }, RR)
    evidence("PROOF_5c", {
      harnessRuleAvailable: expiredRows[0]?.available ?? null,
      acquirePredicateFree: expiredRows[0]?.acquireFree ?? null,
    })
    assert.equal(expiredRows[0]!.acquireFree, true)
    assert.equal(expiredRows[0]!.available, false, "expired owned lease must be refused by the harness")
  })
})

describe("targeted validation record — PG proof URL guard (no connection)", () => {
  it("proof lease-lock availability expression is the handler's exact rule", () => {
    const handler = readFileSync(
      path.join(process.cwd(), "src/lib/acquisition/orchestrator/targeted-staging-validation-record.handler.ts"),
      "utf8"
    )
    const lock = handler.match(/SELECT\s+"key",([\s\S]*?)AS "available"\s+FROM "acquisition_orchestrator_leases"/)?.[1]
    assert.equal(lock?.replace(/\s+/g, " ").trim(), '("ownerRunId" IS NULL)')
  })

  it("refuses non-local hosts and non-disposable database names before connecting", () => {
    for (const bad of [
      "postgresql://u:p@ep-cool-name.eu-central-1.aws.neon.tech/planificator_rr_proof_abcd",
      "postgresql://u:p@10.0.0.5:5432/planificator_rr_proof_abcd",
      "postgresql://u:p@db.example.com/planificator_rr_proof_abcd",
      "postgresql://u:p@127.0.0.1:57012/planificator",
      "postgresql://u:p@127.0.0.1:57012/postgres",
      "postgresql://u:p@localhost/neondb",
      "mysql://u:p@127.0.0.1/planificator_rr_proof_abcd",
      "postgresql://u:p@127.0.0.1/planificator_rr_proof_abcd?host=db.example.com",
      "not a url",
    ]) {
      assert.throws(() => assertLocalDisposableDatabaseUrl(bad), /RR_PROOF_/, bad)
    }
    for (const ok of [
      "postgresql://u:p@127.0.0.1:57012/planificator_rr_proof_abcd",
      "postgresql://u:p@localhost:57012/planificator_rr_proof_x1y2",
      "postgresql://u:p@[::1]:57012/planificator_rr_proof_abcd",
    ]) {
      assert.doesNotThrow(() => assertLocalDisposableDatabaseUrl(ok), ok)
    }
  })
})
