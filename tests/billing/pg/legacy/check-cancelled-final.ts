// Vérification du scénario hérité `cancelled-final` après la chaîne complète (reprise 064000) : la déduction du solde annulé est
// LIBÉRÉE (releasedAt ≥ createdAt), conservée, inactive ; l'acompte n'a plus d'affectation active ; index unique partiel en place.
import assert from "node:assert/strict"
import { PrismaClient } from "@prisma/client"
const url = process.env.DATABASE_URL; if (!url) throw new Error("DATABASE_URL requis")
const db = new PrismaClient({ datasourceUrl: url })
async function main() {
  const rows = await db.$queryRaw<{ id: string; releasedAt: Date | null; createdAt: Date }[]>`SELECT "id", "releasedAt", "createdAt" FROM "invoice_deposit_deductions" WHERE "depositInvoiceId" = 'depCF'`
  assert.equal(rows.length, 1, "trace conservée (jamais supprimée)")
  assert.ok(rows[0].releasedAt, "libérée par la reprise 064000"); assert.ok(rows[0].releasedAt!.getTime() >= rows[0].createdAt.getTime(), "releasedAt ≥ createdAt")
  const fin = await db.$queryRaw<{ status: string; updatedAt: Date }[]>`SELECT "status"::text AS status, "updatedAt" FROM "invoices" WHERE "id" = 'finCF'`
  assert.equal(fin[0].status, "CANCELLED"); assert.equal(rows[0].releasedAt!.getTime(), fin[0].updatedAt.getTime(), "datée de la dernière modification du solde")
  const idx = await db.$queryRaw<{ indexdef: string }[]>`SELECT indexdef FROM pg_indexes WHERE indexname = 'invoice_deposit_deductions_one_active_per_deposit_key'`
  assert.match(idx[0]?.indexdef ?? "", /WHERE \("releasedAt" IS NULL\)/)
  const active = await db.$queryRaw<{ n: bigint }[]>`SELECT count(*)::bigint AS n FROM "invoice_deposit_deductions" WHERE "depositInvoiceId" = 'depCF' AND "releasedAt" IS NULL`
  assert.equal(Number(active[0].n), 0, "acompte sans affectation active : réaffectable une fois ou créditable")
  console.log("PASS cancelled-final : déduction libérée (conservée), acompte réaffectable, index partiel présent")
}
main().then(() => db.$disconnect(), async (e) => { console.error("FAIL", e); await db.$disconnect(); process.exit(1) })
