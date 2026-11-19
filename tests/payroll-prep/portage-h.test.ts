/**
 * Lot H Planificator V2 — portage sur 90ae644 (19/11/2026) : contrôles sans base.
 * - Isolation : aucune dépendance aux lots D (réserves), F (connecteurs) ni G (Document Studio) ; forme canonique locale
 *   à la sémantique archivée.
 * - Retour explicite E4 : liste blanche « /pre-paie » et fiche d'identifiant borné ; fiches CRM et pages E inchangées.
 * - Actions : retour par état, cible calculée côté serveur, entrées refusées au-delà de leur borne (aucune troncature).
 * - Écrans : garde avant lecture, ZoneRetour/MessageRetour/FormulaireRetour, liens natifs ; export isolé et intègre.
 * - Clôture : lecture répétable, période « touchée » par chaque saisie, relance unique puis issue métier.
 */
import assert from "node:assert/strict"
import { readFileSync, readdirSync } from "node:fs"
import { describe, it } from "node:test"
import { canonicalJson, sha256Hex } from "@/lib/payroll-prep/canonical"
import { PREPAY_ERRORS, csvCell, toCsv, type PrepayLine } from "@/lib/payroll-prep/prepay.core"
import { adresseApresSucces, retour, RETOUR_INITIAL } from "@/lib/actions/retour-action"

const read = (f: string) => readFileSync(f, "utf8")
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n")
const PAGES = ["src/app/(dashboard)/pre-paie/page.tsx", "src/app/(dashboard)/pre-paie/[periodId]/page.tsx"]
const EXPORT = "src/app/(dashboard)/pre-paie/[periodId]/export/route.ts"
const H_FILES = [...readdirSync("src/lib/payroll-prep").map((f) => `src/lib/payroll-prep/${f}`), "src/lib/actions/payroll-prep.actions.ts", ...PAGES, EXPORT]

