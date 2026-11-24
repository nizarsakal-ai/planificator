/**
 * Lot G2 Planificator V2 : Document Studio « plus puissant » — contrôles sans base.
 * - Compatibilité : champs d'origine et corps sans syntaxe nouvelle inchangés (formes et empreintes).
 * - Champs : liste de choix, case à cocher, aide, valeur par défaut ; champs système étendus.
 * - Mise en forme : sous-titres, gras, listes, tableaux, sauts de page ; une valeur saisie n'est jamais réinterprétée.
 * - Aides pures : préremplissage, nom de copie, clé proposée, recherche bornée, modèles de départ.
 * - PDF : rendu réel avec tous les types de blocs ; module de règles utilisable dans le navigateur.
 */
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { describe, it } from "node:test"
import React from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { renderToBuffer } from "@react-pdf/renderer"
import { extractText, getDocumentProxy } from "unpdf"
import {
  MAX_TABLE_COLUMNS, PAGE_BREAK, STUDIO_ERRORS, SYSTEM_FIELDS, SYSTEM_FIELD_LABEL, centsToInput, copyName, documentSha256, euroInputToCents, fieldLines, filler,
  formatEuroText, initialInputValues, isSnapshotLogo, keyFromLabel, parseFieldLines, parseFieldsJson, readFields, readSnapshot, renderBlocks, renderDocument, sampleSystem, sampleValues,
  validateTemplateIdentity, validateValues, validateVersionContent, versionSha256, type FieldDef,
} from "@/lib/document-studio/studio.core"
import { canonicalJson, sha256Hex } from "@/lib/document-studio/canonical"
import { STARTERS, lireDepart } from "@/lib/document-studio/starters"
import { lireRecherche } from "@/lib/document-studio/tool-hub"
import { GeneratedDocumentPdf, issuerLine } from "@/lib/document-studio/document-pdf"
import { formatEuro, parseEuroInputToCents } from "@/lib/billing/money"
import { StudioTemplateEditor } from "@/components/document-studio/StudioTemplateEditor"
import { StudioBlocks } from "@/components/document-studio/StudioBlocks"

// tsconfig "jsx": "preserve" → sous tsx, le JSX est compilé en React.createElement (runtime classique) — convention du dépôt.
;(globalThis as { React?: typeof React }).React = React

const read = (f: string) => readFileSync(f, "utf8")
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n")
const SYS = { entreprise: "BTP Exemple", numero: "DOC-2026-0001", date_document: "2026-11-04", client: "Durand", chantier: "Maison A" }
const META = { templateName: "Modèle", version: 1, versionSha256: "a".repeat(64) }
const plain = (t: string) => t

describe("compatibilité avec le lot G", () => {
  it("un champ d'origine garde exactement ses quatre propriétés ; empreinte de version = forme canonique d'origine", () => {
    const fields: FieldDef[] = [{ key: "nature", label: "Nature", type: "TEXT", required: true }]
    assert.deepEqual(readFields(JSON.parse(JSON.stringify(fields))), fields)
    assert.deepEqual(Object.keys(readFields([{ ...fields[0], help: "  ", defaultValue: "", options: null }])![0]).sort(), ["key", "label", "required", "type"])
    const c = { title: "Titre {{nature}}", body: "# A\n{{nature}}", fields, requiresApproval: false }
    assert.equal(versionSha256(c), sha256Hex(canonicalJson({ title: c.title, body: c.body, fields: [{ key: "nature", label: "Nature", type: "TEXT", required: true }], requiresApproval: false })))
  })
  it("un corps sans syntaxe nouvelle donne les mêmes blocs (kind, text) et aucun émetteur sans coordonnées", () => {
    const s = renderDocument({ title: "T {{numero}}", body: "# Objet\nLigne 1\nLigne 2 {{client}}\n\nSuite.", fields: [], requiresApproval: false }, {}, SYS, META)
    assert.deepEqual(s.blocks, [{ kind: "heading", text: "Objet" }, { kind: "paragraph", text: "Ligne 1\nLigne 2 Durand" }, { kind: "paragraph", text: "Suite." }])
    assert.equal("issuer" in s, false)
    assert.deepEqual(Object.keys(s).sort(), ["blocks", "company", "issuedOn", "links", "number", "template", "title"])
  })
  it("montants : mêmes résultats que la facturation (saisie et affichage)", () => {
    for (const v of ["0", "1", "1 234,5", "1234.56", "0,07", "99999999,99", " 12 "]) assert.equal(euroInputToCents(v), parseEuroInputToCents(v), v)
    for (const bad of ["-5", "1,234", "abc", "100000000"]) { assert.throws(() => euroInputToCents(bad), Error, bad); assert.throws(() => parseEuroInputToCents(bad), Error, bad) }
    for (const c of ["0", "7", "123450", "100000000", "999999999999"]) assert.equal(formatEuroText(BigInt(c)), formatEuro(BigInt(c)).replace(/[   ]/g, " "), c)
    assert.equal(centsToInput("123450"), "1234,50")
    assert.equal(euroInputToCents(centsToInput("123407")).toString(), "123407")
  })
})

