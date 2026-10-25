import { PrismaClient } from "@prisma/client"

/** Never fall back to DATABASE_URL: these fixtures write to a disposable local DB. */
export function localDatabaseUrl() {
  const value = process.env.VEHICULE_V2_DATABASE_URL
  if (!value) throw new Error("Set VEHICULE_V2_DATABASE_URL for the disposable local PostgreSQL database")
  const url = new URL(value)
  if (url.protocol !== "postgresql:" || url.hostname !== "127.0.0.1" || url.port !== "55432"
    || url.pathname !== "/vehicule_test" || url.username !== "vehicule_test" || url.search || url.hash)
    throw new Error("Refusing database: expected postgresql://vehicule_test:…@127.0.0.1:55432/vehicule_test without query parameters")
  return value
}
export function localDb() { return new PrismaClient({ datasources: { db: { url: localDatabaseUrl() } } }) }
