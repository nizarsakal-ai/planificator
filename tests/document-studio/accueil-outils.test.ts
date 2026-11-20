/**
 * Lot G Planificator V2 — accueil « par outils » du Document Studio (accueil-v3, 19/11/2026). Contrôles sans base :
 * recherche insensible aux accents, six outils adossés à des sections réelles, vues bornées, file d'attente filtrée côté
 * serveur, composant client sans donnée métier, un seul lien par carte, ancres stables, aucune ressource externe.
 */
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { describe, it } from "node:test"
import { STUDIO_TOOLS, STUDIO_VUES, TOOL_FAMILIES, filtrerOutils, lireVue, normaliser } from "@/lib/document-studio/tool-hub"

const read = (f: string) => readFileSync(f, "utf8")
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n")
const PAGE = "src/app/(dashboard)/studio-documents/page.tsx"
const HUB = "src/components/document-studio/StudioToolHub.tsx"
const ids = (l: readonly { id: string }[]) => l.map((o) => o.id)

describe("recherche d'outils", () => {
  it("normalisation : minuscules, sans accents, espaces réduits", () => {
    assert.equal(normaliser("  Générer   un DOCUMENT "), "generer un document")
    assert.equal(normaliser("Télécharger"), "telecharger")
  })
  it("« generer » (sans accent) trouve « Générer un document » ; majuscules et accents indifférents", () => {
    for (const q of ["generer", "Générer", "GENERER", " générer "]) assert.deepEqual(ids(filtrerOutils(q)), ["generer"], q)
  })
  it("libellés, descriptions et mots-clés concrets ; tous les mots exigés", () => {
    // Espace PDF (lots 1 et 2) : « pdf » trouve aussi l'import et la liste des PDF importés.
    assert.deepEqual(ids(filtrerOutils("pdf")), ["pdf", "importer-pdf", "pdf-importes"])
    assert.deepEqual(ids(filtrerOutils("telecharger pdf")), ["pdf"])
    assert.deepEqual(ids(filtrerOutils("signature")), ["validation", "pdf-importes"])
    assert.deepEqual(ids(filtrerOutils("importer")), ["importer-pdf"])
    assert.deepEqual(ids(filtrerOutils("remplir signer")), ["importer-pdf", "pdf-importes"])
    assert.deepEqual(ids(filtrerOutils("brouillon")), ["nouveau-modele"])
    assert.deepEqual(ids(filtrerOutils("versions")), ["modeles", "pdf-importes"])
    assert.deepEqual(ids(filtrerOutils("pdf signature")), ["pdf-importes"])
    assert.deepEqual(ids(filtrerOutils("telecharger signature")), [])
  })
  it("saisie vide ⇒ les huit outils ; sans résultat ⇒ liste vide", () => {
    assert.equal(filtrerOutils("").length, 8)
    assert.equal(filtrerOutils("   ").length, 8)
    assert.deepEqual(filtrerOutils("photoshop"), [])
  })
})

describe("outils et vues", () => {
  it("quatre groupes de deux outils, dans l'ordre demandé", () => {
    assert.deepEqual(TOOL_FAMILIES.map((f) => f.label), ["Créer et générer", "Retrouver", "Valider et exporter", "Travailler sur un PDF"])
    assert.deepEqual(TOOL_FAMILIES.map((f) => ids(STUDIO_TOOLS.filter((o) => o.family === f.id))), [["nouveau-modele", "generer"], ["modeles", "documents"], ["validation", "pdf"], ["importer-pdf", "pdf-importes"]])
    assert.deepEqual(STUDIO_TOOLS.map((o) => o.title), ["Nouveau modèle", "Générer un document", "Modèles et versions", "Documents générés", "En attente de validation", "Télécharger un PDF", "Importer un PDF", "PDF importés"])
  })
  it("chaque outil pointe une section réelle de l'accueil ou une vue bornée ; aucune adresse externe", () => {
    const sections = ["nouveau-modele", "modeles", "documents", "importer", "fichiers"]
    for (const o of STUDIO_TOOLS) {
      const m = /^\/studio-documents(?:\?vue=(generer|validation|pdf))?#([a-z-]+)$/.exec(o.href)
      assert.ok(m, o.href)
      if (m![1]) assert.equal(m![2], m![1], `${o.href} : ancre de la vue`)
      else assert.ok(sections.includes(m![2]), o.href)
    }
  })
  it("vue : une seule valeur texte de la liste fermée, sinon listes existantes", () => {
    assert.deepEqual([...STUDIO_VUES], ["generer", "validation", "pdf"])
    for (const v of STUDIO_VUES) assert.equal(lireVue(v), v)
    for (const v of [undefined, null, "", "PDF", "generer ", "tout", ["pdf"], ["pdf", "generer"], 1, { vue: "pdf" }]) assert.equal(lireVue(v), null, JSON.stringify(v))
  })
})

