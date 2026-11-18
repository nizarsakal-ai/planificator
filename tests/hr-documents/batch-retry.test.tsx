import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { describe, it } from "node:test"
import React from "react"
import { depositKey, depositSignature } from "../../src/components/hr-documents/Documents"
;(globalThis as {React?:typeof React}).React=React

// Données synthétiques uniquement. Nouvel essai d'un dépôt du lot après un échec (stockage, réseau, validation).
const src=()=>readFileSync("src/components/hr-documents/Documents.tsx","utf8")
const fields={category:"ID_CARD",period:"2026-11",title:"CNI synthétique"}

describe("dépôt groupé : nouvel essai après un échec",()=>{
  it("premier envoi : nouvelle clé",()=>{
    assert.equal(depositKey(undefined,depositSignature(fields),()=>"k-neuve"),"k-neuve")
  })
  it("mêmes champs : même clé, le serveur reconnaît l'envoi déjà reçu",()=>{
    const signature=depositSignature(fields)
    assert.equal(depositKey({key:"k-1",signature},signature,()=>"k-neuve"),"k-1")
    // Espaces autour du titre : le serveur les supprime, l'intention est la même.
    assert.equal(depositKey({key:"k-1",signature},depositSignature({...fields,title:"  CNI synthétique "}),()=>"k-neuve"),"k-1")
  })
  it("titre, catégorie ou période modifiés : nouvelle clé, jamais un conflit de reçu",()=>{
    const previous={key:"k-1",signature:depositSignature(fields)}
    for(const changed of [{...fields,title:"CNI corrigée"},{...fields,category:"PASSPORT"},{...fields,period:"2030-06"}])
      assert.equal(depositKey(previous,depositSignature(changed),()=>"k-neuve"),"k-neuve")
  })
  it("les champs restent modifiables après un échec et chaque envoi relit les valeurs affichées",()=>{
    const s=src()
    assert.doesNotMatch(s,/attempted/)
    assert.match(s,/<fieldset disabled=\{busy\|\|blocked\}/)
    assert.match(s,/<select className=\{control\} value=\{sharedCategory\} disabled=\{locked\} onChange/)
    assert.doesNotMatch(s,/requests\.push\(\{key,body:previous\}\)/)
  })
  it("stockage à remettre en état : action proposée aux seules personnes habilitées, contrôles laissés au serveur",()=>{
    const s=src()
    assert.match(s,/r\.state==="error"&&r\.code==="STORAGE_NOT_READY"/)
    assert.match(s,/\{props\.configure\s*\?<button/)
    assert.match(s,/body:JSON\.stringify\(\{action:"REASSOCIATE"\}\)\}\)\}\s*catch\(e\)\{if\(errorCode\(e\)!=="STORAGE_NOT_READY"\)throw e;await call\("\/api\/hr-documents\/storage",\{method:"POST"\}\)\}/)
    assert.match(s,/<ImportPanel configure=\{configure\}/)
  })
})
