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
const PAGE = "src/app/(dashboard)/comptabilite/page.tsx"

describe("/comptabilite — protection côté serveur (pas seulement le menu)", () => {
  it("la page existe et est un composant serveur asynchrone", () => {
    assert.ok(existsSync(join(ROOT, PAGE)))
    const src = read(PAGE)
    assert.doesNotMatch(src, /"use client"/)
    assert.match(src, /export default async function ComptabilitePage\(/)
  })

  it("la garde serveur s'exécute AVANT tout rendu et tout contenu", () => {
    const src = read(PAGE)
    const guard = src.indexOf("await resolveAccountingAccessForRequest()")
    const firstJsx = src.indexOf("return (")
    assert.ok(guard > 0 && firstJsx > guard, "garde avant le premier return JSX")
    assert.match(src, /if \(!access\.ok\) \{/)
  })

  it("refus : /login si non connecté, 404 si module désactivé, /dashboard sinon", () => {
    const src = read(PAGE)
    assert.match(src, /disposition === "login"\) redirect\("\/login"\)/)
    assert.match(src, /disposition === "not-found"\) notFound\(\)/)
    assert.match(src, /redirect\("\/dashboard"\)/)
  })

  it("la page n'accepte aucune entrée client (ni searchParams, ni params, ni formulaire, ni companyId)", () => {
    const src = code(PAGE)
    assert.doesNotMatch(src, /searchParams|params|formData|FormData|cookies\(|headers\(|companyId/)
  })

  it("la page n'affiche aucune donnée financière : aucun accès base, facture, KPI", () => {
    const src = code(PAGE)
    assert.doesNotMatch(src, /prisma|invoice|facture|KPI|€|toLocaleString/i)
    assert.match(src, /Module comptabilité — préparation en cours/)
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

describe("Lot 0 — aucune base de données, aucune logique comptable", () => {
  it("schema.prisma ne contient aucun modèle ni enum comptable", () => {
    const schema = read("prisma/schema.prisma")
    assert.doesNotMatch(schema, /^(model|enum)\s+(Accounting|Journal|Ledger|Fiscal|Posting|ChartOf|VatRate)/m)
  })

  it("aucune migration comptable", () => {
    const dirs = readdirSync(join(ROOT, "prisma/migrations"))
    assert.deepEqual(
      dirs.filter((d) => /accounting|comptabilit|ledger|fiscal_|posting|chart_of_accounts|_fec(_|$)|_vat(_|$)|_tva(_|$)/i.test(d)),
      []
    )
  })

  it("src/lib/accounting n'écrit jamais en base et ne touche ni facture, ni devis, ni acquisition", () => {
    assert.ok(ACCOUNTING_LIB_FILES.length > 0)
    for (const file of ACCOUNTING_LIB_FILES) {
      const src = code(file)
      assert.doesNotMatch(src, /\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\(|\$executeRaw|\$queryRaw|\$transaction/, file)
      assert.doesNotMatch(src, /prisma\.(invoice|quote|expenseReport|documentCounter|worksite|client)\b/i, file)
      assert.doesNotMatch(src, /from\s+["'][^"']*(acquisition|booking|gmail|billing|anthropic|openai)[^"']*["']/i, file)
    }
  })

  it("seuls fichiers autorisés dans src/lib/accounting (pas de structure vide artificielle)", () => {
    assert.deepEqual(ACCOUNTING_LIB_FILES.sort(), [
      "src/lib/accounting/access/accounting-access.core.ts",
      "src/lib/accounting/access/accounting-access.ts",
      "src/lib/accounting/accounting-feature-flag.ts",
    ])
  })
})
