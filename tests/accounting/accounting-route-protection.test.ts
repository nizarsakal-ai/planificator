// COMPTABILITÉ LOT 0 — protection serveur de /comptabilite et garde-fous d'architecture (lecture des sources).
import assert from "node:assert/strict"
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs"
import { dirname, join, relative } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, it } from "node:test"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..")
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8")
/** Code seul : les commentaires (qui peuvent nommer des interdits) ne comptent pas. */
const code = (rel: string) =>
  read(rel)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1")

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else out.push(p)
  }
  return out
}

const ACCOUNTING_LIB_FILES = walk(join(ROOT, "src/lib/accounting")).map((p) => relative(ROOT, p))
const UI_DIR = "src/app/(dashboard)/comptabilite"
const UI_FILES = walk(join(ROOT, UI_DIR)).map((p) => relative(ROOT, p)).sort()
const PAGES = UI_FILES.filter((f) => f.endsWith("/page.tsx"))
const ROUTES = UI_FILES.filter((f) => f.endsWith("/route.ts"))

describe("/comptabilite (A2) — protection côté serveur de chaque écran (pas seulement le menu)", () => {
  it("inventaire exact des écrans et exports", () => {
    assert.deepEqual(UI_FILES, [
      `${UI_DIR}/balance/export/route.ts`,
      `${UI_DIR}/balance/page.tsx`,
      `${UI_DIR}/banque/page.tsx`,
      `${UI_DIR}/ecritures/[id]/page.tsx`,
      `${UI_DIR}/ecritures/nouvelle/page.tsx`,
      `${UI_DIR}/ecritures/page.tsx`,
      `${UI_DIR}/exercices/page.tsx`,
      `${UI_DIR}/factures/page.tsx`,
      `${UI_DIR}/fec/export/route.ts`,
      `${UI_DIR}/fec/page.tsx`,
      `${UI_DIR}/fournisseurs/[id]/fichier/route.ts`,
      `${UI_DIR}/fournisseurs/[id]/page.tsx`,
      `${UI_DIR}/fournisseurs/nouvelle/page.tsx`,
      `${UI_DIR}/fournisseurs/page.tsx`,
      `${UI_DIR}/grand-livre/export/route.ts`,
      `${UI_DIR}/grand-livre/page.tsx`,
      `${UI_DIR}/layout.tsx`,
      `${UI_DIR}/page.tsx`,
      `${UI_DIR}/plan/page.tsx`,
      `${UI_DIR}/tableau-de-bord/page.tsx`,
      `${UI_DIR}/tva/page.tsx`,
    ])
  })

  it("layout et pages : composants serveur asynchrones, garde AVANT toute lecture et tout rendu", () => {
    for (const file of [`${UI_DIR}/layout.tsx`, ...PAGES]) {
      const src = code(file)
      assert.doesNotMatch(src, /"use client"/, file)
      assert.match(src, /export default async function \w+\(/, file)
      const guard = src.indexOf("await requireAccountingPage()")
      assert.ok(guard > 0, `${file} : garde requireAccountingPage()`)
      for (const marker of ["await params", "await searchParams", "prisma, ctx", "return ("]) {
        const at = src.indexOf(marker)
        if (at >= 0) assert.ok(at > guard, `${file} : « ${marker} » après la garde`)
      }
    }
  })

  it("la garde de page applique les conventions du Lot 0 (login / 404 / dashboard)", () => {
    const src = code("src/lib/accounting/ui/page-context.ts")
    assert.match(src, /disposition === "login"\) redirect\("\/login"\)/)
    assert.match(src, /disposition === "not-found"\) notFound\(\)/)
    assert.match(src, /redirect\("\/dashboard"\)/)
  })

  it("exports CSV : garde requireAccountingRoute() en premier, réponse non mise en cache", () => {
    for (const file of ROUTES) {
      const src = code(file)
      const guard = src.indexOf("await requireAccountingRoute()")
      assert.ok(guard > 0, file)
      assert.ok(src.indexOf("request.url") > guard, `${file} : paramètres lus après la garde`)
      assert.doesNotMatch(src, /export async function (POST|PUT|PATCH|DELETE)/, `${file} : lecture seule`)
    }
    assert.match(code("src/lib/accounting/ui/route-guard.ts"), /"Cache-Control": "no-store"/)
  })

  it("aucun écran ne reçoit la société du client : companyId vient uniquement de la session", () => {
    for (const file of UI_FILES) assert.doesNotMatch(code(file), /companyId/, file)
    for (const file of walk(join(ROOT, "src/components/comptabilite")).map((p) => relative(ROOT, p))) {
      assert.doesNotMatch(code(file), /companyId|@\/lib\/prisma/, file)
    }
  })

  it("les Server Actions passent toutes par requireAccountingAdmin() et le moteur transactionnel", () => {
    const srcC5 = code("src/lib/actions/accounting-c5.actions.ts")
    assert.match(srcC5, /^"use server"/m)
    assert.match(srcC5, /await requireAccountingAdmin\(\)/)
    assert.doesNotMatch(srcC5, /companyId:\s*(raw|input|p\.data|body)/, "C5 : companyId jamais issu de l'entrée")
    const src = code("src/lib/accounting/actions/accounting.actions.ts")
    assert.match(src, /^"use server"/m)
    assert.match(src, /await requireAccountingAdmin\(\)/)
    assert.match(src, /runAccountingTransaction\(/)
    assert.doesNotMatch(src, /companyId:\s*(raw|input|data)\b/)
  })

  it("le middleware ne contient aucune règle comptable (la sécurité n'y est pas déléguée)", () => {
    assert.doesNotMatch(read("src/auth.config.ts"), /comptabilit|accounting/i)
    assert.doesNotMatch(read("src/middleware.ts"), /comptabilit|accounting/i)
  })
})

