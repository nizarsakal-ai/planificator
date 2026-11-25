/**
 * Lot 2a juridique : pages légales publiques, lecteur Markdown, case CGU à l'inscription.
 */
process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test"

import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, it } from "node:test"
import { authorizedCallback } from "@/auth.config"
import { LEGAL_DOCUMENTS, isLegalPublicPath, legalHref } from "@/lib/legal/legal-documents"
import { hasPlaceholders, parseInline, parseLegalMarkdown, stripDraftNote } from "@/lib/legal/legal-markdown"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..")
const req = (pathname: string) => ({ nextUrl: new URL(`http://localhost${pathname}`) })
const user = (role: string) => ({ user: { id: "u1", role, companyId: "c1", email: "u@example.com", name: "U" } })

describe("pages légales : accès", () => {
  for (const doc of LEGAL_DOCUMENTS) {
    it(`${doc.route} est public sans connexion`, () => {
      assert.equal(authorizedCallback({ auth: null, request: req(doc.route) }), true)
    })
    for (const role of ["ADMIN", "EMPLOYEE", "CLIENT", "SUPER_ADMIN"]) {
      it(`${doc.route} reste lisible connecté (${role}), sans redirection`, () => {
        assert.equal(authorizedCallback({ auth: user(role), request: req(doc.route) }), true)
      })
    }
  }
  it("ne rend pas publiques des routes voisines", () => {
    assert.equal(isLegalPublicPath("/cgu-admin"), false)
    assert.equal(isLegalPublicPath("/confidentialite/secret"), false)
    assert.equal(authorizedCallback({ auth: null, request: req("/cgu-admin") }), false)
  })
  it("le tableau de bord reste protégé", () => {
    assert.equal(authorizedCallback({ auth: null, request: req("/dashboard") }), false)
  })
})

describe("lecteur Markdown des textes légaux", () => {
  it("lit titres, listes, tableaux, gras, liens", () => {
    const blocks = parseLegalMarkdown("# Titre\n\nUn **gras** et un [lien](cgu.md).\n\n- a\n- b\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n---", legalHref)
    assert.deepEqual(blocks.map((b) => b.kind), ["heading", "paragraph", "list", "table", "rule"])
    const para = blocks[1]
    assert.equal(para.kind, "paragraph")
    if (para.kind === "paragraph") {
      assert.deepEqual(para.children.find((n) => n.kind === "link"), { kind: "link", href: "/cgu", children: [{ kind: "text", text: "lien" }] })
    }
  })
  it("ne boucle pas sur une ligne « | » isolée", () => {
    assert.equal(parseLegalMarkdown("| seul\n").length, 1)
  })
  it("ne produit jamais de HTML brut", () => {
    const nodes = parseInline("<script>alert(1)</script>")
    assert.deepEqual(nodes, [{ kind: "text", text: "<script>alert(1)</script>" }])
  })
  it("retire la note de brouillon en tête", () => {
    assert.equal(stripDraftNote("# T\n\n*Brouillon du 25/11/2026, à relire.*\n\nTexte"), "# T\n\nTexte")
  })
  it("repère les champs à compléter", () => {
    assert.equal(hasPlaceholders("Siège : [À COMPLÉTER]"), true)
    assert.equal(hasPlaceholders("Texte final"), false)
  })
  for (const doc of LEGAL_DOCUMENTS) {
    it(`${doc.file} se lit sans erreur et ses liens internes visent des routes`, () => {
      const md = readFileSync(join(ROOT, "docs/legal", doc.file), "utf8")
      const blocks = parseLegalMarkdown(stripDraftNote(md), legalHref)
      assert.ok(blocks.length > 5)
      assert.equal(blocks[0].kind, "heading")
      assert.ok(!JSON.stringify(blocks).includes('.md"'), "aucun lien vers un fichier .md")
      assert.ok(!JSON.stringify(blocks).includes("Brouillon du"), "note de brouillon retirée")
    })
  }
})

describe("inscription : acceptation des CGU", () => {
  it("la page d'inscription a une case obligatoire et les liens", () => {
    const src = readFileSync(join(ROOT, "src/app/(auth)/inscription/page.tsx"), "utf8")
    assert.match(src, /name="acceptTerms"[\s\S]*?required/)
    for (const href of ["/cgu", "/accord-sous-traitance", "/confidentialite"]) assert.ok(src.includes(`href="${href}"`))
  })
  it("le serveur refuse sans acceptation, avant toute écriture", async () => {
    const { registerCompany } = await import("@/lib/actions/register.actions")
    const fd = new FormData()
    fd.set("companyName", "Société Test"); fd.set("adminName", "Jean Test")
    fd.set("email", "jean@example.com"); fd.set("password", "motdepasse123")
    const result = await registerCompany(fd)
    assert.deepEqual(result, { error: "Vous devez accepter les conditions générales d'utilisation pour créer votre espace." })
  })
  it("le serveur trace la version acceptée dans la même transaction", () => {
    const src = readFileSync(join(ROOT, "src/lib/actions/register.actions.ts"), "utf8")
    const tx = src.slice(src.indexOf("prisma.$transaction"), src.indexOf("return { success: true }"))
    assert.match(tx, /tx\.historyLog\.create[\s\S]*TERMS_ACCEPTANCE_ENTITY[\s\S]*LEGAL_TERMS_VERSION/)
  })
})
