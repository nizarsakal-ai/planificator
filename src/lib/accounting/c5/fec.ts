// Export FEC (art. A47 A-1 du LPF) — écritures VALIDÉES d'un exercice, 18 colonnes, séparateur « | », CRLF, UTF-8.
import type { Prisma, PrismaClient } from "@prisma/client"
import type { AccountingContext } from "@/lib/accounting/engine/posting"
import { sirenFromSiret } from "@/lib/billing/settings"

type Db = PrismaClient | Prisma.TransactionClient
export const FEC_HEADER = ["JournalCode", "JournalLib", "EcritureNum", "EcritureDate", "CompteNum", "CompteLib", "CompAuxNum", "CompAuxLib", "PieceRef", "PieceDate", "EcritureLib", "Debit", "Credit", "EcritureLet", "DateLet", "ValidDate", "Montantdevise", "Idevise"] as const

export const fecDate = (d: Date) => `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`
export const fecAmount = (cents: bigint) => { const abs = cents < BigInt(0) ? -cents : cents; return `${cents < BigInt(0) ? "-" : ""}${(abs / BigInt(100)).toString()},${(abs % BigInt(100)).toString().padStart(2, "0")}` }
/** Texte FEC : pas de séparateur, de retour à la ligne ni de tabulation. */
export const fecText = (s: string | null | undefined) => (s ?? "").replace(/[|\r\n\t]/g, " ").trim()

export interface FecResult { filename: string; content: string; lines: number; debitCents: bigint; creditCents: bigint; sirenMissing: boolean }

export async function buildFec(db: Db, ctx: AccountingContext, fiscalYearId: string): Promise<FecResult | null> {
  const fy = await db.fiscalYear.findFirst({ where: { id: fiscalYearId, companyId: ctx.companyId }, select: { endDate: true } })
  if (!fy) return null
  const company = await db.company.findUnique({ where: { id: ctx.companyId }, select: { siret: true } })
  const siren = sirenFromSiret(company?.siret)
  const entries = await db.journalEntry.findMany({
    where: { companyId: ctx.companyId, fiscalYearId, status: "VALIDATED" },
    orderBy: [{ entryDate: "asc" }, { journal: { code: "asc" } }, { number: "asc" }],
    select: { number: true, entryDate: true, documentDate: true, documentRef: true, label: true, validatedAt: true, journal: { select: { code: true, label: true } }, lines: { orderBy: { position: "asc" }, select: { label: true, debitCents: true, creditCents: true, account: { select: { number: true, label: true } } } } },
  })
  const rows: string[] = [FEC_HEADER.join("|")]
  let debit = BigInt(0), credit = BigInt(0)
  for (const e of entries) {
    for (const l of e.lines) {
      debit += l.debitCents; credit += l.creditCents
      rows.push([
        fecText(e.journal.code), fecText(e.journal.label), String(e.number ?? ""), fecDate(e.entryDate), fecText(l.account.number), fecText(l.account.label), "", "",
        fecText(e.documentRef) || String(e.number ?? ""), fecDate(e.documentDate ?? e.entryDate), fecText(l.label ?? e.label), fecAmount(l.debitCents), fecAmount(l.creditCents), "", "",
        e.validatedAt ? fecDate(e.validatedAt) : fecDate(e.entryDate), "", "",
      ].join("|"))
    }
  }
  return { filename: `${siren ?? "000000000"}FEC${fecDate(fy.endDate)}.txt`, content: rows.join("\r\n") + "\r\n", lines: rows.length - 1, debitCents: debit, creditCents: credit, sirenMissing: !siren }
}
