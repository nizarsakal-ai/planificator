/** Destinataires des photos — rendu statique de l'éditeur et lecture relue en base (données fictives, sans navigateur). */
import assert from "node:assert/strict"
import { describe, it } from "node:test"
import React, { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { PhotoRecipientsEditor } from "@/components/chantiers/PhotoRecipientsEditor"
import { canReadPhotoRecipients } from "@/lib/chantiers/photo-recipients-access"

;(globalThis as { React?: typeof React }).React = React

const rows = [
  { label: "Responsable", email: "resp@client.example", active: true },
  { label: "", email: "absente@client.example", active: false },
]
const render = (props: Parameters<typeof PhotoRecipientsEditor>[0]) => renderToStaticMarkup(createElement(PhotoRecipientsEditor, props))

describe("éditeur des destinataires", () => {
  it("intitulés, aide, lignes nom/fonction + e-mail + Actif + Retirer, ajout ; aucune liste envoyée tant que rien n'est modifié", () => {
    const html = render({ initialRows: rows, historicSuggestion: null })
    assert.match(html, /Destinataires des photos/)
    assert.match(html, /Destinataires propres à ce chantier\. Aucun envoi automatique\./)
    assert.match(html, /placeholder="exemple@client\.fr"/)
    assert.match(html, /Nom \/ fonction \(facultatif\)/)
    assert.equal((html.match(/type="checkbox"/g) ?? []).length, 2)
    assert.match(html, /Retirer/)
    assert.match(html, /Ajouter un destinataire/)
    assert.equal(/name="photoRecipients"/.test(html), false, "champ absent ⇒ configuration conservée")
    assert.equal(/<input[^>]*name="(?!photoRecipients)[^"]*"[^>]*>/.test(html), false, "les champs de ligne n'ont pas de nom (seule la liste JSON est envoyée)")
  })
  it("adresse historique : simple suggestion avec bouton explicite, jamais une ligne préremplie", () => {
    const html = render({ initialRows: [], historicSuggestion: "historique@client.example" })
    assert.match(html, /Adresse historique \(non utilisée\)/)
    assert.match(html, /Ajouter comme destinataire/)
    assert.equal(/value="historique@client\.example"/.test(html), false)
    assert.match(html, /Aucun destinataire\./)
  })
  it("20 destinataires : ajout désactivé ; sauvegarde en cours : tout l'éditeur désactivé", () => {
    const twenty = Array.from({ length: 20 }, (_, i) => ({ label: "", email: `p${i}@client.example`, active: true }))
    assert.match(render({ initialRows: twenty, historicSuggestion: null }), /20 destinataires au plus/)
    assert.match(render({ initialRows: rows, historicSuggestion: null, disabled: true }), /<fieldset[^>]*disabled=""/)
  })
})

describe("lecture des adresses : autorité relue en base", () => {
  const db = (user: { active: boolean; role: string } | null, company: { active: boolean } | null) => ({
    user: { findFirst: async () => user }, company: { findFirst: async () => company },
  }) as unknown as Parameters<typeof canReadPhotoRecipients>[0]
  const sa = { user: { id: "u1", role: "SUPER_ADMIN", companyId: "c1" } }
  it("SUPER_ADMIN actif, entreprise active ⇒ lecture ; session périmée (rétrogradé, désactivé, entreprise inactive) ⇒ aucune lecture", async () => {
    assert.equal(await canReadPhotoRecipients(db({ active: true, role: "SUPER_ADMIN" }, { active: true }), sa), true)
    assert.equal(await canReadPhotoRecipients(db({ active: true, role: "ADMIN" }, { active: true }), sa), false)
    assert.equal(await canReadPhotoRecipients(db({ active: false, role: "SUPER_ADMIN" }, { active: true }), sa), false)
    assert.equal(await canReadPhotoRecipients(db({ active: true, role: "SUPER_ADMIN" }, { active: false }), sa), false)
    assert.equal(await canReadPhotoRecipients(db(null, { active: true }), sa), false)
  })
  it("autres rôles de session ou entreprise absente ⇒ aucune lecture, sans requête", async () => {
    const throwing = { user: { findFirst: async () => { throw new Error("aucune requête attendue") } }, company: { findFirst: async () => { throw new Error("aucune requête attendue") } } } as unknown as Parameters<typeof canReadPhotoRecipients>[0]
    for (const role of ["ADMIN", "TEAM_LEADER", "EMPLOYEE"]) assert.equal(await canReadPhotoRecipients(throwing, { user: { id: "u1", role, companyId: "c1" } }), false)
    assert.equal(await canReadPhotoRecipients(throwing, { user: { id: "u1", role: "SUPER_ADMIN", companyId: null } }), false)
    assert.equal(await canReadPhotoRecipients(throwing, null), false)
  })
})
