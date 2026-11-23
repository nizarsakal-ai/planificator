// Préchargement automatique désactivé pour TROIS liens de navigation seulement (décision Nizar, preuves R18c : préchargements
// RSC hors ligne en échec pour /vehicules, puis /reserves et /tableaux-de-bord une fois ces routes servies sans cache par le
// service worker). Vérifie : l'ensemble exact des trois href ; chaque lien de NavCategories (catégories ET pied) reçoit la
// décision ; aucune autre propriété des liens n'est modifiée ; les trois entrées existent bien dans la navigation.
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { describe, it } from "node:test"
import { LIENS_SANS_PRECHARGEMENT } from "@/components/layout/NavCategories"

const SOURCE = readFileSync(new URL("../../src/components/layout/NavCategories.tsx", import.meta.url), "utf8")

describe("navigation : préchargement désactivé pour Véhicules, Réserves et Indicateurs commerciaux seulement", () => {
  it("ensemble exact des trois href (égalité stricte, aucun préfixe)", () => {
    assert.deepEqual([...LIENS_SANS_PRECHARGEMENT].sort(), ["/reserves", "/tableaux-de-bord", "/vehicules"])
    for (const h of ["/vehicules/1", "/reserves/d1-w-a2", "/tableaux-de-bord/x", "/chantiers", "/dashboard", "/stock"])
      assert.equal(LIENS_SANS_PRECHARGEMENT.has(h), false, h)
  })

  it("EntreeLien : seul <Link> de NavCategories, il reçoit la décision ; la navigation native (<a>) n'a pas de préchargement ; les deux liens passent par EntreeLien", () => {
    assert.match(SOURCE, /const prechargement = \(href: string\) => \(LIENS_SANS_PRECHARGEMENT\.has\(href\) \? false : undefined\)/)
    assert.match(SOURCE, /return item\.documentNavigation \? <a href=\{item\.href\} \{\.\.\.props\} \/> : <Link href=\{item\.href\} prefetch=\{prechargement\(item\.href\)\} \{\.\.\.props\} \/>/)
    assert.equal((SOURCE.match(/<Link\b/g) ?? []).length, 1)
    assert.equal((SOURCE.match(/prefetch=/g) ?? []).length, 1)
    const entrees = SOURCE.match(/<EntreeLien\n[\s\S]*?>/g) ?? []
    assert.equal(entrees.length, 2)
    for (const l of entrees) assert.match(l, /^<EntreeLien\n {6}item=\{item\}\n {6}onClick=\{onNavigate\}\n/)
    const config = readFileSync(new URL("../../src/lib/navigation/nav-config.ts", import.meta.url), "utf8")
    for (const href of ["/vehicules", "/reserves", "/tableaux-de-bord"]) assert.doesNotMatch(config, new RegExp(`href: +"${href}",[^}\\n]*documentNavigation`), `${href} : lien next/link, préchargement décidé par EntreeLien`)
  })

  it("les trois entrées existent dans la navigation (libellés inchangés)", () => {
    const config = readFileSync(new URL("../../src/lib/navigation/nav-config.ts", import.meta.url), "utf8")
    assert.match(config, /\{ label: "Véhicules", +href: "\/vehicules",/)
    assert.match(config, /\{ label: "Réserves", href: "\/reserves", icon: ClipboardCheck \}/)
    assert.match(config, /\{ label: "Indicateurs commerciaux", href: "\/tableaux-de-bord", icon: TrendingUp \}/)
  })
})
