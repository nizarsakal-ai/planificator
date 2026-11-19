/**
 * Amendement SPEC-INVOICE-IMPORT-001 §5 — passe les pièces importées d'UN lot de « Non précisé » (UNKNOWN) à « Payée » (PAID).
 *
 * Dry-run par défaut : liste exacte des pièces qui seraient modifiées, totaux signés (facture +, avoir −), aucune écriture.
 * Idempotent : seules les pièces encore au statut UNKNOWN du lot sont visées ; une seconde exécution ne trouve plus rien.
 *
 * Usage (dry-run) :
 *   DATABASE_URL="..." npx tsx scripts/imported-invoices-mark-paid.ts --company <companyId> --batch <batchId>
 *   (sans --batch : liste les lots qui contiennent des pièces UNKNOWN)
 *
 * Application (production : UNIQUEMENT après une sauvegarde de la base, confirmée) :
 *   DATABASE_URL="..." npx tsx scripts/imported-invoices-mark-paid.ts --company <companyId> --batch <batchId> \
 *     --actor <userId ADMIN de la société> --expected <nombre vu au dry-run> --apply --backup-confirmed
 */
import { PrismaClient } from "@prisma/client"
import { applyImportedStatusChange, listBatchesWithStatus, planImportedStatusChange, type StatusChangePlan } from "../src/lib/invoice-import/status-update.service"

interface Args { company: string; batch: string | null; actor: string | null; expected: number | null; apply: boolean; backupConfirmed: boolean }

class UsageError extends Error {}

function parseArgs(argv: string[]): Args {
  const value = (flag: string): string | null => {
    const i = argv.indexOf(flag)
    if (i === -1) return null
    const v = argv[i + 1]
    if (!v || v.startsWith("--")) throw new UsageError(`Valeur manquante pour ${flag}`)
    return v.trim()
  }
  const known = new Set(["--company", "--batch", "--actor", "--expected", "--apply", "--backup-confirmed"])
  for (const a of argv) if (a.startsWith("--") && !known.has(a)) throw new UsageError(`Option inconnue : ${a}`)
  const company = value("--company")
  if (!company) throw new UsageError("--company est obligatoire")
  const expectedRaw = value("--expected")
  const expected = expectedRaw === null ? null : Number(expectedRaw)
  if (expected !== null && (!Number.isInteger(expected) || expected < 1)) throw new UsageError("--expected doit être un entier ≥ 1")
  return { company, batch: value("--batch"), actor: value("--actor"), expected, apply: argv.includes("--apply"), backupConfirmed: argv.includes("--backup-confirmed") }
}

const euros = (c: bigint): string => {
  const neg = c < BigInt(0), a = neg ? -c : c
  return `${neg ? "-" : ""}${(a / BigInt(100)).toString()},${(a % BigInt(100)).toString().padStart(2, "0")} €`
}

function printPlan(p: StatusChangePlan): void {
  for (const i of p.items) console.log(`  ${i.kind === "CREDIT_NOTE" ? "AVOIR  " : "FACTURE"}  ${i.number.padEnd(20)} ${i.issueDate}  ${euros(i.signedTTCCents).padStart(16)}  ${i.clientName}`)
  console.log(`Pièces : ${p.items.length} (${p.invoiceCount} facture(s) ${euros(p.invoicesTTCCents)}, ${p.creditNoteCount} avoir(s) ${euros(p.creditNotesTTCCents)})`)
  console.log(`Net TTC qui passera en « Total encaissé » : ${euros(p.netTTCCents)}`)
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2))
  const db = new PrismaClient()
  try {
    const company = await db.company.findUnique({ where: { id: args.company }, select: { id: true, name: true } })
    if (!company) { console.error(`Société introuvable : ${args.company}`); return 2 }
    console.log(`Société : ${company.name} (${company.id})`)

    if (!args.batch) {
      const batches = await listBatchesWithStatus(db, company.id, "UNKNOWN")
      if (batches.length === 0) { console.log("Aucun lot ne contient de pièce au statut « Non précisé » : rien à faire."); return 0 }
      console.log("Lots contenant des pièces au statut « Non précisé » (relancez avec --batch <id>) :")
      for (const b of batches) console.log(`  ${b.id}  ${b.source}  validé le ${b.committedAt?.toISOString().slice(0, 10) ?? "?"}  ${b.count} pièce(s)`)
      return 0
    }

    // Le dry-run n'écrit rien : le contexte utilisateur ne sert qu'à l'application (journal, updatedById).
    const plan = await planImportedStatusChange(db, { companyId: company.id, userId: args.actor ?? "dry-run" }, { batchId: args.batch, from: "UNKNOWN", to: "PAID" })
    if (!plan.ok) { console.error(`Refusé : ${plan.error}`); return 2 }
    console.log(`Lot ${args.batch} — ${args.apply ? "APPLICATION" : "DRY-RUN (aucune écriture)"} : UNKNOWN → PAID`)
    printPlan(plan.value)
    if (plan.value.items.length === 0) { console.log("Rien à modifier : déjà appliqué (idempotent)."); return 0 }
    if (!args.apply) { console.log(`\nPour appliquer : ajoutez --actor <userId> --expected ${plan.value.items.length} --apply --backup-confirmed (après sauvegarde).`); return 0 }

    if (!args.backupConfirmed) { console.error("Refusé : --backup-confirmed est obligatoire (sauvegarde de la base faite et vérifiée)."); return 2 }
    if (args.expected === null) { console.error("Refusé : --expected <n> est obligatoire (nombre de pièces relu au dry-run)."); return 2 }
    if (!args.actor) { console.error("Refusé : --actor <userId> est obligatoire (auteur journalisé)."); return 2 }
    const actor = await db.user.findFirst({ where: { id: args.actor, companyId: company.id, role: { in: ["ADMIN", "SUPER_ADMIN"] } }, select: { id: true } })
    if (!actor) { console.error("Refusé : --actor doit être un administrateur de cette société."); return 2 }

    const r = await applyImportedStatusChange(db, { companyId: company.id, userId: actor.id }, { batchId: args.batch, from: "UNKNOWN", to: "PAID", expectedCount: args.expected })
    if (!r.ok) { console.error(`Refusé, aucune modification : ${r.error}`); return 2 }
    console.log(`Appliqué : ${r.value.items.length} pièce(s) passée(s) à « Payée » (journalisées dans history_logs).`)
    return 0
  } finally {
    await db.$disconnect()
  }
}

main().then((code) => { process.exitCode = code }).catch((e: unknown) => {
  if (e instanceof UsageError) { console.error(`Usage : ${e.message}`); process.exitCode = 64; return }
  console.error("Échec :", e instanceof Error ? e.message : e)
  process.exitCode = 1
})