describe("champs enrichis", () => {
  const CHOIX: FieldDef = { key: "decision", label: "Décision", type: "CHOICE", required: true, options: ["sans réserve", "avec réserves"] }
  const CASE: FieldDef = { key: "accord", label: "Accord", type: "CHECKBOX", required: false }
  it("liste de choix : 2 à 20 valeurs distinctes, réservées à ce type ; aide et valeur par défaut contrôlées", () => {
    assert.deepEqual(readFields([{ ...CHOIX, options: [" sans réserve ", "avec réserves"], help: " Choisir ", defaultValue: "avec réserves" }]), [{ ...CHOIX, help: "Choisir", defaultValue: "avec réserves" }])
    for (const bad of [
      [{ ...CHOIX, options: ["seul"] }], [{ ...CHOIX, options: ["a", "a"] }], [{ ...CHOIX, options: undefined }], [{ ...CHOIX, options: ["a", 2] }], [{ ...CHOIX, options: Array.from({ length: 21 }, (_, i) => `c${i}`) }],
      [{ ...CHOIX, defaultValue: "autre" }], [{ key: "n", label: "Nombre", type: "NUMBER", required: false, defaultValue: "1,5" }], [{ key: "d", label: "Date", type: "DATE", required: false, defaultValue: "2026-02-30" }],
      [{ key: "t", label: "Texte", type: "TEXT", required: false, options: ["a", "b"] }], [{ key: "t", label: "Texte", type: "TEXT", required: false, help: "x".repeat(201) }], [{ key: "t", label: "Texte", type: "TEXT", required: false, help: 3 }],
    ]) assert.equal(readFields(bad), null, JSON.stringify(bad).slice(0, 70))
    assert.deepEqual(parseFieldLines(fieldLines([CHOIX, CASE])), [CHOIX, CASE])
    assert.deepEqual(parseFieldsJson(JSON.stringify([CHOIX, CASE])), [CHOIX, CASE])
    for (const bad of ["", "{", "{}", "null", JSON.stringify([{ ...CHOIX, key: "Décision" }])]) assert.equal(parseFieldsJson(bad), null, bad)
  })
  it("valeurs : choix hors liste refusé ; case toujours « oui » ou « non » ; case obligatoire = à cocher", () => {
    assert.deepEqual(validateValues([CHOIX, CASE], { decision: "avec réserves" }), { ok: true, value: { decision: "avec réserves", accord: "non" } })
    assert.deepEqual(validateValues([CHOIX, CASE], { decision: "avec réserves", accord: "oui" }), { ok: true, value: { decision: "avec réserves", accord: "oui" } })
    assert.deepEqual(validateValues([CHOIX, CASE], { decision: "autre" }), { ok: false, error: STUDIO_ERRORS.invalidValue("Décision") })
    assert.deepEqual(validateValues([CHOIX, CASE], { decision: "sans réserve", accord: "peut-être" }), { ok: false, error: STUDIO_ERRORS.invalidValue("Accord") })
    assert.deepEqual(validateValues([CHOIX, { ...CASE, required: true }], {}), { ok: false, error: STUDIO_ERRORS.missing(["Décision", "Accord"]) })
    assert.deepEqual(validateValues([{ ...CASE, required: true }], { accord: "on" }), { ok: true, value: { accord: "oui" } })
    const s = renderDocument({ title: "PV {{numero}}", body: "{{decision}} / {{accord}}", fields: [CHOIX, CASE], requiresApproval: false }, { decision: "sans réserve", accord: "non" }, SYS, META)
    assert.equal(s.blocks[0].text, "sans réserve / Non")
  })
  it("préremplissage : valeur précédente si elle convient encore, sinon valeur par défaut ; montant remis en saisie", () => {
    const fields: FieldDef[] = [
      { key: "nature", label: "Nature", type: "TEXT", required: true, defaultValue: "peinture" }, { key: "montant", label: "Montant", type: "AMOUNT", required: true },
      { ...CHOIX, defaultValue: "sans réserve" }, CASE, { key: "fin", label: "Fin", type: "DATE", required: false },
    ]
    assert.deepEqual(initialInputValues(fields), { nature: "peinture", montant: "", decision: "sans réserve", accord: "", fin: "" })
    assert.deepEqual(initialInputValues(fields, { nature: "carrelage", montant: "123450", decision: "supprimé", accord: "oui", fin: "2026-11-03", intrus: "x" }), { nature: "carrelage", montant: "1234,50", decision: "sans réserve", accord: "oui", fin: "2026-11-03" })
    assert.deepEqual(initialInputValues(fields, { nature: 12, montant: null, fin: "pas une date" } as Record<string, unknown>), { nature: "peinture", montant: "", decision: "sans réserve", accord: "", fin: "" })
    const again = validateValues(fields, initialInputValues(fields, { nature: "carrelage", montant: "123450", decision: "avec réserves", accord: "oui", fin: "2026-11-03" }))
    assert.deepEqual(again, { ok: true, value: { nature: "carrelage", montant: "123450", decision: "avec réserves", accord: "oui", fin: "2026-11-03" } })
  })
  it("champs système étendus : libellés complets, valeurs absentes vides, dates en clair, émetteur figé", () => {
    assert.deepEqual(Object.keys(SYSTEM_FIELD_LABEL).sort(), [...SYSTEM_FIELDS].sort())
    assert.equal(validateVersionContent({ title: "Titre", body: SYSTEM_FIELDS.map((k) => `{{${k}}}`).join(" "), fields: [], requiresApproval: false }).ok, true)
    const sys = { ...SYS, entreprise_adresse: " 1 rue A ", entreprise_siret: "12345678900012", entreprise_telephone: null, client_adresse: "2 rue B", chantier_debut: "2026-11-02", chantier_fin: "pas une date" }
    const s = renderDocument({ title: "Titre", body: "{{entreprise_adresse}}|{{entreprise_telephone}}|{{client_adresse}}|{{client_siret}}|{{chantier_debut}}|{{chantier_fin}}", fields: [], requiresApproval: false }, {}, sys, META)
    assert.equal(s.blocks[0].text, "1 rue A||2 rue B||2 novembre 2026|")
    assert.deepEqual(s.issuer, { address: "1 rue A", siret: "12345678900012" })
    assert.equal(issuerLine(s), "BTP Exemple — 1 rue A — SIRET 12345678900012")
    assert.equal(issuerLine({ company: "BTP Exemple" }), null)
    assert.deepEqual(readSnapshot(JSON.parse(JSON.stringify(s))), s)
    assert.match(documentSha256(s), /^[0-9a-f]{64}$/)
  })
})

