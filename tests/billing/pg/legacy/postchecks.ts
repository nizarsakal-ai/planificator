// Postchecks de la campagne héritée (après migrations C1–C5 + correctives), exécutés avec le RÔLE APPLICATIF (DATABASE_URL_APP) :
// conservation des valeurs/pièces, absence de renumérotation silencieuse, invariants d'avoir, restrictions de suppression,
// précontrôle d'intégrité, parcours C2 sur brouillons FAC hérités (plan de transition des séries).
import assert from "node:assert/strict"
import { PrismaClient } from "@prisma/client"
import { scanIntegrity } from "./integrity-scan"

const url = process.env.DATABASE_URL_APP; if (!url) throw new Error("DATABASE_URL_APP requis")
const db = new PrismaClient({ datasourceUrl: url })
const results: [string, boolean, string][] = []
const check = (name: string, ok: boolean, detail = "") => { results.push([name, ok, detail]); console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`) }
async function sqlError(sql: string): Promise<string> { try { await db.$executeRawUnsafe(sql); return "NO_ERROR" } catch (e) { return String((e as Error).message) } }

async function main() {
  const role = (await db.$queryRaw<{ u: string }[]>`SELECT current_user::text AS u`)[0].u
  check("rôle applicatif non propriétaire", role === (process.env.TEST_PG_APP_ROLE ?? "planificator_app_test"), role)
  check("rôle applicatif : désactivation de déclencheur refusée", /owner|permission|propriétaire/i.test(await sqlError(`ALTER TABLE invoices DISABLE TRIGGER invoices_guard_issued_trg`)))
  // Conservation des pièces et des valeurs.
  const inv = await db.invoice.findMany({ orderBy: [{ companyId: "asc" }, { number: "asc" }], select: { companyId: true, number: true, status: true, kind: true, creditScope: true, totalTTC: true } })
  const expected = [["coA", "AV-2025-0001", "SENT", "CREDIT_NOTE", "TOTAL", "240.00"], ["coA", "FAC-2025-0001", "PAID", "INVOICE", null, "108.50"], ["coA", "FAC-2025-0002", "CANCELLED", "INVOICE", null, "240.00"], ["coA", "FAC-2025-0003", "DRAFT", "INVOICE", null, "60.00"], ["coA", "FAC-2025-0004", "SENT", "INVOICE", null, "999.00"], ["coA", "FAC-2026-0001", "SENT", "INVOICE", null, "360.00"], ["coA", "FAC-2026-0002", "DRAFT", "INVOICE", null, "96.00"], ["coB", "FAC-2026-0001", "SENT", "INVOICE", null, "360.00"]]
  check("pièces, statuts, numéros et montants conservés (aucune renumérotation)", JSON.stringify(inv.map((i) => [i.companyId, i.number, i.status, i.kind, i.creditScope, i.totalTTC.toFixed(2)])) === JSON.stringify(expected), JSON.stringify(inv.map((i) => i.number)))
  check("avoir Lot B rétro-rempli creditScope=TOTAL", inv.find((i) => i.number === "AV-2025-0001")?.creditScope === "TOTAL")
  check("taux hérité 8,5 % lisible, colonnes C1 à défaut (remise 0, autoliquidation false)", (await db.invoice.findFirstOrThrow({ where: { number: "FAC-2025-0001", companyId: "coA" }, include: { lines: true } })).lines[0].vatRate.toFixed(2) === "8.50")
  const q = await db.quote.findFirstOrThrow({ where: { number: "DEV-2025-0001" } }); check("devis hérité : colonnes C1 par défaut, jeton absent", q.globalDiscountBp === 0 && q.signatureTokenHash === null)
  check("compteurs conservés", JSON.stringify((await db.documentCounter.findMany({ where: { companyId: "coA" }, orderBy: [{ type: "asc" }, { year: "asc" }], select: { type: true, year: true, lastValue: true } }))) === JSON.stringify([{ type: "CREDIT_NOTE", year: 2025, lastValue: 1 }, { type: "INVOICE", year: 2025, lastValue: 4 }, { type: "INVOICE", year: 2026, lastValue: 2 }, { type: "QUOTE", year: 2025, lastValue: 1 }, { type: "QUOTE", year: 2026, lastValue: 1 }]))
  // Invariants d'avoir et restrictions de suppression (rôle applicatif, déclencheurs actifs).
  check("suppression d'une facture émise refusée", /INVOICE_IMMUTABLE/.test(await sqlError(`DELETE FROM invoices WHERE number='FAC-2026-0001' AND "companyId"='coA'`)))
  check("suppression d'une société avec pièces refusée (FK RESTRICT)", /23503|foreign key|violates/.test(await sqlError(`DELETE FROM companies WHERE id='coB'`)))
  check("second avoir TOTAL sur la même facture refusé (index unique partiel)", /23505|already exists|CREDIT_NOTE_INVALID|INVOICE_IMMUTABLE/.test(await sqlError(`INSERT INTO invoices(id,"companyId","worksiteId","clientId",number,status,kind,"creditScope","creditedInvoiceId","totalHT","totalVAT","totalTTC","createdById","updatedAt") VALUES ('cn-dup','coA','wA','clA','AV-DUP','DRAFT','CREDIT_NOTE','TOTAL','iA2',200,40,240,'admA',now())`)))
  check("PAID héritée sans paiement : contrôle différé satisfait (mise à jour neutre)", (await sqlError(`UPDATE invoices SET "updatedAt"=now() WHERE id='iA1'`)) === "NO_ERROR")
  check("PAID héritée : avoir partiel SQL refusé (pas de contournement du plafond)", /PAYMENT_STATUS_MISMATCH|PAYMENT_EXCEEDS_TOTAL/.test(await (async () => { try { await db.$transaction(async (tx) => { await tx.$executeRawUnsafe(`INSERT INTO invoices(id,"companyId","worksiteId","clientId",number,status,kind,"creditScope","creditedInvoiceId","totalHT","totalVAT","totalTTC","createdById","updatedAt") VALUES ('cn-p','coA','wA','clA','AV-P','DRAFT','CREDIT_NOTE','PARTIAL','iA1',10,0.85,10.85,'admA',now())`); await tx.$executeRawUnsafe(`UPDATE invoices SET status='SENT', "sentAt"=now() WHERE id='cn-p'`); await tx.$executeRawUnsafe(`SET CONSTRAINTS ALL IMMEDIATE`) }); return "NO_ERROR" } catch (e) { return String((e as Error).message) } })()))
  check("lien devis inter-sociétés refusé (FK composite) sur un brouillon hérité", /23503|foreign key|violates/.test(await sqlError(`UPDATE invoices SET "quoteId"='qB1' WHERE id='iA3'`)))
  check("lien devis d'une pièce émise : immutabilité Lot B avant toute FK", /INVOICE_IMMUTABLE/.test(await sqlError(`UPDATE invoices SET "quoteId"='qB1' WHERE id='iA5'`)))
  // Précontrôle d'intégrité : la pièce volontairement incohérente est listée ; les autres passent.
  const scan = await scanIntegrity(db)
  check("précontrôle d'intégrité : FAC-2025-0004 (999 ≠ 120) listée, les autres cohérentes", scan.mismatches.length === 1 && scan.mismatches[0].number === "FAC-2025-0004", JSON.stringify(scan))
  // Parcours C2 sur les brouillons FAC hérités (plan de transition des séries) et sur une PAID héritée.
  process.env.BILLING_COMPLETE_ENABLED = "true"
  const { issueInvoice } = await import("@/lib/billing/invoices/invoice.service")
  const { setBillingMailerForTests, RecordingMailer } = await import("@/lib/billing/mail/mailer"); setBillingMailerForTests(new RecordingMailer())
  const now = new Date("2026-03-10T10:00:00Z")
  const r26 = await issueInvoice(db, { companyId: "coA", userId: "admA" }, "iA6", now)
  check("brouillon FAC-2026-0002 (année courante) émis en conservant son numéro", r26.ok && r26.value.number === "FAC-2026-0002", JSON.stringify(r26))
  const blocked = await issueInvoice(db, { companyId: "coA", userId: "admA" }, "iA3", now)
  check("brouillon hérité dont le client n'a pas d'adresse : émission REFUSÉE explicitement (fiche client à compléter — plan de transition)", !blocked.ok && /Adresse du client/.test((blocked as { error: string }).error), JSON.stringify(blocked))
  await db.$executeRawUnsafe(`UPDATE clients SET address='12 rue complétée' WHERE id='clA2'`)
  const r25 = await issueInvoice(db, { companyId: "coA", userId: "admA" }, "iA3", now)
  check("brouillon FAC-2025-0003 (année précédente) émis sous un NOUVEAU numéro 2026 — l'ancien numéro devient un trou DOCUMENTÉ de la série 2025", r25.ok && r25.value.number === "FAC-2026-0003", JSON.stringify(r25))
  check("snapshots documentaires créés pour les pièces émises après migration seulement", (await db.invoiceDocumentSnapshot.count()) === 2)
  const { buildInvoicePdfData } = await import("@/lib/billing/pdf/invoice-pdf")
  const legacyPdf = await buildInvoicePdfData(db, "coA", "iA5", now)
  check("réédition d'une pièce héritée : signalée « snapshot historique indisponible », jamais reconstruite", legacyPdf?.reissue?.source === "CURRENT_NO_SNAPSHOT")
  const { computeVat } = await import("@/lib/accounting/c5/vat")
  const vat2026 = await computeVat(db, { companyId: "coA" }, new Date("2026-01-01T00:00:00Z"), new Date("2026-12-31T00:00:00Z"), "DEBITS")
  check("TVA débits 2026 calculable sur pièces héritées cohérentes", vat2026.collectedCents > BigInt(0))
  const bad = await computeVat(db, { companyId: "coA" }, new Date("2025-01-01T00:00:00Z"), new Date("2025-12-31T00:00:00Z"), "DEBITS").then(() => "OK").catch((e) => (e as Error).name)
  check("TVA débits 2025 REFUSÉE explicitement (pièce incohérente FAC-2025-0004)", bad === "DocumentIntegrityError", bad)
  const failed = results.filter((r) => !r[1])
  console.log(`RESULTAT LEGACY (coherent): ${results.length - failed.length}/${results.length}${failed.length ? " ECHEC" : " OK"}`)
  await db.$disconnect()
  if (failed.length) process.exit(1)
}
main().catch((e) => { console.error(e); process.exit(1) })
