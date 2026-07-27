/**
 * Garde de sécurité pour tests PostgreSQL jetables (convention dépôt).
 * Ne journalise jamais l’URL complète.
 */

export type ResolvedTestDatabaseUrl =
  | { ok: true; url: string; source: string }
  | { ok: false; url?: undefined; source?: undefined }

/** Marqueurs explicites de base de test dans le nom de DB. */
const TEST_DB_NAME_MARKER =
  /(?:^|[_\-.])(?:test|tests|testing|lot1b|disposable|ephemeral)(?:[_\-.]|$)|(?:test|testing|lot1b|disposable|ephemeral)/i

const AMBIGUOUS_DB_NAMES = new Set([
  "",
  "postgres",
  "template0",
  "template1",
])

/**
 * Priorité : TEST_INTEGRATION_DATABASE_URL, puis TEST_ACQUISITION_DATABASE_URL.
 */
export function resolveIntegrationTestDatabaseUrl(): ResolvedTestDatabaseUrl {
  const integration = process.env.TEST_INTEGRATION_DATABASE_URL?.trim()
  if (integration) {
    return { ok: true, url: integration, source: "TEST_INTEGRATION_DATABASE_URL" }
  }
  const acquisition = process.env.TEST_ACQUISITION_DATABASE_URL?.trim()
  if (acquisition) {
    return {
      ok: true,
      url: acquisition,
      source: "TEST_ACQUISITION_DATABASE_URL",
    }
  }
  return { ok: false }
}

function isLocalOrDockerHost(host: string): boolean {
  return (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "::1" ||
    host === "0.0.0.0" ||
    host === "postgres" ||
    host.endsWith(".local")
  )
}

function dbNameHasExplicitTestMarker(dbName: string): boolean {
  return TEST_DB_NAME_MARKER.test(dbName)
}

/** Prod / production clairement identifiable sur hôte ou nom de DB. */
export function looksLikeProductionName(host: string, dbName: string): boolean {
  const parts = [host, dbName]
  for (const part of parts) {
    if (/production/i.test(part)) return true
    if (/(^|[_\-.])prod($|[_\-.])/i.test(part)) return true
    if (part.toLowerCase() === "prod") return true
  }
  return false
}

/**
 * Refuse les URL qui ressemblent à une base non jetable / production.
 * - localhost / 127.0.0.1 / ::1 / postgres : OK seulement si le dbname a un marqueur test
 * - hôtes distants : idem + marqueur test obligatoire
 * - db `postgres` / template0 / template1 : toujours refusées
 */
export function assertSafeDisposableTestDatabaseUrl(url: string): void {
  if (!/^postgres(ql)?:\/\//i.test(url)) {
    throw new Error(
      "URL de test PostgreSQL invalide (schéma postgres attendu) — URL non journalisée"
    )
  }

  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new Error(
      "URL de test PostgreSQL illisible — URL non journalisée"
    )
  }

  const host = parsed.hostname.toLowerCase()
  const dbName = decodeURIComponent(parsed.pathname.replace(/^\//, ""))
    .split("?")[0]!
    .toLowerCase()

  if (AMBIGUOUS_DB_NAMES.has(dbName)) {
    throw new Error(
      "Refus d’exécuter les tests PG : nom de base ambigu ou système (détails non journalisés)"
    )
  }

  if (looksLikeProductionName(host, dbName)) {
    throw new Error(
      "Refus d’exécuter les tests PG : l’URL ressemble à une base non jetable / production (détails non journalisés)"
    )
  }

  if (!dbNameHasExplicitTestMarker(dbName)) {
    throw new Error(
      "Refus d’exécuter les tests PG : le nom de base doit contenir un marqueur explicite de test (test, testing, lot1b, disposable, ephemeral) — détails non journalisés"
    )
  }

  if (!isLocalOrDockerHost(host)) {
    // Distant : marqueur déjà exigé sur dbName ; hôte peut aussi porter un marqueur
    // mais dbName suffit. Rien de plus ici.
  }
}
