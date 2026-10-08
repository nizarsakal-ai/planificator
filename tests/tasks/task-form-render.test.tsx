// Module Tâches V1 — Rendu du formulaire (listes vides/peuplées, aucune DB).
// DATABASE_URL factice : l'import transitif de l'action instancie Prisma sans s'y connecter.
process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test"

import assert from "node:assert/strict"
import { describe, it } from "node:test"
import React, { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { TaskForm, type TaskEmployeeOption, type TaskWorksiteOption } from "@/components/tasks/TaskForm"

// tsconfig "jsx": "preserve" → runtime JSX classique sous tsx.
;(globalThis as { React?: typeof React }).React = React

const render = (employees: TaskEmployeeOption[], worksites: TaskWorksiteOption[]) =>
  renderToStaticMarkup(createElement(TaskForm, { employees, worksites, onSuccess: () => {} }))

describe("TaskForm — rendu listes vides", () => {
  const html = render([], [])

  it("bouton de création présent et actif (non pending à l'initial)", () => {
    assert.match(html, /Créer la tâche/)
    assert.doesNotMatch(html, /Création\.\.\./)
  })

  it("option « Aucun » pour employé et chantier, sans option supplémentaire", () => {
    assert.equal((html.match(/<option value="">Aucun<\/option>/g) ?? []).length, 2)
    // Options totales = statut(3) + priorité(3) + « Aucun » employé + « Aucun » chantier = 8,
    // soit aucune option employé/chantier ajoutée quand les listes sont vides.
    assert.equal((html.match(/<option/g) ?? []).length, 8)
  })

  it("statuts et priorités en libellés français", () => {
    for (const label of ["À faire", "En cours", "Terminée", "Basse", "Moyenne", "Haute"]) {
      assert.match(html, new RegExp(`>${label}</option>`))
    }
  })
})

describe("TaskForm — rendu listes peuplées", () => {
  const html = render(
    [{ id: "emp1", firstName: "Hélène", lastName: "Dupont" }],
    [{ id: "ws1", name: "Chantier Nord" }]
  )

  it("les options employé/chantier sont rendues avec leur identifiant", () => {
    assert.match(html, /<option value="emp1">Hélène Dupont<\/option>/)
    assert.match(html, /<option value="ws1">Chantier Nord<\/option>/)
  })
})