describe("écran d'accueil", () => {
  it("garde avant lecture ; vue lue après la garde ; listes complètes toujours rendues ; vues conditionnelles", () => {
    const c = code(read(PAGE))
    const garde = c.indexOf("if (!ctx) return <AdminOnlyNotice />")
    assert.ok(garde > 0 && garde < c.indexOf("const vue = lireVue(params.vue)"))
    for (const a of ["outils", "nouveau-modele", "modeles", "documents", "importer", "fichiers"]) assert.ok(c.includes(`id="${a}"`), a)
    for (const v of ["generer", "validation", "pdf"]) {
      assert.ok(c.includes(`{vue === "${v}" && (`), v)
      assert.ok(c.includes(`<section id="${v}"`), v)
    }
    assert.ok(c.includes(`const publies = vue === "generer" ? await listPublishedTemplates(prisma, ctx.companyId) : []`))
    assert.ok(c.includes(`const enAttente = vue === "validation" ? await listPendingDocuments(prisma, ctx.companyId) : []`))
    assert.ok(c.includes(`const pdfs = vue === "pdf" ? await listPdfDocuments(prisma, ctx.companyId) : []`))
    assert.equal((c.match(/Retour aux listes complètes/g) ?? []).length, 3)
    for (const vide of ["Aucun modèle publié.", "Aucun document en attente de validation.", "Aucun document généré.", "Aucun modèle.", "Aucun document."]) assert.ok(c.includes(vide), vide)
  })
  it("PDF : route protégée existante, proposée seulement si l'empreinte est intacte ; génération vers l'ancre du modèle", () => {
    const c = code(read(PAGE))
    assert.ok(c.includes("<a href={`/studio-documents/documents/${d.id}/pdf`}"))
    assert.ok(c.includes("{d.intact"))
    assert.ok(c.includes("<a href={`/studio-documents/${t.id}#generer`}"))
    assert.ok(code(read("src/app/(dashboard)/studio-documents/[templateId]/page.tsx")).includes(`<h2 id="generer"`))
  })
  it("rail « Accès rapides » : navigation étiquetée, liens textuels internes ; formulaire et listes conservés", () => {
    const c = code(read(PAGE))
    assert.ok(c.includes(`<nav aria-labelledby="acces-rapides-titre"`))
    assert.ok(c.includes("lg:grid-cols-[minmax(0,1fr)_15rem]"), "rail à droite sur grand écran seulement, dans le flux sinon")
    assert.ok(c.includes("<StudioToolHub />"))
    // Deux formulaires : nouveau modèle, et import d'un PDF (espace PDF, lot 1).
    assert.equal((c.match(/<FormulaireRetour /g) ?? []).length, 2)
    assert.ok(c.includes("<FormulaireRetour action={importPdfAction}"))
    assert.ok(c.includes("Nouveau modèle (version 1 en brouillon)") && c.includes("Créer le modèle"))
    assert.doesNotMatch(c, /from "next\/link"|<Link[\s>]|<img|https?:\/\//)
  })
  it("file d'attente et modèles publiés filtrés par société et statut DANS la requête, avant la limite", () => {
    const q = read("src/lib/document-studio/queries.ts")
    assert.ok(q.includes(`where: { companyId, status: "PENDING_APPROVAL" }, orderBy: [{ createdAt: "asc" }, { id: "asc" }], take,`))
    assert.ok(q.includes(`where: { companyId, versions: { some: { status: "PUBLISHED" } } }`))
    const pdf = q.slice(q.indexOf("export async function listPdfDocuments"), q.indexOf("const DOCUMENT_SELECT"))
    assert.ok(pdf.includes("where: { companyId }") && pdf.includes("intact: !!s && documentSha256(s) === snapshotSha256"))
    assert.doesNotMatch(pdf, /signaturePng/)
  })
})

describe("composant client de recherche", () => {
  it("aucune donnée métier ni accès serveur ; cartes statiques ; un seul lien par carte", () => {
    const h = read(HUB)
    const c = code(h)
    assert.match(h, /^"use client"/)
    assert.doesNotMatch(c, /@\/lib\/prisma|@\/lib\/actions|document-studio\/(?:queries|access|studio\.service)|fetch\(|next\/link|<img|https?:\/\//)
    assert.ok(c.includes("filtrerOutils(saisie, STUDIO_TOOLS)"))
    assert.equal((c.match(/<a[\s>]/g) ?? []).length, 1, "un seul lien par carte (gabarit unique)")
    assert.ok(c.includes(`<label htmlFor={\`\${id}-recherche\`} className="sr-only">Rechercher un outil</label>`))
    assert.ok(c.includes(`placeholder="Rechercher un outil"`))
    assert.ok(c.includes("Effacer la recherche") && c.includes('aria-live="polite"'))
    assert.ok(c.includes("focus-visible:ring-2"), "focus visible")
    assert.doesNotMatch(c, /(?<!motion-safe:)(?:transition-transform|animate-)/, "mouvement seulement si non réduit")
  })
})