describe("garde — wiring serveur", () => {
  it("requireAccountingAdmin() n'accepte aucun argument et dérive tout de la session serveur", () => {
    const src = code("src/lib/accounting/access/accounting-access.ts")
    assert.match(src, /export function requireAccountingAdmin\(\): Promise<AccountingAccessContext>/)
    assert.match(src, /export function resolveAccountingAccessForRequest\(\)/)
    assert.doesNotMatch(src, /formData|FormData|searchParams|req\.|request|body|headers\(|cookies\(/)
  })

  it("la lecture de société est en lecture seule (findUnique, select id/active)", () => {
    const src = read("src/lib/accounting/access/accounting-access.ts")
    assert.match(src, /prisma\.company\.findUnique\(\{ where: \{ id: companyId \}, select: \{ id: true, active: true \} \}\)/)
  })

  it("aucun composant client n'importe la garde serveur", () => {
    const comps = walk(join(ROOT, "src/components")).filter((p) => /\.(ts|tsx)$/.test(p))
    for (const file of comps) {
      assert.doesNotMatch(readFileSync(file, "utf8"), /lib\/accounting\/access\/accounting-access["']/, relative(ROOT, file))
    }
  })
})

describe("flag — jamais exposé au navigateur", () => {
  it("aucune variable NEXT_PUBLIC_ACCOUNTING* ni lecture du flag dans un composant", () => {
    const all = walk(join(ROOT, "src")).filter((p) => /\.(ts|tsx)$/.test(p))
    for (const file of all) {
      const src = readFileSync(file, "utf8")
      assert.doesNotMatch(src, /NEXT_PUBLIC_ACCOUNTING/, relative(ROOT, file))
      if (/\.tsx$/.test(file) && /"use client"/.test(src)) {
        assert.doesNotMatch(src, /ACCOUNTING_MODULE_ENABLED|isAccountingModuleEnabled/, relative(ROOT, file))
      }
    }
  })

  it("le flag n'est lu que dans accounting-feature-flag.ts", () => {
    const readers = walk(join(ROOT, "src"))
      .filter((p) => /\.(ts|tsx)$/.test(p))
      .filter((p) => /process\.env\.ACCOUNTING|env\[ACCOUNTING_MODULE_FLAG_NAME\]/.test(readFileSync(p, "utf8")))
      .map((p) => relative(ROOT, p))
    assert.deepEqual(readers, ["src/lib/accounting/accounting-feature-flag.ts"])
  })
})

// Lot C5 (SPEC-BILLING-C5) : la couche de raccordement src/lib/accounting/c5/ lit les pièces de facturation et écrit
// ses propres tables (lien pièce ↔ écriture, fournisseurs, banque, TVA) ; le grand livre (journal_entries, lignes,
// séquences, têtes de chaîne) n'est écrit QUE par le moteur A1 (createDraftEntry/postEntry).
const C5_DIR = "src/lib/accounting/c5/"
describe("A1 — périmètre du moteur comptable (aucun branchement facture, aucune écriture hors service)", () => {
  const A1_MIGRATION = "20261025200000_accounting_a1_engine"
  const C5_MIGRATION = "20261026040000_accounting_c5"
  // transaction.ts n'écrit rien lui-même : il ouvre la transaction ($transaction) du moteur.
  const ENGINE_WRITERS = ["src/lib/accounting/engine/admin.ts", "src/lib/accounting/engine/fiscal-years.ts", "src/lib/accounting/engine/posting.ts", "src/lib/accounting/engine/setup.ts", "src/lib/accounting/engine/transaction.ts"]

  it("schema.prisma : exactement les modèles et enums comptables d'A1", () => {
    const schema = read("prisma/schema.prisma")
    const found = [...schema.matchAll(/^(model|enum)\s+(Accounting\w*|Journal\w*|Ledger\w*|Fiscal\w*|Posting\w*|ChartOf\w*|VatRate\w*)/gm)].map((m) => m[2]).sort()
    assert.deepEqual(found, [
      "AccountingAccount", "AccountingChainHead", "AccountingDocumentPosting", "AccountingJournal", "AccountingJournalKind", "AccountingSequence",
      "FiscalYear", "FiscalYearStatus", "JournalEntry", "JournalEntryLine", "JournalEntryStatus",
    ])
    const entryModel = schema.slice(schema.indexOf("model JournalEntry {"), schema.indexOf("}", schema.indexOf("model JournalEntry {")))
    assert.doesNotMatch(entryModel, /\b(Invoice|Quote|ExpenseReport)\b/, "aucune relation écriture → facture/devis/note de frais en A1")
  })

  it("une seule migration comptable : celle d'A1", () => {
    const dirs = readdirSync(join(ROOT, "prisma/migrations"))
    assert.deepEqual(
      dirs.filter((d) => /accounting|comptabilit|ledger|fiscal_|posting|chart_of_accounts|_fec(_|$)|_vat(_|$)|_tva(_|$)/i.test(d)),
      [A1_MIGRATION, C5_MIGRATION]
    )
  })

  it("src/lib/accounting : écritures uniquement dans le service transactionnel, jamais sur facture/devis/acquisition", () => {
    assert.ok(ACCOUNTING_LIB_FILES.length > 0)
    for (const file of ACCOUNTING_LIB_FILES) {
      const src = code(file)
      if (file.startsWith(C5_DIR)) {
        // Raccordement : jamais d'écriture directe au grand livre ni aux pièces de facturation (lecture seule), jamais de SQL brut d'écriture.
        assert.doesNotMatch(src, /\b(prisma|tx|db)\.(journalEntry|journalEntryLine|accountingSequence|accountingChainHead|accountingJournal|fiscalYear)\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\(/, `${file} : grand livre écrit par le moteur uniquement`)
        assert.doesNotMatch(src, /\b(prisma|tx|db)\.(invoice|invoiceLine|invoicePayment|quote|quoteLine|documentCounter)\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\(/, `${file} : pièces de facturation en lecture seule`)
        assert.doesNotMatch(src, /\b(INSERT|UPDATE|DELETE)\s+(INTO\s+|FROM\s+)?"/, `${file} : aucun SQL brut d'écriture`)
        assert.doesNotMatch(src, /from\s+["'][^"']*(acquisition|booking|gmail|openai)[^"']*["']/i, file)
        continue
      }
      if (!ENGINE_WRITERS.includes(file)) {
        assert.doesNotMatch(src, /\b(prisma|tx|db)\.\w+\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\(|\$executeRaw|\$transaction|\b(INSERT|UPDATE|DELETE)\s+(INTO\s+|FROM\s+)?"/, file)
      }
      assert.doesNotMatch(src, /\b(prisma|tx)\.(invoice|quote|expenseReport|documentCounter|worksite|client)\b/i, file)
      assert.doesNotMatch(src, /"(invoices|invoice_lines|quotes|expense_reports|document_counters)"/i, file)
      assert.doesNotMatch(src, /from\s+["'][^"']*(acquisition|booking|gmail|billing|anthropic|openai)[^"']*["']/i, file)
      if (file.startsWith("src/lib/accounting/engine/")) {
        assert.doesNotMatch(src, /from\s+["']@\/lib\/prisma["']/, `${file} : le moteur reçoit le client de transaction, il n'importe pas le client global`)
      }
    }
  })

  it("seuls fichiers autorisés dans src/lib/accounting", () => {
    assert.deepEqual(ACCOUNTING_LIB_FILES.sort(), [
      "src/lib/accounting/access/accounting-access.core.ts",
      "src/lib/accounting/access/accounting-access.ts",
      "src/lib/accounting/accounting-feature-flag.ts",
      "src/lib/accounting/actions/accounting.actions.ts",
      "src/lib/accounting/c5/auto-post.ts",
      "src/lib/accounting/c5/bank-import.ts",
      "src/lib/accounting/c5/bank.service.ts",
      "src/lib/accounting/c5/dashboard.ts",
      "src/lib/accounting/c5/fec.ts",
      "src/lib/accounting/c5/ocr-provider.ts",
      "src/lib/accounting/c5/postings.ts",
      "src/lib/accounting/c5/supplier-classification.ts",
      "src/lib/accounting/c5/supplier-invoice.service.ts",
      "src/lib/accounting/c5/vat-declaration.ts",
      "src/lib/accounting/c5/vat-history.ts",
      "src/lib/accounting/c5/vat.ts",
      "src/lib/accounting/engine/admin.ts",
      "src/lib/accounting/engine/canonical.ts",
      "src/lib/accounting/engine/fiscal-years.ts",
      "src/lib/accounting/engine/money.ts",
      "src/lib/accounting/engine/posting.ts",
      "src/lib/accounting/engine/queries.ts",
      "src/lib/accounting/engine/reads.ts",
      "src/lib/accounting/engine/setup.ts",
      "src/lib/accounting/engine/transaction.ts",
      "src/lib/accounting/engine/validate.ts",
      "src/lib/accounting/ui/csv.ts",
      "src/lib/accounting/ui/forms.ts",
      "src/lib/accounting/ui/labels.ts",
      "src/lib/accounting/ui/page-context.ts",
      "src/lib/accounting/ui/route-guard.ts",
    ])
  })
})