describe("mise en forme du corps", () => {
  const BODY = [
    "# Titre", "## Sous-titre", "Texte **en gras** et {{nature}}.",
    "- un\n- **deux** {{nature}}\n- {{vide}}", "1. premier\n3) troisième",
    "| Désignation | Montant |\n|---|---|\n| {{nature}} | {{montant}} |\n| seul |", PAGE_BREAK, "Fin.",
  ].join("\n\n")
  const FIELDS: FieldDef[] = [{ key: "nature", label: "Nature", type: "TEXT", required: true }, { key: "montant", label: "Montant", type: "AMOUNT", required: true }, { key: "vide", label: "Vide", type: "TEXT", required: false }]
  it("sous-titre, gras, listes (numéro saisi conservé), tableau complété, saut de page", () => {
    const s = renderDocument({ title: "Titre", body: BODY, fields: FIELDS, requiresApproval: false }, { nature: "peinture", montant: "123450" }, SYS, META)
    assert.deepEqual(s.blocks, [
      { kind: "heading", text: "Titre" },
      { kind: "subheading", text: "Sous-titre" },
      { kind: "paragraph", text: "Texte en gras et peinture.", runs: [{ text: "Texte " }, { text: "en gras", bold: true }, { text: " et peinture." }] },
      { kind: "list", text: "• un\n• deux peinture", ordered: false, items: [{ text: "un" }, { text: "deux peinture", runs: [{ text: "deux", bold: true }, { text: " peinture" }] }] },
      { kind: "list", text: "1. premier\n3) troisième", ordered: true, items: [{ marker: "1.", text: "premier" }, { marker: "3)", text: "troisième" }] },
      { kind: "table", text: "Désignation | Montant\npeinture | 1 234,50 €\nseul | ", rows: [["Désignation", "Montant"], ["peinture", "1 234,50 €"], ["seul", ""]] },
      { kind: "pagebreak", text: "" },
      { kind: "paragraph", text: "Fin." },
    ])
    assert.deepEqual(readSnapshot(JSON.parse(JSON.stringify(s))), s)
    assert.equal(documentSha256(s), documentSha256(renderDocument({ title: "Titre", body: BODY, fields: FIELDS, requiresApproval: false }, { nature: "peinture", montant: "123450" }, SYS, META)))
  })
  it("une valeur saisie n'est jamais réinterprétée : ni gras, ni liste, ni tableau, ni champ, ni saut de page", () => {
    const piege = "**x** | a | {{client}}\n- item\n[saut de page]"
    const s = renderDocument({ title: "Titre", body: "Avant {{note}} après.\n\n- {{note}}\n\n| {{note}} | b |", fields: [{ key: "note", label: "Note", type: "LONG_TEXT", required: true }], requiresApproval: false }, { note: piege }, SYS, META)
    assert.deepEqual(s.blocks.map((b) => b.kind), ["paragraph", "list", "table"])
    assert.equal(s.blocks[0].text, `Avant ${piege} après.`)
    assert.equal(s.blocks[0].runs, undefined)
    assert.deepEqual(s.blocks[1].items, [{ text: piege }])
    assert.deepEqual(s.blocks[2].rows, [[piege, "b"]])
  })
  it("blocs vides omis ; listes mêlées séparées ; tableau trop large refusé à la validation", () => {
    assert.deepEqual(renderBlocks("- \n\n**  **\n\n# \n\n|---|---|", plain), [])
    assert.deepEqual(renderBlocks("- a\n1. b\n- c", plain).map((b) => [b.kind, b.ordered, b.items?.length]), [["list", false, 1], ["list", true, 1], ["list", false, 1]])
    assert.deepEqual(renderBlocks("texte\n- a\nsuite", plain).map((b) => b.kind), ["paragraph", "list", "paragraph"])
    const large = `| ${Array.from({ length: MAX_TABLE_COLUMNS + 1 }, (_, i) => `c${i}`).join(" | ")} |`
    assert.deepEqual(validateVersionContent({ title: "Titre", body: large, fields: [], requiresApproval: false }), { ok: false, error: STUDIO_ERRORS.table })
    assert.equal(validateVersionContent({ title: "Titre", body: large.replace(" | c8", ""), fields: [], requiresApproval: false }).ok, true)
  })
  it("relecture prudente des instantanés : formes de blocs inattendues refusées", () => {
    const base = renderDocument({ title: "Titre", body: "x", fields: [], requiresApproval: false }, {}, SYS, META)
    for (const blocks of [
      [{ kind: "list", text: "" }], [{ kind: "table", text: "" }], [{ kind: "table", text: "", rows: [["a", 1]] }], [{ kind: "list", text: "", items: [{ text: 1 }] }], [{ kind: "paragraph", text: "a", runs: [{ text: "a", bold: "oui" }] }],
      [{ kind: "paragraph", text: "a", runs: "a" }], [{ kind: "list", text: "", ordered: "oui", items: [] }], [{ kind: "html", text: "<b>" }], [{ kind: "paragraph" }],
    ]) assert.equal(readSnapshot({ ...base, blocks }), null, JSON.stringify(blocks))
    assert.equal(readSnapshot({ ...base, issuer: { address: 3 } }), null)
    assert.equal(readSnapshot({ ...base, issuer: [] }), null)
  })
})

