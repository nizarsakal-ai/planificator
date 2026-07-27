/**
 * Pré-vol pour `npm run test:integration:persistence:pg`.
 * Échoue clairement si aucune URL de test sûre n’est fournie.
 * Ne journalise jamais l’URL ni les secrets.
 */
import {
  assertSafeDisposableTestDatabaseUrl,
  resolveIntegrationTestDatabaseUrl,
} from "./safe-test-database-url"

const resolved = resolveIntegrationTestDatabaseUrl()
if (!resolved.ok) {
  console.error(
    "test:integration:persistence:pg exige TEST_INTEGRATION_DATABASE_URL (prioritaire) ou TEST_ACQUISITION_DATABASE_URL (fallback)."
  )
  process.exit(1)
}

try {
  assertSafeDisposableTestDatabaseUrl(resolved.url)
} catch (error) {
  console.error(
    error instanceof Error
      ? error.message
      : "URL de test PostgreSQL refusée — détails non journalisés"
  )
  process.exit(1)
}
