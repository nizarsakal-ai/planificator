// COMPTABILITÉ LOT 0 — entrée de navigation « Comptabilité » (affichage uniquement, aucune DB).
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, it } from "node:test"
import type { Role } from "@prisma/client"
import { isAccountingNavVisible } from "@/lib/accounting/access/accounting-access.core"
import {
  ACCOUNTING_NAV_ITEM,
  getActiveNavHref,
  getNavItems,
  withAccountingNavItem,
} from "@/lib/navigation/nav-config"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..")
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8")
const ROLES: Role[] = ["SUPER_ADMIN", "ADMIN", "TEAM_LEADER", "EMPLOYEE", "CLIENT"]

describe("navigation comptabilité", () => {
  it("l'entrée est unique : Comptabilité → /comptabilite", () => {
    assert.equal(ACCOUNTING_NAV_ITEM.label, "Comptabilité")
    assert.equal(ACCOUNTING_NAV_ITEM.href, "/comptabilite")
  })

  it("getNavItems n'inclut JAMAIS Comptabilité (menus existants strictement inchangés)", () => {
    for (const role of ROLES) {
      assert.ok(!getNavItems(role).some((i) => i.href === "/comptabilite"), role)
    }
    assert.equal(getNavItems("ADMIN").length, 20)
    assert.equal(getNavItems("SUPER_ADMIN").length, 21)
  })

  it("visible=false : liste identique, pour tous les rôles", () => {
    for (const role of ROLES) {
      assert.deepEqual(withAccountingNavItem(getNavItems(role), false).map((i) => i.href), getNavItems(role).map((i) => i.href))
    }
  })

  it("visible=true : une seule entrée ajoutée juste après « Factures » (menu ADMIN)", () => {
    for (const role of ["ADMIN"] as Role[]) {
      const base = getNavItems(role)
      const items = withAccountingNavItem(base, true)
      assert.equal(items.length, base.length + 1, role)
      const i = items.findIndex((x) => x.href === "/factures")
      assert.equal(items[i + 1]?.href, "/comptabilite", role)
      assert.equal(items.filter((x) => x.href === "/comptabilite").length, 1, role)
      // Les autres entrées conservent leur ordre.
      assert.deepEqual(items.filter((x) => x.href !== "/comptabilite").map((x) => x.href), base.map((x) => x.href))
    }
  })

  it("SUPER_ADMIN avec société : lien visible (affichage seulement ; la garde serveur le borne à sa société de rattachement)", () => {
    assert.equal(isAccountingNavVisible({ enabled: true, role: "SUPER_ADMIN", companyId: "c1" }), true)
    assert.equal(isAccountingNavVisible({ enabled: true, role: "SUPER_ADMIN", companyId: null }), false)
    assert.equal(isAccountingNavVisible({ enabled: true, role: "ADMIN", companyId: "c1" }), true)
    const hasFactures = getNavItems("SUPER_ADMIN").some((i) => i.href === "/factures")
    const items = withAccountingNavItem(getNavItems("SUPER_ADMIN"), true)
    assert.equal(items.some((i) => i.href === "/comptabilite"), hasFactures)
  })

  it("TEAM_LEADER, EMPLOYEE, CLIENT : jamais d'entrée, même si visible=true (pas de « Factures » à côté duquel l'insérer)", () => {
    for (const role of ["TEAM_LEADER", "EMPLOYEE", "CLIENT"] as Role[]) {
      assert.ok(!withAccountingNavItem(getNavItems(role), true).some((i) => i.href === "/comptabilite"), role)
    }
  })

  it("idempotent : pas de doublon, aucune mutation de la liste d'origine", () => {
    const base = getNavItems("ADMIN")
    const once = withAccountingNavItem(base, true)
    assert.equal(withAccountingNavItem(once, true).length, once.length)
    assert.equal(base.length, 20)
  })

  it("/comptabilite devient l'unique entrée active sur sa route, et « Factures » reste active sur /factures", () => {
    const items = withAccountingNavItem(getNavItems("ADMIN"), true)
    assert.equal(getActiveNavHref(items, "/comptabilite"), "/comptabilite")
    assert.equal(getActiveNavHref(items, "/comptabilite/plus-tard"), "/comptabilite")
    assert.equal(getActiveNavHref(items, "/factures"), "/factures")
  })

  it("Sidebar et MobileNav n'ajoutent l'entrée que via la configuration centrale, avec un drapeau calculé côté serveur", () => {
    for (const file of ["src/components/layout/Sidebar.tsx", "src/components/layout/MobileNav.tsx"]) {
      const src = read(file)
      assert.match(src, /withAccountingNavItem\(getNavItems\(user\.role\), user\.accountingNavVisible === true\)/, file)
      assert.doesNotMatch(src, /comptabilite/i, `${file} ne définit aucune route comptable localement`)
      assert.doesNotMatch(src, /ACCOUNTING_MODULE_ENABLED|process\.env/, `${file} ne lit aucun flag`)
    }
  })

  it("le layout serveur calcule la visibilité (flag + rôle + société relus en base) avant de la passer aux composants", () => {
    const src = read("src/app/(dashboard)/layout.tsx")
    assert.match(src, /isAccountingNavVisible\(\{\s*enabled: isAccountingModuleEnabled\(\),\s*role,\s*companyId,\s*\}\)/)
    assert.match(src, /accountingNavVisible/)
    assert.doesNotMatch(src, /"use client"/)
  })
})
