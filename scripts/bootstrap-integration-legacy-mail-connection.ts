/**
 * PLAN-INTEGRATION-PLATFORM-001 — LOT-1C
 * CLI : bootstrap IntegrationConnection mail legacy.
 *
 * Usage:
 *   npx tsx scripts/bootstrap-integration-legacy-mail-connection.ts --companyId=... [--no-return-existing]
 *
 * Par défaut : idempotent — une Connection éligible déjà présente est retournée
 * (`status: "existing"`), aligné sur bootstrapLegacyMailConnection (returnExisting défaut).
 * `--no-return-existing` : refuse si une Connection éligible existe déjà.
 */
import { pathToFileURL } from "node:url"
import { bootstrapLegacyMailConnection } from "@/lib/integration/ops/bootstrap-legacy-mail-connection"
import { prisma } from "@/lib/prisma"

function arg(name: string, argv: string[] = process.argv): string | undefined {
  const prefix = `--${name}=`
  const hit = argv.find((a) => a.startsWith(prefix))
  return hit ? hit.slice(prefix.length) : undefined
}

/**
 * Aligné sur bootstrapLegacyMailConnection : défaut returnExisting=true.
 * `--no-return-existing` → false.
 */
export function resolveBootstrapReturnExisting(
  argv: string[] = process.argv
): boolean {
  return !argv.includes("--no-return-existing")
}

async function main() {
  const companyId = arg("companyId")
  if (!companyId) {
    console.error("Usage: --companyId=<id> [--no-return-existing]")
    process.exit(1)
  }
  const returnExisting = resolveBootstrapReturnExisting()
  const result = await bootstrapLegacyMailConnection(
    { companyId, returnExisting },
    prisma
  )
  console.info(JSON.stringify({ status: result.status, ...( "connection" in result ? { connectionId: result.connection.id } : {}) }))
  if (result.status === "ambiguous") process.exit(2)
}

const isDirectRun =
  typeof process.argv[1] === "string" &&
  import.meta.url === pathToFileURL(process.argv[1]).href

if (isDirectRun) {
  main()
    .catch((e) => {
      console.error(e instanceof Error ? e.message : "bootstrap failed")
      process.exit(1)
    })
    .finally(async () => {
      await prisma.$disconnect()
    })
}