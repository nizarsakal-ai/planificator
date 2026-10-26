// Précontrôle de reprise (LECTURE SEULE) — correctif P1-01 : liste les pièces ÉMISES dont les totaux persistés diffèrent du recalcul
// depuis leurs lignes (ces pièces seront refusées par PDF/TVA/écritures après migration). Usage : DATABASE_URL=… node --import tsx tests/billing/pg/legacy/integrity-scan.ts
// N'écrit rien. Peut être exécuté sur une copie autorisée ; ce mandat ne l'applique qu'à des bases jetables synthétiques.
import { PrismaClient } from "@prisma/client"
import { recomputeDocumentTotals, storedTotalsMatch } from "@/lib/billing/document-integrity"

export async function scanIntegrity(db: PrismaClient): Promise<{ scanned: number; mismatches: { number: string; companyId: string; storedTTC: string; computedTTC: string }[] }> {
  const docs = await db.invoice.findMany({ where: { status: { not: "DRAFT" }, sentAt: { not: null } }, select: { number: true, companyId: true, status: true, globalDiscountBp: true, vatReverseCharge: true, totalHT: true, totalVAT: true, totalTTC: true, lines: { select: { quantity: true, unitPrice: true, vatRate: true, discountBp: true, deductsDepositId: true } } } })
  const mismatches: { number: string; companyId: string; storedTTC: string; computedTTC: string }[] = []
  for (const d of docs) {
    try {
      const t = recomputeDocumentTotals(d)
      if (!storedTotalsMatch(d, t)) mismatches.push({ number: d.number, companyId: d.companyId, storedTTC: d.totalTTC.toFixed(2), computedTTC: (Number(t.totalTTCCents) / 100).toFixed(2) })
    } catch (e) { mismatches.push({ number: d.number, companyId: d.companyId, storedTTC: d.totalTTC.toFixed(2), computedTTC: `ERREUR ${(e as Error).message}` }) }
  }
  return { scanned: docs.length, mismatches }
}

if (process.argv[1]?.endsWith("integrity-scan.ts")) {
  const db = new PrismaClient()
  scanIntegrity(db).then((r) => { console.log(JSON.stringify(r, null, 2)); return db.$disconnect() })
}
