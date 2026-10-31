/**
 * Navigation par catégories — rendu statique de la Sidebar, du MobileNav et des catégories (doubles de next/navigation et
 * next-auth/react ; données fictives). Exécution : `node --import tsx --experimental-test-module-mocks --test <fichier>`.
 */
import assert from "node:assert/strict"
import { before, describe, it, mock } from "node:test"
import React, { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import type { Role } from "@prisma/client"

;(globalThis as { React?: typeof React }).React = React

let pathname = "/photos-engins"
type Shell = (props: { user: Record<string, unknown> }) => React.ReactElement
let Sidebar: Shell
let MobileNav: Shell

before(async () => {
  mock.module("next/navigation", { namedExports: { usePathname: () => pathname } })
  mock.module("next-auth/react", { namedExports: { signOut: async () => undefined } })
  ;({ Sidebar } = (await import("@/components/layout/Sidebar")) as unknown as { Sidebar: Shell })
  ;({ MobileNav } = (await import("@/components/layout/MobileNav")) as unknown as { MobileNav: Shell })
})

const user = (role: Role, flags: Partial<Record<"accountingNavVisible" | "billingNavVisible" | "supplierIntakeNavVisible" | "worksitePhotosNavVisible", boolean>> = {}) =>
  ({ id: "u1", name: "Utilisateur Test", email: "test@example.test", image: null, role, companyId: "c1", ...flags })
const render = (shell: Shell, u: Record<string, unknown>) => renderToStaticMarkup(createElement(shell, { user: u }))
/** Href des liens marqués aria-current="page" (indépendant de l'ordre des attributs). */
const activeLinks = (html: string) => [...html.matchAll(/<a [^>]*>/g)].map((m) => m[0]).filter((a) => a.includes('aria-current="page"')).map((a) => /href="([^"]+)"/.exec(a)![1])
/** Blocs de catégorie : [libellé, aria-expanded, id contrôlé]. */
function headers(html: string): Array<[string, string, string]> {
  return [...html.matchAll(/<button type="button" aria-expanded="(true|false)" aria-controls="([^"]+)"[^>]*>.*?<span class="flex-1 text-left">([^<]+)<\/span>/g)].map((m) => [m[3], m[1], m[2]])
}

describe("Sidebar", () => {
  it("SUPER_ADMIN sur /photos-engins : 7 catégories dans l'ordre, seule « Chantiers & terrain » ouverte, lien actif aria-current", () => {
    pathname = "/photos-engins"
    const html = render(Sidebar, user("SUPER_ADMIN", { billingNavVisible: true, supplierIntakeNavVisible: true, worksitePhotosNavVisible: true }))
    const h = headers(html)
    assert.deepEqual(h.map(([label]) => label), ["Pilotage", "Chantiers &amp; terrain", "Planning", "Équipes &amp; RH", "Commercial", "Finance", "Administration"])
    assert.deepEqual(h.map(([, expanded]) => expanded), ["false", "true", "false", "false", "false", "false", "false"])
    for (const [, expanded, id] of h) assert.match(html, new RegExp(`<ul id="${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"${expanded === "true" ? "" : " hidden=\"\""}`), `liste contrôlée ${id}`)
    assert.deepEqual(activeLinks(html), ["/photos-engins"], "un seul lien actif")
    assert.match(html, /href="\/factures-fournisseurs"/, "entrée fournisseurs existante conservée (Finance)")
    assert.match(html, /aria-label="Menu principal"/)
  })
  it("pied : identité, « Mon profil » (même lien) et Déconnexion ; profil actif sur /profil sans catégorie ouverte", () => {
    pathname = "/profil"
    const html = render(Sidebar, user("ADMIN"))
    assert.match(html, /Utilisateur Test/)
    assert.match(html, /Administrateur/)
    assert.deepEqual(activeLinks(html), ["/profil"])
    assert.match(html, /Déconnexion/)
    assert.ok(headers(html).every(([, expanded]) => expanded === "false"))
  })
  it("drapeaux absents : aucun lien masqué rendu (Comptabilité, Devis, Fournisseurs, Photos)", () => {
    pathname = "/dashboard"
    const html = render(Sidebar, user("ADMIN"))
    for (const href of ["/comptabilite", "/devis", "/factures-fournisseurs", "/photos-engins"]) assert.equal(html.includes(`href="${href}"`), false, href)
  })
})

describe("MobileNav", () => {
  it("EMPLOYEE : mêmes catégories, Photos engins présent si le serveur le rend visible ; tiroir fermé inert et aria-hidden", () => {
    pathname = "/chantiers/42"
    const html = render(MobileNav, user("EMPLOYEE", { worksitePhotosNavVisible: true }))
    assert.deepEqual(headers(html).map(([label, expanded]) => [label, expanded]), [["Pilotage", "false"], ["Chantiers &amp; terrain", "true"], ["Planning", "false"], ["Équipes &amp; RH", "false"]])
    assert.match(html, /href="\/photos-engins"/)
    assert.deepEqual(activeLinks(html), ["/chantiers"], "route de détail : parent actif")
    assert.match(html, /aria-label="Ouvrir le menu" aria-expanded="false"/)
    assert.match(html, /role="dialog" aria-label="Menu de navigation" aria-hidden="true" inert=""/)
    assert.equal(/aria-modal/.test(html), false, "aria-modal seulement quand le tiroir est ouvert")
    assert.match(html, /aria-label="Fermer le menu"/)
  })
  it("identifiants des listes distincts entre Sidebar et MobileNav (useId par instance)", () => {
    pathname = "/planning"
    const ids = (html: string) => headers(html).map(([, , id]) => id)
    const both = renderToStaticMarkup(createElement("div", null, createElement(Sidebar, { user: user("ADMIN") }), createElement(MobileNav, { user: user("ADMIN") })))
    const all = ids(both)
    assert.equal(new Set(all).size, all.length)
  })
})
