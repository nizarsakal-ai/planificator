/**
 * Tests unitaires — garde URL PostgreSQL jetable (sans DB).
 */
import { describe, it } from "node:test"
import assert from "node:assert/strict"
import {
  assertSafeDisposableTestDatabaseUrl,
  looksLikeProductionName,
} from "./safe-test-database-url"

function assertAccepted(url: string) {
  assert.doesNotThrow(() => assertSafeDisposableTestDatabaseUrl(url), url)
}

function assertRejected(url: string) {
  assert.throws(
    () => assertSafeDisposableTestDatabaseUrl(url),
    (err: unknown) => err instanceof Error && err.message.length > 0
  )
}

describe("assertSafeDisposableTestDatabaseUrl", () => {
  it("accepte localhost + db de test", () => {
    assertAccepted("postgresql://test:test@localhost:5432/planificator_lot1b1_test")
  })

  it("accepte 127.0.0.1 + db testing", () => {
    assertAccepted("postgresql://u:p@127.0.0.1:5433/app_testing")
  })

  it("accepte postgres + db lot1b test", () => {
    assertAccepted("postgresql://test:test@postgres:5432/planificator_lot1b1_test")
  })

  it("refuse postgres + db planificator (sans marqueur test)", () => {
    assertRejected("postgresql://test:test@postgres:5432/planificator")
  })

  it("refuse hôte distant + db sans marqueur test", () => {
    assertRejected("postgresql://u:p@db.example.com:5432/planificator")
  })

  it("accepte hôte distant + db explicitement test", () => {
    assertAccepted("postgresql://u:p@db.example.com:5432/planificator_test")
  })

  it("refuse db système postgres", () => {
    assertRejected("postgresql://test:test@localhost:5432/postgres")
  })

  it("refuse template0 / template1", () => {
    assertRejected("postgresql://test:test@localhost:5432/template0")
    assertRejected("postgresql://test:test@localhost:5432/template1")
  })

  it("refuse URL invalide", () => {
    assertRejected("not-a-url")
    assertRejected("mysql://localhost/test")
  })

  it("refuse prod / production dans hôte ou db", () => {
    assertRejected("postgresql://u:p@prod.example.com:5432/my_test_db")
    assertRejected("postgresql://u:p@localhost:5432/production_test")
    assert.equal(looksLikeProductionName("db.example.com", "app_production"), true)
  })

  it("refuse ::1 sans marqueur test sur le dbname", () => {
    assertRejected("postgresql://u:p@[::1]:5432/planificator")
  })

  it("accepte ::1 avec marqueur disposable", () => {
    assertAccepted("postgresql://u:p@[::1]:5432/app_disposable")
  })
})
