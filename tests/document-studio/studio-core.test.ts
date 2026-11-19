/**
 * Lot G Planificator V2 : Document Studio — règles pures (déclaration des champs, cohérence champs cités/déclarés,
 * valeurs typées et champs manquants refusés, rendu textuel déterministe, empreintes).
 */
import assert from "node:assert/strict"
import { describe, it } from "node:test"
import {
  STUDIO_ERRORS, documentSha256, fieldLines, parseFieldLines, placeholdersOf, readFields, readSnapshot, renderDocument, validateTemplateIdentity,
  validateValues, validateVersionContent, versionSha256, type FieldDef,
} from "@/lib/document-studio/studio.core"
import { isDocumentStudioEnabled } from "@/lib/document-studio/studio-feature-flag"

const FIELDS: FieldDef[] = [
  { key: "nature", label: "Nature des travaux", type: "TEXT", required: true },
  { key: "montant", label: "Montant", type: "AMOUNT", required: true },
  { key: "fin", label: "Date de fin", type: "DATE", required: true },
  { key: "remarques", label: "Remarques", type: "LONG_TEXT", required: false },
]
const BODY = "# Objet\nNous attestons que les travaux de {{ nature }} ont été réalisés pour {{client}} sur le chantier {{chantier}}.\n\nMontant : {{montant}}. Fin : {{fin}}.\n\n# Observations\n{{remarques}}"
const CONTENT = { title: "Attestation {{numero}}", body: BODY, fields: FIELDS, requiresApproval: true }
const SYS = { entreprise: "BTP Exemple", numero: "DOC-2026-0001", date_document: "2026-11-04", client: "Durand", chantier: "Maison A" }
const META = { templateName: "Attestation de travaux", version: 2, versionSha256: "a".repeat(64) }

describe("modèle et version", () => {
  it("identité : nom 3 à 120 caractères, catégorie de la liste fermée ; drapeau désactivé par défaut", () => {
    assert.deepEqual(validateTemplateIdentity({ name: "  Attestation ", category: "CERTIFICATE" }), { ok: true, value: { name: "Attestation", category: "CERTIFICATE" } })
    assert.deepEqual(validateTemplateIdentity({ name: "At", category: "CERTIFICATE" }), { ok: false, error: STUDIO_ERRORS.name })
    assert.deepEqual(validateTemplateIdentity({ name: "Attestation", category: "SECRET" }), { ok: false, error: STUDIO_ERRORS.category })
    assert.equal(isDocumentStudioEnabled({}), false)
    assert.equal(isDocumentStudioEnabled({ DOCUMENT_STUDIO_ENABLED: "true" }), true)
  })
  it("déclaration des champs : clé, libellé, type, unicité, champs système réservés ; lignes du formulaire aller-retour", () => {
    assert.deepEqual(readFields(FIELDS), FIELDS)
    for (const bad of [[{ ...FIELDS[0], key: "Nature" }], [FIELDS[0], FIELDS[0]], [{ ...FIELDS[0], key: "client" }], [{ ...FIELDS[0], type: "HTML" }], [{ ...FIELDS[0], label: "x" }], [{ ...FIELDS[0], required: "oui" }], "x", Array.from({ length: 41 }, (_, i) => ({ ...FIELDS[0], key: `f${i}` }))]) {
      assert.equal(readFields(bad), null, JSON.stringify(bad).slice(0, 60))
    }
    assert.deepEqual(parseFieldLines(fieldLines(FIELDS)), FIELDS)
    assert.deepEqual(parseFieldLines("nature | Nature | text | Obligatoire"), [{ key: "nature", label: "Nature", type: "TEXT", required: true }])
    assert.equal(parseFieldLines("nature | Nature | TEXT"), null)
    assert.deepEqual(parseFieldLines(""), [])
  })
  it("cohérence : champ cité non déclaré refusé, champ déclaré jamais cité refusé ; champs système libres", () => {
    assert.deepEqual(placeholdersOf(BODY).sort(), ["chantier", "client", "fin", "montant", "nature", "remarques"])
    assert.equal(validateVersionContent(CONTENT).ok, true)
    assert.deepEqual(validateVersionContent({ ...CONTENT, body: `${BODY} {{inconnu}}` }), { ok: false, error: STUDIO_ERRORS.undeclared(["inconnu"]) })
    assert.deepEqual(validateVersionContent({ ...CONTENT, body: BODY.replace("{{remarques}}", "") }), { ok: false, error: STUDIO_ERRORS.unused(["remarques"]) })
    assert.deepEqual(validateVersionContent({ ...CONTENT, title: "ab" }), { ok: false, error: STUDIO_ERRORS.title })
    assert.deepEqual(validateVersionContent({ ...CONTENT, body: "x".repeat(20_001) }), { ok: false, error: STUDIO_ERRORS.body })
    assert.deepEqual(validateVersionContent({ ...CONTENT, fields: "invalide" }), { ok: false, error: STUDIO_ERRORS.fields })
  })
  it("empreinte de version : stable, sensible au contenu et à l'ordre des champs", () => {
    const c = validateVersionContent(CONTENT)
    assert.ok(c.ok)
    if (!c.ok) return
    assert.match(versionSha256(c.value), /^[0-9a-f]{64}$/)
    assert.equal(versionSha256(c.value), versionSha256({ ...c.value, fields: c.value.fields.map((f) => ({ required: f.required, type: f.type, label: f.label, key: f.key })) }))
    assert.notEqual(versionSha256(c.value), versionSha256({ ...c.value, body: `${c.value.body}.` }))
    assert.notEqual(versionSha256(c.value), versionSha256({ ...c.value, fields: [...c.value.fields].reverse() }))
    assert.notEqual(versionSha256(c.value), versionSha256({ ...c.value, requiresApproval: false }))
  })
})