describe("aides de l'éditeur et de l'accueil", () => {
  it("clé proposée depuis le libellé ; nom de copie ; recherche bornée", () => {
    assert.equal(keyFromLabel("Nature des travaux"), "nature_des_travaux")
    assert.equal(keyFromLabel("  Date de début (prévue) "), "date_de_debut_prevue")
    assert.equal(keyFromLabel("2e étage"), "e_etage")
    assert.equal(keyFromLabel("€€€"), "")
    assert.match(keyFromLabel("x".repeat(60) + " y"), /^[a-z][a-z0-9_]{0,39}$/)
    assert.equal(copyName("Contrat", new Set()), "Contrat (copie)")
    assert.equal(copyName("Contrat", new Set(["Contrat (copie)", "Contrat (copie 2)"])), "Contrat (copie 3)")
    const long = copyName("x".repeat(120), new Set())
    assert.ok(long && long.length === 120 && long.endsWith(" (copie)") && validateTemplateIdentity({ name: long, category: "OTHER" }).ok)
    assert.equal(copyName("C", new Set(["C (copie)", ...Array.from({ length: 49 }, (_, i) => `C (copie ${i + 2})`)])), null)
    assert.deepEqual(lireRecherche("  DOC-2026\u0000 ", "ISSUED"), { q: "DOC-2026", etat: "ISSUED" })
    assert.deepEqual(lireRecherche(["a"], "SECRET"), { q: "", etat: null })
    assert.equal(lireRecherche("x".repeat(200), undefined).q.length, 80)
  })
  it("aperçu : valeurs d'exemple valides pour chaque type ; champ non déclaré laissé visible", () => {
    const fields: FieldDef[] = [
      { key: "t", label: "Texte", type: "TEXT", required: true }, { key: "d", label: "Date", type: "DATE", required: true }, { key: "m", label: "Montant", type: "AMOUNT", required: true },
      { key: "n", label: "Nombre", type: "NUMBER", required: true }, { key: "c", label: "Choix", type: "CHOICE", required: true, options: ["a", "b"] }, { key: "k", label: "Case", type: "CHECKBOX", required: true },
      { key: "p", label: "Défaut", type: "AMOUNT", required: false, defaultValue: "1 500" },
    ]
    const values = sampleValues(fields, "2026-11-22")
    assert.deepEqual(values, { t: "[Texte]", d: "2026-11-22", m: "123456", n: "12", c: "a", k: "oui", p: "150000" })
    const fill = filler(fields, values, sampleSystem("BTP Exemple", "2026-11-22"), (k) => `{{${k}}}`)
    assert.equal(fill("{{t}} {{d}} {{m}} {{n}} {{c}} {{k}} {{p}} {{entreprise}} {{client}} {{oubli}}"), "[Texte] 22 novembre 2026 1 234,56 € 12 a Oui 1 500,00 € BTP Exemple [Client] {{oubli}}")
  })
  it("modèles de départ : identité et contenu valides, identifiants uniques, sélection par liste fermée", () => {
    assert.ok(STARTERS.length >= 4)
    assert.equal(new Set(STARTERS.map((s) => s.id)).size, STARTERS.length)
    for (const s of STARTERS) {
      assert.match(s.id, /^[a-z0-9-]{3,40}$/, s.id)
      assert.deepEqual(validateTemplateIdentity(s), { ok: true, value: { name: s.name, category: s.category } }, s.id)
      const c = validateVersionContent(s)
      assert.ok(c.ok, `${s.id} : ${c.ok ? "" : c.error}`)
      if (c.ok) assert.deepEqual(c.value.fields, s.fields, s.id)
      assert.ok(renderBlocks(s.body, plain).length >= 3, s.id)
    }
    assert.equal(lireDepart("courrier")?.id, "courrier")
    for (const bad of ["", "inconnu", ["courrier"], undefined, "__proto__"]) assert.equal(lireDepart(bad), null)
  })
})

