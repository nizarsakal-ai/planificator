/** Destinataires des photos — lecture pure du champ de formulaire et compatibilité de l'adresse historique (données fictives). */
import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { PHOTO_RECIPIENTS_FIELD, initialRecipientState, readPhotoRecipientsField } from "@/lib/chantiers/photo-recipients"

function form(...values: Array<string | Blob>): FormData {
  const fd = new FormData()
  fd.append("name", "Chantier test")
  for (const v of values) fd.append(PHOTO_RECIPIENTS_FIELD, v)
  return fd
}
const json = (rows: unknown) => JSON.stringify(rows)
const kind = (fd: FormData) => readPhotoRecipientsField(fd).kind

describe("champ photoRecipients : absent ≠ vide", () => {
  it("absent ⇒ configuration conservée ; liste vide ⇒ effacement explicite", () => {
    assert.deepEqual(readPhotoRecipientsField(form()), { kind: "absent" })
    assert.deepEqual(readPhotoRecipientsField(form("[]")), { kind: "set", recipients: [] })
  })
  it("normalisation : trim, nom/fonction vide ⇒ null, actif conservé, ordre conservé", () => {
    const result = readPhotoRecipientsField(form(json([
      { label: "  Responsable chantier ", email: "  resp@client.example ", active: true },
      { label: "", email: "direction@client.example", active: false },
      { email: "autre@client.example", active: true },
    ])))
    assert.deepEqual(result, { kind: "set", recipients: [
      { label: "Responsable chantier", email: "resp@client.example", active: true },
      { label: null, email: "direction@client.example", active: false },
      { label: null, email: "autre@client.example", active: true },
    ] })
  })
})

describe("champ photoRecipients : refus sans écriture", () => {
  it("champ répété, fichier, JSON invalide, non-liste, trop volumineux ⇒ invalide", () => {
    assert.equal(kind(form("[]", "[]")), "invalid")
    assert.equal(kind(form(new Blob(["[]"], { type: "application/json" }))), "invalid")
    assert.equal(kind(form("{pas du json")), "invalid")
    assert.equal(kind(form(json({ email: "a@client.example", active: true }))), "invalid")
    assert.equal(kind(form(json([{ label: "x".repeat(17_000), email: "a@client.example", active: true }]))), "invalid")
  })
  it("plus de 20 lignes ⇒ refus explicite", () => {
    const rows = Array.from({ length: 21 }, (_, i) => ({ email: `r${i}@client.example`, active: true }))
    assert.deepEqual(readPhotoRecipientsField(form(json(rows))), { kind: "invalid", message: "20 destinataires au plus par chantier." })
    assert.equal(kind(form(json(rows.slice(0, 20)))), "set")
  })
  it("e-mail invalide, liste d'adresses, trop long ⇒ refus citant la ligne, jamais l'adresse", () => {
    for (const email of ["pas-un-email", "a@client.example, b@client.example", "a@client.example;b@client.example", "a b@client.example", `${"a".repeat(250)}@client.example`, "   "]) {
      const result = readPhotoRecipientsField(form(json([{ email: "ok@client.example", active: true }, { email, active: true }])))
      assert.equal(result.kind, "invalid", email)
      if (result.kind === "invalid") {
        assert.match(result.message, /^Destinataire 2 : e-mail invalide/)
        assert.equal(result.message.includes("@"), false, "aucune adresse dans le message")
      }
    }
  })
  it("doublon insensible à la casse ⇒ refus ; nom/fonction > 120 ⇒ refus ; clé inconnue ou actif non booléen ⇒ refus", () => {
    const dup = readPhotoRecipientsField(form(json([{ email: "Resp@Client.example", active: true }, { email: "resp@client.example", active: false }])))
    assert.deepEqual(dup, { kind: "invalid", message: "Destinataire 2 : adresse déjà présente dans la liste." })
    assert.match((readPhotoRecipientsField(form(json([{ label: "x".repeat(121), email: "a@client.example", active: true }]))) as { message: string }).message, /trop long/)
    assert.equal(kind(form(json([{ email: "a@client.example", active: true, role: "x" }]))), "invalid")
    assert.equal(kind(form(json([{ email: "a@client.example", active: "oui" }]))), "invalid")
    assert.equal(kind(form(json([{ email: "a@client.example" }]))), "invalid")
  })
})

describe("compatibilité de l'adresse historique (clientContact)", () => {
  const historic = "historique@client.example"
  it("jamais configurée : adresse historique SUGGÉRÉE seulement (aucune ligne préremplie)", () => {
    assert.deepEqual(initialRecipientState({ recipients: [], configuredAt: null, clientContact: historic }), { rows: [], historicSuggestion: historic })
    assert.deepEqual(initialRecipientState({ recipients: [], configuredAt: null, clientContact: null }), { rows: [], historicSuggestion: null })
    assert.equal(initialRecipientState({ recipients: [], configuredAt: null, clientContact: "invalide" }).historicSuggestion, null)
  })
  it("liste vidée volontairement ou entièrement inactive : l'adresse historique n'est JAMAIS réactivée ni suggérée", () => {
    assert.deepEqual(initialRecipientState({ recipients: [], configuredAt: new Date(), clientContact: historic }), { rows: [], historicSuggestion: null })
    const inactive = initialRecipientState({ recipients: [{ label: "Absente", email: "absente@client.example", active: false }], configuredAt: new Date(), clientContact: historic })
    assert.deepEqual(inactive, { rows: [{ label: "Absente", email: "absente@client.example", active: false }], historicSuggestion: null })
  })
})