describe("isolation du lot H", () => {
  it("aucun import des lots D, F ou G", () => {
    for (const f of H_FILES) assert.doesNotMatch(code(read(f)), /from "@\/(?:lib|components)\/(?:reserves|connectors|assistant|document-studio)\b/, f)
  })
  it("forme canonique locale : sémantique archivée (clés triées, entiers sûrs, undefined refusé) ; SHA-256 hexadécimal minuscule", () => {
    assert.equal(canonicalJson({ year: 2026, month: 10, lines: [{ name: "Martin Ana", bonusCents: "15000" }], warnings: [] }), `{"lines":[{"bonusCents":"15000","name":"Martin Ana"}],"month":10,"warnings":[],"year":2026}`)
    assert.throws(() => canonicalJson({ a: 0.5 }), RangeError)
    assert.throws(() => canonicalJson({ a: undefined }), TypeError)
    assert.equal(sha256Hex("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
    assert.ok(code(read("src/lib/payroll-prep/prepay.service.ts")).includes(`import { canonicalJson, sha256Hex } from "@/lib/payroll-prep/canonical"`))
  })
  it("aucun littéral BigInt dans le module ni ses tests (cible ES2017)", () => {
    for (const f of [...H_FILES, "tests/payroll-prep/prepay-core.test.ts", "tests/payroll-prep/pg/prepay.pg.test.ts"]) assert.doesNotMatch(code(read(f)), /\b\d[\d_]*n\b/, f)
  })
})

describe("retour explicite : adresses H", () => {
  it("cible : fiche de la période ouverte ; pages rouvertes : liste et fiche", () => {
    assert.equal(adresseApresSucces(retour(true, "Période ouverte.", "/pre-paie/p_1"), "/pre-paie"), "/pre-paie/p_1?ok=P%C3%A9riode+ouverte.")
    for (const p of ["/pre-paie", "/pre-paie/p_1"]) assert.equal(adresseApresSucces(retour(true, "Variable ajoutée."), p), `${p}?ok=Variable+ajout%C3%A9e.`, p)
  })
  it("refusées : export, profondeur, longueur, encodage, variantes, schéma externe ; erreur ou état initial sans navigation", () => {
    for (const c of ["/pre-paie/p1/export", "/pre-paie/", "/pre-paie/a/b", `/pre-paie/${"a".repeat(65)}`, "/pre-paie/a%2Fb", "/pre-paie/../admin", "/pre-paie/a?x=1", "//evil.example/pre-paie", "https://evil.example/pre-paie", "/Pre-paie", "/pre-paiex"]) {
      assert.equal(adresseApresSucces(retour(true, "x", c), "/pre-paie"), null, `cible ${c}`)
      assert.equal(adresseApresSucces(retour(true, "x"), c), null, `page ${c}`)
    }
    assert.equal(adresseApresSucces(retour(false, PREPAY_ERRORS.blocking(2)), "/pre-paie/p1"), null)
    assert.equal(adresseApresSucces(RETOUR_INITIAL, "/pre-paie"), null)
  })
  it("comportement E inchangé ; source : FICHE et PAGES_LOT_E intactes, liste H distincte", () => {
    assert.equal(adresseApresSucces(retour(true, "x", "/crm/opportunites/c1"), "/crm/opportunites"), "/crm/opportunites/c1?ok=x")
    for (const p of ["/crm/opportunites", "/automatisations"]) assert.equal(adresseApresSucces(retour(true, "x"), p), `${p}?ok=x`, p)
    assert.equal(adresseApresSucces(retour(true, "x", "/crm/opportunites"), "/crm/opportunites"), null)
    const src = read("src/lib/actions/retour-action.ts")
    assert.ok(src.includes("const FICHE = /^\\/crm\\/opportunites\\/[A-Za-z0-9_-]{1,64}$/"))
    assert.ok(src.includes("const PAGES_LOT_E = /^\\/(?:crm\\/opportunites(?:\\/[A-Za-z0-9_-]{1,64})?|automatisations)$/"))
    assert.ok(src.includes("const PAGES_LOT_H = /^\\/pre-paie(?:\\/[A-Za-z0-9_-]{1,64})?$/"))
  })
})

describe("actions H", () => {
  const a = read("src/lib/actions/payroll-prep.actions.ts")
  const c = code(a)
  it("retour par état, signature compatible useActionState ; seule redirection : /login ; cible calculée côté serveur", () => {
    assert.match(a, /^"use server"/)
    assert.doesNotMatch(c, /revalidatePath|from "next\/cache"|safePath|back\(/)
    assert.equal((c.match(/redirect\(/g) ?? []).length, 1)
    assert.ok(c.includes(`if (e instanceof PrepayAccessError && e.reason === "UNAUTHENTICATED") redirect("/login")`))
    for (const n of ["openPeriodAction", "addVariableAction", "removeVariableAction", "closePeriodAction"]) {
      assert.match(c, new RegExp(`export async function ${n}\\(a: RetourAction \\| FormData, b\\?: FormData\\) \\{\\n  const form = formulaireDe\\(a, b\\)\\n  return run\\(`), n)
    }
    assert.ok(c.includes("cible: fichePeriode(r.value.id)"))
    assert.equal((c.match(/cible: /g) ?? []).length, 1, "seule l'ouverture ouvre une autre page")
    assert.ok(c.includes("await requirePrepayAdmin()"))
    assert.ok(c.includes(`if (champ(form, "confirm", 5) !== "oui") return { ok: false, error: "Cochez la confirmation de clôture." }`))
  })
  it("entrées bornées sans troncature : valeur trop longue refusée, jamais coupée", () => {
    assert.doesNotMatch(c, /\.slice\(0,/, "aucune troncature d'entrée")
    assert.ok(c.includes("return s.length > max ? null : s"))
    for (const [k, max] of [["month", 7], ["kind", 10], ["amount", 30], ["label", 120], ["confirm", 5]] as const) assert.ok(c.includes(`champ(form, "${k}", ${max})`), k)
    assert.ok(c.includes("const reqId = (f: FormData, k: string) => { const v = champ(f, k, 64); return v && ID.test(v) ? v : \"\" }"))
    for (const e of ["PREPAY_ERRORS.kind", "PREPAY_ERRORS.amount", "PREPAY_ERRORS.label"]) assert.ok(c.includes(`return { ok: false, error: ${e} }`), e)
  })
})

describe("écrans et export H", () => {
  it("garde avant lecture ; ZoneRetour, MessageRetour, FormulaireRetour ; aucun <form> brut ; liens natifs", () => {
    const attendus: Record<string, string[]> = { [PAGES[0]]: ["openPeriodAction"], [PAGES[1]]: ["removeVariableAction", "addVariableAction", "closePeriodAction"] }
    for (const f of PAGES) {
      const s = code(read(f))
      assert.ok(s.includes(`import { FormulaireRetour, MessageRetour, ZoneRetour } from "@/components/crm/RetourFormulaire"`), f)
      assert.ok(s.includes("<ZoneRetour rendu={Date.now()}>") && s.includes("</ZoneRetour>"), f)
      assert.match(s, /<MessageRetour><StockFlash params=\{(?:params|sp)\} \/><\/MessageRetour>/, f)
      assert.doesNotMatch(s, /<form[\s>]|from "next\/link"|<Link[\s>]/, f)
      for (const n of attendus[f]) assert.ok(s.includes(`<FormulaireRetour action={${n}}`), `${f} ${n}`)
      assert.equal((s.match(/<FormulaireRetour /g) ?? []).length, attendus[f].length, f)
      assert.ok(s.indexOf("if (!ctx) return <AdminOnlyNotice />") < s.indexOf("<ZoneRetour"), f)
    }
    assert.ok(code(read(PAGES[0])).includes("<a href={`/pre-paie/${p.id}`}"))
    const fiche = code(read(PAGES[1]))
    assert.ok(fiche.includes(`<a href="/pre-paie" className="text-xs text-[#0f3460] underline">← Pré-paie</a>`))
    assert.ok(fiche.includes("<a href={`/pre-paie/${v.period.id}/export`}"))
  })
  it("export : garde HTTP, 409 si instantané non intègre, private no-store, nosniff, nom PROVISOIRE ; CSV neutralisé", () => {
    const ex = read(EXPORT)
    assert.ok(ex.includes(`"Cache-Control": "private, no-store"`) && ex.includes(`"X-Content-Type-Options": "nosniff"`))
    assert.match(ex, /if \(!v\.intact\) \{[\s\S]*?return none\(409\)/)
    assert.ok(ex.includes(`\${v.provisional ? "-PROVISOIRE" : ""}`))
    for (const [v, attendu] of [["=1+1", "'=1+1"], ["+33", "'+33"], ["-2", "'-2"], ["@x", "'@x"], ["\tA", "'\tA"], ['a"b', '"a""b"'], ["a;b", '"a;b"']]) assert.equal(csvCell(v), attendu, v)
    const ligne: PrepayLine = { employeeId: "e1", name: "=HYPERLINK(\"x\")", workedMinutes: 0, workedDays: 0, absenceDays: { VACATION: 0, SICK: 0, UNPAID: 0, TRAINING: 0, OTHER: 0 }, bonusCents: "0", expenseCents: "0" }
    assert.ok(toCsv([ligne]).includes(`"'=HYPERLINK(""x"")";e1;`))
  })
})

describe("clôture cohérente", () => {
  const s = code(read("src/lib/payroll-prep/prepay.service.ts"))
  it("lecture répétable : verrou puis calcul dans le même instantané ; saisie et suppression touchent la période", () => {
    assert.ok(s.includes("{ isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead }"))
    assert.ok(s.indexOf("const p = await lockOpen(tx, ctx, periodId)") < s.indexOf("const r = await computePeriod(tx, ctx.companyId, p)"))
    assert.equal((s.match(/await touchPeriod\(tx, ctx, p\.id\)/g) ?? []).length, 2, "addVariable et removeVariable")
    assert.ok(s.includes(`UPDATE "payroll_periods" SET "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = \${periodId} AND "companyId" = \${ctx.companyId} AND "status" = 'OPEN'`))
  })
  it("conflit : une relance au plus, puis issue métier explicite", () => {
    assert.ok(s.includes("if (tentative >= 2) return { ok: false, error: PREPAY_ERRORS.concurrent }"))
    assert.ok(s.includes("if (!isSerializationConflict(e)) throw e"))
    assert.match(PREPAY_ERRORS.concurrent, /relancez la clôture/)
  })
})
