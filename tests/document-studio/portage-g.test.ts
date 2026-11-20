/**
 * Lot G Planificator V2 — portage sur ef36578f (19/11/2026) : contrôles sans base.
 * - Aucune dépendance aux lots D (réserves) ni à la planification : primitive canonique et signature LOCALES au lot G.
 * - Signature : URL de données PNG stricte, octets bornés, signature binaire, empreinte des octets.
 * - Retour explicite E4 : liste blanche exacte des adresses G (cibles calculées côté serveur), fiches CRM inchangées.
 * - Écrans : garde avant lecture, ZoneRetour/MessageRetour/FormulaireRetour, liens HTML natifs, aucune image de signature
 *   dans les propriétés de page.
 */
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { readFileSync, readdirSync } from "node:fs"
import { describe, it } from "node:test"
import { canonicalJson, sha256Hex } from "@/lib/document-studio/canonical"
import { STUDIO_SIGNATURE_ERROR, STUDIO_SIGNATURE_MAX_BYTES, STUDIO_SIGNATURE_MIN_BYTES, parseStudioSignature } from "@/lib/document-studio/signature"
import { adresseApresSucces, retour, RETOUR_INITIAL } from "@/lib/actions/retour-action"

const read = (f: string) => readFileSync(f, "utf8")
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n")
const PAGES = ["src/app/(dashboard)/studio-documents/page.tsx", "src/app/(dashboard)/studio-documents/[templateId]/page.tsx", "src/app/(dashboard)/studio-documents/documents/[id]/page.tsx"]
const G_FILES = [
  ...readdirSync("src/lib/document-studio").map((f) => `src/lib/document-studio/${f}`),
  ...readdirSync("src/components/document-studio").map((f) => `src/components/document-studio/${f}`),
  "src/lib/actions/document-studio.actions.ts", ...PAGES, "src/app/(dashboard)/studio-documents/documents/[id]/pdf/route.tsx",
]
const png = (n: number) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(n - 8, 7)])
const url = (b: Buffer) => `data:image/png;base64,${b.toString("base64")}`

