/** SPEC-WORKSITE-PHOTOS-001 Lot 3 — lien « Photos engins » : affichage seulement, inséré après « Chantiers », idempotent. */
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, it } from "node:test"
import { Camera } from "lucide-react"
import { getNavItems, withWorksitePhotosNavItem } from "@/lib/navigation/nav-config"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..")
const read = (p: string) => readFileSync(join(ROOT, p), "utf8")

describe("withWorksitePhotosNavItem", () => {
  it("invisible ⇒ liste inchangée (nouvelle instance) ; visible ⇒ inséré juste après /chantiers ; idempotent", () => {
    for (const role of ["EMPLOYEE", "TEAM_LEADER", "ADMIN", "SUPER_ADMIN"] as const) {
      const base = getNavItems(role)
      const hidden = withWorksitePhotosNavItem(base, false)
      assert.deepEqual(hidden, base)
      assert.notEqual(hidden, base)
      const shown = withWorksitePhotosNavItem(base, true)
      assert.equal(shown.length, base.length + 1)
      const i = shown.findIndex((x) => x.href === "/photos-engins")
      assert.equal(shown[i - 1]?.href, "/chantiers", role)
      assert.deepEqual(shown[i], { label: "Photos engins", href: "/photos-engins", icon: Camera })
      assert.deepEqual(withWorksitePhotosNavItem(shown, true), shown)
    }
  })
  it("sans /chantiers dans la liste ⇒ ajouté en fin ; `visible` non booléen strict ⇒ rien", () => {
    const items = getNavItems("ADMIN").filter((x) => x.href !== "/chantiers")
    const shown = withWorksitePhotosNavItem(items, true)
    assert.equal(shown.at(-1)?.href, "/photos-engins")
    assert.equal(withWorksitePhotosNavItem(items, "true" as unknown as boolean).length, items.length)
  })
  it("Sidebar et MobileNav composent le helper de la même façon, avec la visibilité calculée côté serveur", () => {
    for (const file of ["src/components/layout/Sidebar.tsx", "src/components/layout/MobileNav.tsx"]) {
      const src = read(file)
      assert.match(src, /withWorksitePhotosNavItem\(withSupplierIntakeNavItem\(/, file)
      assert.match(src, /user\.worksitePhotosNavVisible === true/, file)
    }
    const layout = read("src/app/(dashboard)/layout.tsx")
    assert.match(layout, /isWorksitePhotosEnabled\(\) && \["EMPLOYEE", "TEAM_LEADER", "ADMIN", "SUPER_ADMIN"\]\.includes\(role\) && !!companyId/)
  })
})
