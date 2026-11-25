import { PrismaClient } from "@prisma/client"
import { serverlessDatasources } from "@/lib/database-url"
import { logPrismaEngineError } from "@/lib/prisma-error-log"

// Singleton Prisma pour éviter les connexions multiples en développement (hot reload)
const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined
}

function createPrismaClient(): PrismaClient {
  const client = new PrismaClient({
    ...serverlessDatasources(),
    // Erreurs en événement : filtrées par logPrismaEngineError (bruit des connexions fermées à l'inactivité).
    log:
      process.env.NODE_ENV === "development"
        ? [
            { emit: "stdout", level: "query" },
            { emit: "stdout", level: "warn" },
            { emit: "event", level: "error" },
          ]
        : [{ emit: "event", level: "error" }],
  })
  client.$on("error", (event) => logPrismaEngineError(event))
  return client
}

export const prisma = globalForPrisma.prisma ?? createPrismaClient()

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma
}
