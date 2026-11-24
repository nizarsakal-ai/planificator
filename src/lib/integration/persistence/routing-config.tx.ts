/**
 * PLAN-INTEGRATION-PLATFORM-001 — LOT-2
 * Transaction unique pour une mutation de configuration de routage ET son audit (SPEC LOT-2 §18.3 ; revue indépendante
 * du 24/11/2026, point 5) : soit les deux sont écrits, soit aucun. Les dépôts reçoivent le client de transaction.
 */
import type { PrismaClient } from "@prisma/client"
import { prisma } from "@/lib/prisma"

export type RoutingConfigDb = PrismaClient

export function runRoutingConfigTransaction<T>(fn: (db: RoutingConfigDb) => Promise<T>, db: PrismaClient = prisma): Promise<T> {
  return db.$transaction((tx) => fn(tx as unknown as PrismaClient))
}