describe("corrections après la revue Codex du 23/11/2026", () => {
  // PNG 1 × 1 valide (données fictives), sous la forme d'un logo géré.
  const LOGO = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="
  const C = { title: "Titre {{nature}}", body: "# A\n{{nature}}", fields: [{ key: "nature", label: "Nature", type: "TEXT" as const, required: true }], requiresApproval: false }

  it("empreintes de référence FIGÉES (calculées hors du code du Studio) : version et document d'origine inchangés", () => {
    // Référence de version : sha256 de la chaîne canonique écrite à la main, obtenue avec node:crypto seul.
    assert.equal(versionSha256(C), "80d21ebff0c4065219a49ae8642ef5c259de12243cfe73e28aa7aecb154bef56")
    const s = renderDocument(C, { nature: "Peinture" }, SYS, META)
    assert.equal(canonicalJson(s), `{"blocks":[{"kind":"heading","text":"A"},{"kind":"paragraph","text":"Peinture"}],"company":"BTP Exemple","issuedOn":"2026-11-04","links":{"client":"Durand","worksite":"Maison A"},"number":"DOC-2026-0001","template":{"name":"Modèle","version":1,"versionSha256":"${"a".repeat(64)}"},"title":"Titre Peinture"}`)
    assert.equal(documentSha256(s), "e3a6f99284e2fe03fb2a421929e52230ccf1ac0ae7c438810294b5d577acccae")
  })

  it("logo figé dans l'instantané : empreint, relu prudemment, seul logo du PDF (la route ne lit plus la société)", async () => {
    const sans = renderDocument(C, { nature: "Peinture" }, SYS, META)
    const avec = renderDocument(C, { nature: "Peinture" }, SYS, { ...META, logo: LOGO })
    assert.equal("logo" in sans, false)
    assert.equal(avec.logo, LOGO)
    assert.notEqual(documentSha256(avec), documentSha256(sans))
    // Refusés : autre origine, autre type, vide, hors alphabet, base64 sans signature PNG, longueur non canonique, plus de 600 Kio.
    const trop = `data:image/png;base64,iVBORw0KGgo${"A".repeat(819_200 - 11 + 4)}`
    assert.equal(readSnapshot({ ...avec, logo: `data:image/png;base64,iVBORw0KGgo${"A".repeat(819_200 - 11)}` })?.number, avec.number, "600 Kio exactement : admis")
    for (const bad of ["https://exemple.test/logo.png", "data:image/svg+xml;base64,AAAA", "data:image/png;base64,", "data:image/png;base64,@@@", "data:image/png;base64,AAAA", `${LOGO}A`, `${LOGO.slice(0, -2)}===`, `${LOGO.slice(0, -3)}h==`, "data:image/png;base64,iVBORw0KGgoAAB==", "data:image/png;base64,iVBORw0KGgoAAAAAAAB=", trop, null, ""]) {
      assert.equal("logo" in renderDocument(C, { nature: "Peinture" }, SYS, { ...META, logo: bad }), false, String(bad))
    }
    // Fins canoniques admises : sans complément, « = » et « == » dont le dernier caractère ne porte aucun bit inutilisé.
    for (const ok of ["data:image/png;base64,iVBORw0KGgoA", "data:image/png;base64,iVBORw0KGgoAAAAAAAA=", "data:image/png;base64,iVBORw0KGgoAAQ=="]) assert.equal(isSnapshotLogo(ok), true, ok)
    assert.equal(readSnapshot({ ...avec, logo: `${LOGO.slice(0, -3)}h==` }), null, "même logo, écriture non canonique : refusé à la relecture")
    assert.deepEqual(readSnapshot(JSON.parse(JSON.stringify(avec))), avec)
    assert.equal(readSnapshot({ ...avec, logo: "https://exemple.test/logo.png" }), null)
    assert.equal(readSnapshot({ ...avec, logo: 3 }), null)
    const pdf = await renderToBuffer(<GeneratedDocumentPdf snapshot={avec} snapshotSha256={documentSha256(avec)} status="ISSUED" approval={null} />)
    const pdfSans = await renderToBuffer(<GeneratedDocumentPdf snapshot={sans} snapshotSha256={documentSha256(sans)} status="ISSUED" approval={null} />)
    assert.ok(pdf.includes("/Subtype /Image") && !pdfSans.includes("/Subtype /Image"))
    const route = code(read("src/app/(dashboard)/studio-documents/documents/[id]/pdf/route.tsx"))
    assert.doesNotMatch(route, /logo|company\.findUnique/)
    assert.match(code(read("src/lib/document-studio/document-pdf.tsx")), /d\.logo \? <Image src=\{d\.logo\}/)
    assert.match(code(read("src/lib/document-studio/studio.service.ts")), /logo: logoForPdf\(company\.logoUrl\)/)
  })

  it("clés devenues système avec G2 : version stockée lisible, champ déclaré prioritaire, refus à l'enregistrement", () => {
    const legacy: FieldDef[] = [{ key: "client_email", label: "Courriel saisi", type: "TEXT", required: true }]
    assert.deepEqual(readFields(JSON.parse(JSON.stringify(legacy))), legacy)
    // Les cinq champs système d'origine restent refusés, comme dans le lot G.
    for (const k of ["entreprise", "numero", "date_document", "client", "chantier"]) assert.equal(readFields([{ ...legacy[0], key: k }]), null, k)
    const sys = { ...SYS, client_email: "fiche@exemple.test" }
    assert.equal(filler(legacy, { client_email: "saisi@exemple.test" }, sys)("{{client_email}}"), "saisi@exemple.test")
    assert.equal(filler([], {}, sys)("{{client_email}}"), "fiche@exemple.test")
    assert.deepEqual(validateValues(legacy, { client_email: "saisi@exemple.test" }), { ok: true, value: { client_email: "saisi@exemple.test" } })
    assert.deepEqual(validateVersionContent({ title: "Titre", body: "{{client_email}}", fields: legacy, requiresApproval: false }), { ok: false, error: STUDIO_ERRORS.reservedKeys(["client_email"]) })
    assert.equal(validateVersionContent({ title: "Titre", body: "{{client_email}}", fields: [], requiresApproval: false }).ok, true)
  })

  it("tableau : une ligne de cellules vides est conservée ; seule une ligne à tirets est un séparateur", () => {
    const rows = (body: string) => renderBlocks(body, plain).find((b) => b.kind === "table")?.rows
    assert.deepEqual(rows("| A | B |\n|---|---|\n| | |\n| x | y |"), [["A", "B"], ["", ""], ["x", "y"]])
    assert.deepEqual(rows("| A | B |\n| :-- | --: |\n| x | y |"), [["A", "B"], ["x", "y"]])
    assert.deepEqual(rows("| A | B |\n|  |  |"), [["A", "B"], ["", ""]])
  })

  it("génération liée à la version affichée ; validation refusée si l'empreinte ne correspond plus", () => {
    const svc = code(read("src/lib/document-studio/studio.service.ts"))
    assert.match(svc, /if \(input\.versionId !== undefined && rows\[0\]\.id !== input\.versionId\) fail\(STUDIO_ERRORS\.versionChanged\)/)
    const approve = svc.slice(svc.indexOf("export async function approveDocument"), svc.indexOf("export async function rejectDocument"))
    assert.match(approve, /readSnapshot\(d\.snapshot\)[\s\S]*documentSha256\(snap\) !== d\.snapshotSha256\) fail\(STUDIO_ERRORS\.notIntact\)[\s\S]*status: "ISSUED"/)
    // L'action transmet TOUJOURS la version (absente ou invalide : chaîne vide, donc refus par le service).
    assert.match(code(read("src/lib/actions/document-studio.actions.ts")), /svc\.generateDocument\(prisma, ctx, reqId\(form, "templateId"\), \{ versionId: reqId\(form, "versionId"\), values,/)
    const fiche = code(read("src/app/(dashboard)/studio-documents/[templateId]/page.tsx"))
    assert.match(fiche, /action=\{generateDocumentAction\}[^\n]*\n[^\n]*name="versionId" value=\{published\.id\}/)
    assert.match(code(read("src/app/(dashboard)/studio-documents/documents/[id]/page.tsx")), /\{d\.intact && <FormulaireRetour action=\{approveDocumentAction\}/)
  })
})

describe("PDF et frontières des modules", () => {
  it("PDF réel avec tous les types de blocs, logo absent, deux pages au moins (saut de page)", async () => {
    const s = renderDocument(
      { title: "Contrat {{numero}}", body: STARTERS[0].body + `\n\n${PAGE_BREAK}\n\n- **un**\n- deux\n\n1. premier\n\n## Annexe\nFin.`, fields: STARTERS[0].fields, requiresApproval: false },
      { objet: "Peinture", date_debut: "2026-11-02", date_fin: "2026-11-20", montant_ht: "123450", conditions_reglement: "À réception de facture" },
      { ...SYS, entreprise_adresse: "1 rue A, Paris", entreprise_siret: "12345678900012", client_adresse: "2 rue B, Lyon", chantier_adresse: "3 rue C, Lille" }, META,
    )
    assert.deepEqual([...new Set(s.blocks.map((b) => b.kind))].sort(), ["heading", "list", "pagebreak", "paragraph", "subheading", "table"])
    const pdf = await renderToBuffer(<GeneratedDocumentPdf snapshot={s} snapshotSha256={documentSha256(s)} status="PENDING_APPROVAL" approval={null} />)
    assert.equal(pdf.subarray(0, 5).toString("latin1"), "%PDF-")
    assert.ok(pdf.length > 2000)
    const { text } = await extractText(await getDocumentProxy(new Uint8Array(pdf)), { mergePages: false })
    assert.equal(text.length, 2, "deux pages (saut de page)")
    assert.ok(text[0].includes("PROJET — EN ATTENTE DE VALIDATION") && text[0].includes("Désignation Montant HT") && text[0].includes("1 234,50 €"))
    assert.ok(text[1].includes("Annexe") && text[1].includes("• un") && text[1].includes("1. premier"))
    // Pied de page réellement imprimé sur CHAQUE page (il ne l'était pas dans le lot G : interligne hérité de la page).
    text.forEach((page, i) => {
      assert.ok(page.includes("BTP Exemple — 1 rue A, Paris — SIRET 12345678900012"), `coordonnées page ${i + 1}`)
      assert.ok(page.includes(`empreinte ${documentSha256(s).slice(0, 16)} · page ${i + 1} / 2`), `pagination page ${i + 1}`)
    })
    assert.doesNotMatch(code(read("src/lib/document-studio/document-pdf.tsx")).match(/page: \{[^}]*\}/)![0], /lineHeight/)
  })
  it("rendu initial de l'éditeur (chaque modèle de départ) : champs envoyés, aperçu rempli, texte échappé", () => {
    for (const st of STARTERS) {
      const html = renderToStaticMarkup(<StudioTemplateEditor initial={st} companyName="BTP <Exemple>" today="2026-11-22" submitLabel="Créer le modèle" />)
      assert.ok(html.includes(`name="title"`) && html.includes(`name="body"`) && html.includes(`name="fieldsJson"`) && html.includes(`name="requiresApproval"`), st.id)
      assert.ok(html.includes("Contenu cohérent"), `${st.id} : contrôle de cohérence`)
      assert.doesNotMatch(html, /\{\{[a-z_]+\}\}<\/(?:p|span|td|th|h2|h3|strong)>/, `${st.id} : aucun champ non remplacé dans l'aperçu`)
      assert.doesNotMatch(html, /<Exemple>/, st.id)
    }
    const html = renderToStaticMarkup(<StudioBlocks blocks={renderBlocks("# T\n\n- **a** <b>\n\n| x | y |\n| 1 | 2 |\n\n[saut de page]", plain)} />)
    assert.ok(html.includes("<strong") && html.includes("&lt;b&gt;") && html.includes("<table") && html.includes(`role="separator"`))
  })
  it("règles de contenu utilisables dans le navigateur : ni Prisma, ni node:crypto, ni module serveur", () => {
    const f = code(read("src/lib/document-studio/studio.format.ts"))
    assert.deepEqual([...f.matchAll(/from "([^"]+)"/g)].map((m) => m[1]).sort(), ["@/lib/accounting/engine/money", "@/lib/equipment/equipment.core"])
    for (const dep of ["src/lib/accounting/engine/money.ts", "src/lib/equipment/equipment.core.ts"]) assert.doesNotMatch(code(read(dep)), /^import /m, dep)
    for (const client of ["src/components/document-studio/StudioTemplateEditor.tsx", "src/components/document-studio/StudioBlocks.tsx"]) {
      assert.doesNotMatch(code(read(client)), /@\/lib\/prisma|@\/lib\/actions|document-studio\/(?:studio\.core|canonical|queries|access|studio\.service|document-pdf)|node:|fetch\(|dangerouslySetInnerHTML|https?:\/\//, client)
    }
    assert.match(read("src/components/document-studio/StudioTemplateEditor.tsx"), /^"use client"/)
    assert.ok(code(read("src/components/document-studio/StudioTemplateEditor.tsx")).includes(`<input type="hidden" name="fieldsJson" value={JSON.stringify(defs)} />`))
  })
  it("écrans : éditeur dans les formulaires de création et de brouillon ; recherche en lecture seule ; préremplissage borné au modèle", () => {
    const accueil = code(read("src/app/(dashboard)/studio-documents/page.tsx"))
    const modele = code(read("src/app/(dashboard)/studio-documents/[templateId]/page.tsx"))
    const doc = code(read("src/app/(dashboard)/studio-documents/documents/[id]/page.tsx"))
    for (const c of [accueil, modele]) assert.ok(c.includes("<StudioTemplateEditor"))
    assert.ok(accueil.includes("const recherche = lireRecherche(params.q, params.etat)") && accueil.includes("const depart = lireDepart(params.depart)"))
    assert.ok(accueil.indexOf("if (!ctx) return <AdminOnlyNotice />") < accueil.indexOf("lireRecherche("))
    assert.ok(accueil.includes("listGeneratedDocuments(prisma, ctx.companyId, 50, { q: recherche.q, status: recherche.etat })"))
    const search = code(read("src/components/document-studio/StudioDocumentSearch.tsx"))
    assert.ok(search.includes(`<form method="get" action="/studio-documents#documents"`))
    assert.doesNotMatch(search, /"use client"|@\/lib\/actions|@\/lib\/prisma/)
    assert.ok(modele.includes("getDocumentForReuse(prisma, ctx.companyId, t.id, sp.depuis)") && modele.includes("ID.test(sp.depuis)"))
    assert.ok(read("src/lib/document-studio/queries.ts").includes("where: { id: documentId, companyId, version: { templateId } }"))
    assert.ok(doc.includes("<a href={`/studio-documents/${d.version.templateId}?depuis=${d.id}#generer`}") && doc.includes("<StudioBlocks blocks={d.snapshot.blocks} />"))
    const actions = code(read("src/lib/actions/document-studio.actions.ts"))
    assert.ok(actions.includes(`form.has("fieldsJson") ? parseFieldsJson(str(form, "fieldsJson", 60_000)) : parseFieldLines(str(form, "fields", 20_000))`))
  })
})
