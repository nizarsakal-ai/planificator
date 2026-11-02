import assert from "node:assert/strict"
import { it } from "node:test"
import React from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { Documents } from "../../src/components/hr-documents/Documents"
;(globalThis as {React?:typeof React}).React=React

const employee={id:"synthetic-employee",firstName:"Camille",lastName:"Exemple"}
it("renders the server-selected employee without exposing a profile link by default",()=>{
  const html=renderToStaticMarkup(<Documents manage employeeId={employee.id} employeeContext={employee}/> )
  assert.match(html,/Camille Exemple/)
  assert.doesNotMatch(html,/href="\/employes\/synthetic-employee"/)
  assert.match(html,/Tous les documents RH/)
  assert.doesNotMatch(html,/Ajouter des documents|Publier la version/)
})
it("the profile return requires an explicit page authorization",()=>{
  const html=renderToStaticMarkup(<Documents manage employeeId={employee.id} employeeContext={employee} canReturnToEmployee/> )
  assert.match(html,/href="\/employes\/synthetic-employee"/)
})
it("the personal page does not render the operator context or navigation",()=>{
  const html=renderToStaticMarkup(<Documents employeeContext={employee}/> )
  assert.match(html,/Mes documents/)
  assert.doesNotMatch(html,/Camille Exemple|Retour à la fiche|Tous les documents RH/)
})