describe("valeurs et génération", () => {
  it("valeurs typées : montant en centimes, date normalisée, nombre entier ; facultatif vide omis", () => {
    assert.deepEqual(validateValues(FIELDS, { nature: " peinture ", montant: "1 234,5", fin: "2026-11-03", remarques: "" }), { ok: true, value: { nature: "peinture", montant: "123450", fin: "2026-11-03" } })
    assert.deepEqual(validateValues([{ key: "n", label: "N", type: "NUMBER", required: true }], { n: "1 200" }), { ok: true, value: { n: "1200" } })
  })
  it("refus : champ inconnu, champs obligatoires manquants (tous nommés), valeurs invalides", () => {
    assert.deepEqual(validateValues(FIELDS, { nature: "x", montant: "1", fin: "2026-11-03", intrus: "y" }), { ok: false, error: STUDIO_ERRORS.unknown(["intrus"]) })
    assert.deepEqual(validateValues(FIELDS, { nature: "  ", fin: "2026-11-03" }), { ok: false, error: STUDIO_ERRORS.missing(["Nature des travaux", "Montant"]) })
    assert.deepEqual(validateValues(FIELDS, { nature: "x", montant: "-5", fin: "2026-11-03" }), { ok: false, error: STUDIO_ERRORS.invalidValue("Montant") })
    assert.deepEqual(validateValues(FIELDS, { nature: "x", montant: "5", fin: "2026-02-30" }), { ok: false, error: STUDIO_ERRORS.invalidValue("Date de fin") })
    assert.deepEqual(validateValues(FIELDS, { nature: "x".repeat(501), montant: "5", fin: "2026-11-03" }), { ok: false, error: STUDIO_ERRORS.invalidValue("Nature des travaux") })
    assert.deepEqual(validateValues([{ key: "n", label: "N", type: "NUMBER", required: true }], { n: "1,5" }), { ok: false, error: STUDIO_ERRORS.invalidValue("N") })
  })
  it("rendu : intertitres, paragraphes, valeurs formatées en texte brut, facultatif vide sans paragraphe vide", () => {
    const v = validateValues(FIELDS, { nature: "peinture", montant: "1 234,5", fin: "2026-11-03" })
    assert.ok(v.ok)
    if (!v.ok) return
    const snap = renderDocument(CONTENT, v.value, SYS, META)
    assert.equal(snap.title, "Attestation DOC-2026-0001")
    assert.deepEqual(snap.blocks, [
      { kind: "heading", text: "Objet" },
      { kind: "paragraph", text: "Nous attestons que les travaux de peinture ont été réalisés pour Durand sur le chantier Maison A." },
      { kind: "paragraph", text: "Montant : 1 234,50 €. Fin : 3 novembre 2026." },
      { kind: "heading", text: "Observations" },
    ])
    assert.deepEqual([snap.number, snap.issuedOn, snap.company, snap.template, snap.links], ["DOC-2026-0001", "2026-11-04", "BTP Exemple", { name: "Attestation de travaux", version: 2, versionSha256: "a".repeat(64) }, { client: "Durand", worksite: "Maison A" }])
    const html = renderDocument(CONTENT, { ...v.value, nature: "<script>{{client}}</script>" }, SYS, META)
    assert.equal(html.blocks[1].text, "Nous attestons que les travaux de <script>{{client}}</script> ont été réalisés pour Durand sur le chantier Maison A.", "une valeur n'est jamais réinterprétée (un seul passage de remplacement)")
  })
  it("reproductible : même entrée ⇒ même instantané et même empreinte ; relecture prudente", () => {
    const v = validateValues(FIELDS, { nature: "peinture", montant: "10", fin: "2026-11-03" })
    assert.ok(v.ok)
    if (!v.ok) return
    const a = renderDocument(CONTENT, v.value, SYS, META), b = renderDocument(CONTENT, v.value, SYS, META)
    assert.equal(documentSha256(a), documentSha256(b))
    assert.notEqual(documentSha256(a), documentSha256({ ...a, title: `${a.title}!` }))
    assert.deepEqual(readSnapshot(JSON.parse(JSON.stringify(a))), a)
    for (const bad of [null, [], { ...a, blocks: [{ kind: "script", text: "x" }] }, { ...a, template: { ...a.template, version: 1.5 } }]) assert.equal(readSnapshot(bad), null)
  })
})
