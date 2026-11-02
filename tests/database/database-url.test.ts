import assert from "node:assert/strict"
import { test } from "node:test"
import { SERVERLESS_POOL_DEFAULTS, serverlessDatasources, withServerlessPoolDefaults } from "@/lib/database-url"

const params = (url: string | undefined) => Object.fromEntries(new URL(url!).searchParams)

test("adds the serverless pool defaults to a bare PostgreSQL URL", () => {
  const url = withServerlessPoolDefaults("postgresql://user:pw@db.example.test:5432/app")
  assert.deepEqual(params(url), SERVERLESS_POOL_DEFAULTS)
  assert.equal(new URL(url!).password, "pw")
  assert.equal(new URL(url!).pathname, "/app")
})

test("keeps every value already set in DATABASE_URL", () => {
  const url = withServerlessPoolDefaults(
    "postgres://u:p@db.example.test/app?sslmode=require&connect_timeout=30&max_idle_connection_lifetime=2&pgbouncer=true",
  )
  assert.deepEqual(params(url), {
    sslmode: "require",
    connect_timeout: "30",
    max_idle_connection_lifetime: "2",
    pgbouncer: "true",
    pool_timeout: "20",
  })
})

test("preserves percent-encoded credentials", () => {
  const url = withServerlessPoolDefaults("postgresql://us%40er:p%2Fw%3A%23@db.example.test/app")
  const parsed = new URL(url!)
  assert.equal(decodeURIComponent(parsed.username), "us@er")
  assert.equal(decodeURIComponent(parsed.password), "p/w:#")
})

test("leaves missing, unparseable and non-PostgreSQL URLs untouched", () => {
  assert.equal(withServerlessPoolDefaults(undefined), undefined)
  assert.equal(withServerlessPoolDefaults(""), "")
  assert.equal(withServerlessPoolDefaults("not a url"), "not a url")
  assert.equal(withServerlessPoolDefaults("mysql://u:p@h/db"), "mysql://u:p@h/db")
})

test("serverlessDatasources omits the override when DATABASE_URL is absent", (t) => {
  // Sans argument, la fonction lit process.env.DATABASE_URL (défini en CI) : l'absence se teste en le retirant.
  const saved = process.env.DATABASE_URL
  delete process.env.DATABASE_URL
  t.after(() => {
    if (saved !== undefined) process.env.DATABASE_URL = saved
  })
  assert.deepEqual(serverlessDatasources(), {})
  assert.deepEqual(serverlessDatasources(undefined), {})
  const option = serverlessDatasources("postgresql://u:p@h/db")
  assert.deepEqual(params(option.datasources?.db?.url), SERVERLESS_POOL_DEFAULTS)
})
