/**
 * Rendu statique du menu « ⋯ » des cartes client (react-dom/server, aucun navigateur).
 * `next/navigation` est doublé (useRouter hors App Router) ; les actions serveur ne sont jamais appelées.
 * Exécution : npm run test:clients (drapeau --experimental-test-module-mocks requis)
 */
import assert from "node:assert/strict"
import { describe, it, mock } from "node:test"
import React, { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"

// tsconfig "jsx": "preserve" → sous tsx, le JSX est compilé en React.createElement (runtime classique).
;(globalThis as { React?: typeof React }).React = React

mock.module("next/navigation", { namedExports: { useRouter: () => ({ refresh: () => {}, push: () => {} }) } })
mock.module("@/lib/actions/client.actions", {
  namedExports: {
    deleteClient: async () => { throw new Error("deleteClient ne doit pas être appelé au rendu") },
    toggleClientActive: async () => { throw new Error("toggleClientActive ne doit pas être appelé au rendu") },
    createClient: async () => ({ success: true }),
    updateClient: async () => ({ success: true }),
  },
})

const client = { id: "c1", name: "Lauralu <SAS>", email: null, phone: null, address: null, notes: null, active: true }

async function render(props: { active?: boolean; canDelete: boolean }) {
  const { ClientActions } = await import("@/components/clients/ClientActions")
  return renderToStaticMarkup(
    createElement(ClientActions, { client: { ...client, active: props.active ?? true }, canDelete: props.canDelete })
  )
}

describe("ClientActions — rendu initial", () => {
  it("un seul bouton d'ouverture, libellé accessible, nom échappé", async () => {
    const html = await render({ canDelete: true })
    assert.equal((html.match(/<button/g) ?? []).length, 1, "le menu est fermé : un seul bouton rendu")
    assert.ok(html.includes('aria-label="Actions pour Lauralu &lt;SAS&gt;"'))
    assert.ok(html.includes('aria-haspopup="menu"'))
    assert.ok(html.includes('aria-expanded="false"'))
    assert.ok(!/<button[^>]*\sdisabled(=""|\s|>)/.test(html), "bouton actif au repos (aucun appel en vol)")
  })
  it("fermé : ni formulaire, ni dialogue de suppression, ni entrée de menu dans le DOM", async () => {
    for (const canDelete of [true, false]) {
      const html = await render({ canDelete })
      assert.ok(!html.includes("Supprimer le client"))
      assert.ok(!html.includes("Modifier le client"))
      assert.ok(!html.includes("Désactiver"))
      assert.ok(!html.includes("<form"))
    }
  })
})
