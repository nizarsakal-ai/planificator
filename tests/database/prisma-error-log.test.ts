import assert from "node:assert/strict"
import { test } from "node:test"
import { isBenignClosedConnectionLog, logPrismaEngineError } from "@/lib/prisma-error-log"

const CLOSED = "Error in PostgreSQL connection: Error { kind: Closed, cause: None }"

test("seul le message exact de connexion fermée est écarté", () => {
  assert.equal(isBenignClosedConnectionLog(CLOSED), true)
  assert.equal(isBenignClosedConnectionLog(`  ${CLOSED}\n`), true)
  for (const other of [
    "Error in PostgreSQL connection: Error { kind: Io, cause: Some(Os { code: 104 }) }",
    "Error in PostgreSQL connection: Error { kind: Closed, cause: Some(x) }",
    `${CLOSED} suite`,
    "Invalid `prisma.user.findMany()` invocation: Can't reach database server",
    "",
  ]) {
    assert.equal(isBenignClosedConnectionLog(other), false, other)
  }
})

test("logPrismaEngineError : bruit écarté, toute autre erreur écrite avec le préfixe prisma:error", () => {
  const lines: string[] = []
  logPrismaEngineError({ message: CLOSED }, (l) => lines.push(l))
  logPrismaEngineError({ message: "Unique constraint failed" }, (l) => lines.push(l))
  assert.deepEqual(lines, ["prisma:error Unique constraint failed"])
})