describe("dépendances du lot G", () => {
  it("aucun import des lots D (réserves) ni du pavé de signature de la planification", () => {
    for (const f of G_FILES) assert.doesNotMatch(code(read(f)), /from "@\/(?:lib\/reserves|components\/reserves|components\/planning|lib\/actions\/signature\.actions)/, f)
  })
  it("primitive canonique locale : clés triées, entiers sûrs seulement, undefined refusé ; empreinte SHA-256", () => {
    assert.equal(canonicalJson({ b: 1, a: [true, null, "é"], c: { z: "x", y: 2 } }), `{"a":[true,null,"é"],"b":1,"c":{"y":2,"z":"x"}}`)
    assert.throws(() => canonicalJson({ a: 1.5 }), RangeError)
    assert.throws(() => canonicalJson({ a: undefined }), TypeError)
    assert.throws(() => canonicalJson(Number.MAX_SAFE_INTEGER + 1), RangeError)
    assert.equal(sha256Hex("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
    assert.equal(sha256Hex(Buffer.from("abc")), sha256Hex("abc"))
  })
})

describe("signature du valideur (analyseur local, règles v6)", () => {
  it("PNG valide dans les bornes : octets et empreinte des octets", () => {
    for (const n of [STUDIO_SIGNATURE_MIN_BYTES, 208, STUDIO_SIGNATURE_MAX_BYTES]) {
      const b = png(n)
      const r = parseStudioSignature(`  ${url(b)}\n`)
      assert.ok(r.ok, String(n))
      if (!r.ok) continue
      assert.ok(r.value.png.equals(b))
      assert.equal(r.value.sha256, createHash("sha256").update(b).digest("hex"))
    }
  })
  it("refus : absente, hors bornes, pas un PNG, autre type, base64 invalide, préfixe ou suffixe", () => {
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(300, 1)])
    for (const bad of [
      null, undefined, "", "   ", url(png(STUDIO_SIGNATURE_MIN_BYTES - 1)), url(png(STUDIO_SIGNATURE_MAX_BYTES + 1)), url(Buffer.alloc(300, 1)),
      `data:image/jpeg;base64,${jpeg.toString("base64")}`, `data:image/png;base64,${"!".repeat(400)}`, `x${url(png(200))}`, `${url(png(200))}x`,
      `data:image/svg+xml;base64,${Buffer.from("<svg/>").toString("base64")}`, "data:image/png;base64,AAAA",
    ]) assert.deepEqual(parseStudioSignature(bad), { ok: false, error: STUDIO_SIGNATURE_ERROR }, String(bad).slice(0, 40))
  })
})

describe("retour explicite : adresses G", () => {
  it("cibles G admises (fiche du modèle créé, document généré) ; message encodé", () => {
    assert.equal(adresseApresSucces(retour(true, "Modèle créé : version 1 en brouillon.", "/studio-documents/tpl_1"), "/studio-documents"), "/studio-documents/tpl_1?ok=Mod%C3%A8le+cr%C3%A9%C3%A9+%3A+version+1+en+brouillon.")
    assert.equal(adresseApresSucces(retour(true, "Document DOC-2026-0001 émis.", "/studio-documents/documents/d-1"), "/studio-documents/tpl_1"), "/studio-documents/documents/d-1?ok=Document+DOC-2026-0001+%C3%A9mis.")
  })
  it("pages G rouvertes après une action sans cible : liste, modèle, document", () => {
    for (const p of ["/studio-documents", "/studio-documents/tpl_1", "/studio-documents/documents/d-1"]) assert.equal(adresseApresSucces(retour(true, "x"), p), `${p}?ok=x`, p)
  })
  it("cibles hors liste refusées : liste comme cible, « documents » nu, PDF, profondeur, longueur, encodage, schéma", () => {
    for (const c of [
      "/studio-documents", "/studio-documents/", "/studio-documents/documents", "/studio-documents/documents/", "/studio-documents/documents/d1/pdf",
      "/studio-documents/a/b", `/studio-documents/${"a".repeat(65)}`, `/studio-documents/documents/${"a".repeat(65)}`, "/studio-documents/a%2Fb",
      "/studio-documents/../admin", "/studio-documents/a?x=1", "//evil.example/studio-documents/a", "https://evil.example/studio-documents/a", "/Studio-documents/a",
    ]) assert.equal(adresseApresSucces(retour(true, "x", c), "/studio-documents"), null, c)
  })
  it("pages courantes hors liste refusées ; erreur et état initial sans navigation", () => {
    for (const p of ["/studio-documents/", "/studio-documents/documents", "/studio-documents/documents/d1/pdf", "/studio-documents/a/b", "/studio-documentsx", "//studio-documents"]) {
      assert.equal(adresseApresSucces(retour(true, "x"), p), null, p)
    }
    assert.equal(adresseApresSucces(retour(false, "Cochez la confirmation de publication."), "/studio-documents/t1"), null)
    assert.equal(adresseApresSucces(RETOUR_INITIAL, "/studio-documents"), null)
  })
  it("comportement E inchangé : fiches CRM et pages E ; /dashboard refusé", () => {
    assert.equal(adresseApresSucces(retour(true, "x", "/crm/opportunites/c1"), "/crm/opportunites"), "/crm/opportunites/c1?ok=x")
    for (const p of ["/crm/opportunites", "/crm/opportunites/abc", "/automatisations"]) assert.equal(adresseApresSucces(retour(true, "x"), p), `${p}?ok=x`, p)
    assert.equal(adresseApresSucces(retour(true, "x", "/crm/opportunites"), "/crm/opportunites"), null)
    assert.equal(adresseApresSucces(retour(true, "x"), "/dashboard"), null)
  })
  it("source : liste FICHE du CRM et pages E inchangées ; listes G distinctes", () => {
    const src = read("src/lib/actions/retour-action.ts")
    assert.ok(src.includes("const FICHE = /^\\/crm\\/opportunites\\/[A-Za-z0-9_-]{1,64}$/"))
    assert.ok(src.includes("const PAGES_LOT_E = /^\\/(?:crm\\/opportunites(?:\\/[A-Za-z0-9_-]{1,64})?|automatisations)$/"))
    assert.ok(src.includes("const FICHES_LOT_G = "))
    assert.ok(src.includes("const PAGES_LOT_G = "))
  })
})

describe("actions G : retour par état", () => {
  it("signature compatible useActionState ; seule redirection : /login ; cibles calculées côté serveur", () => {
    const a = read("src/lib/actions/document-studio.actions.ts")
    const c = code(a)
    assert.match(a, /^"use server"/)
    assert.doesNotMatch(c, /revalidatePath|from "next\/cache"/)
    assert.equal((c.match(/redirect\(/g) ?? []).length, 1)
    assert.ok(c.includes(`if (e instanceof StudioAccessError && e.reason === "UNAUTHENTICATED") redirect("/login")`))
    for (const n of ["createTemplateAction", "updateDraftAction", "createDraftAction", "publishVersionAction", "generateDocumentAction", "approveDocumentAction", "rejectDocumentAction", "importPdfAction", "fillSignPdfAction", "organizePdfAction", "extractPagesAction", "combinePdfsAction"]) {
      assert.match(c, new RegExp(`export async function ${n}\\(a: RetourAction \\| FormData, b\\?: FormData\\) \\{\\n  const form = formulaireDe\\(a, b\\)\\n  return run\\(`), n)
    }
    assert.ok(c.includes("cible: ficheModele(r.value.templateId)"), "cible du modèle issue du service")
    assert.ok(c.includes("cible: ficheDocument(r.value.id)"), "cible du document issue du service")
    // Espace PDF (lots 1 et 2) : l'import et l'enregistrement d'une version ouvrent la fiche du PDF (identifiant issu du service).
    assert.ok(c.includes("cible: fichePdf(r.value.pdfId)") && c.includes("cible: fichePdf(pdfId)"), "cible de la fiche PDF")
    // Lot 3 : organiser (fiche du PDF), extraire et combiner (fiche du NOUVEAU PDF, identifiant issu du service).
    assert.equal((c.match(/cible: /g) ?? []).length, 7, "modèle, génération, import, remplir, organiser, extraire, combiner")
    assert.ok(c.includes(`if (str(form, "confirm", 5) !== "oui") return { ok: false, error: "Cochez la confirmation de publication." }`))
    assert.ok(c.includes(`if (str(form, "confirm", 5) !== "oui") return { ok: false, error: "Cochez la confirmation de validation." }`))
    assert.ok(c.includes("await requireStudioAdmin()"))
  })
})

describe("écrans G", () => {
  it("ZoneRetour, MessageRetour et FormulaireRetour ; aucun <form> brut ; garde avant la zone", () => {
    const attendus: Record<string, string[]> = {
      [PAGES[0]]: ["createTemplateAction", "importPdfAction"],
      [PAGES[1]]: ["createDraftAction", "updateDraftAction", "publishVersionAction", "generateDocumentAction"],
      [PAGES[2]]: ["approveDocumentAction", "rejectDocumentAction"],
    }
    for (const f of PAGES) {
      const c = code(read(f))
      assert.ok(c.includes(`import { FormulaireRetour, MessageRetour, ZoneRetour } from "@/components/crm/RetourFormulaire"`), f)
      assert.ok(c.includes("<ZoneRetour rendu={Date.now()}>") && c.includes("</ZoneRetour>"), f)
      assert.match(c, /<MessageRetour><StockFlash params=\{(?:params|sp)\} \/><\/MessageRetour>/, f)
      assert.doesNotMatch(c, /<form[\s>]/, `${f} : aucun formulaire hors retour explicite`)
      for (const n of attendus[f]) assert.ok(c.includes(`<FormulaireRetour action={${n}}`), `${f} ${n}`)
      assert.equal((c.match(/<FormulaireRetour /g) ?? []).length, attendus[f].length, f)
      assert.ok(c.indexOf("if (!ctx) return <AdminOnlyNotice />") < c.indexOf("<ZoneRetour"), f)
    }
  })
  it("liens entre écrans et vers le PDF : HTML natifs ; aucune transition next/link", () => {
    for (const f of PAGES) assert.doesNotMatch(code(read(f)), /from "next\/link"|<Link[\s>]/, f)
    const liste = code(read(PAGES[0]))
    assert.ok(liste.includes("<a href={`/studio-documents/${t.id}`}"))
    assert.ok(liste.includes("<a href={`/studio-documents/documents/${d.id}`}"))
    assert.ok(code(read(PAGES[1])).includes(`<a href="/studio-documents" className="text-xs text-[#0f3460] underline">← Document Studio</a>`))
    const doc = code(read(PAGES[2]))
    assert.ok(doc.includes("<a href={`/studio-documents/${d.version.templateId}`}"))
    assert.ok(doc.includes("<a href={`/studio-documents/documents/${d.id}/pdf`}"))
  })
  it("aucune image de signature dans les propriétés de page : l'écran lit la vue sans octets ; seule la route PDF les lit", () => {
    const q = read("src/lib/document-studio/queries.ts")
    const view = q.slice(q.indexOf("export async function getGeneratedDocumentView"), q.indexOf("export async function getGeneratedDocument("))
    assert.ok(view.length > 0)
    assert.doesNotMatch(view, /signaturePng/)
    assert.doesNotMatch(q.slice(q.indexOf("const DOCUMENT_SELECT"), q.indexOf("\n", q.indexOf("const DOCUMENT_SELECT"))), /signaturePng/)
    for (const f of PAGES) assert.doesNotMatch(code(read(f)), /signaturePng|getGeneratedDocument\(|toDataURL|base64/, f)
    assert.ok(code(read(PAGES[2])).includes("getGeneratedDocumentView(prisma, ctx.companyId, id)"))
    assert.ok(read("src/app/(dashboard)/studio-documents/documents/[id]/pdf/route.tsx").includes("getGeneratedDocument(prisma, access.context.companyId, id)"))
    assert.ok(code(read(PAGES[2])).includes(`<StudioSignatureField label="Signature du valideur" />`))
  })
})
