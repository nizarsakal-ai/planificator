import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { describe, it } from "node:test"
import React from "react"
import { batchRecipientCheck } from "../../src/components/hr-documents/Documents"
;(globalThis as {React?:typeof React}).React=React

// Données synthétiques uniquement. Dépôt groupé depuis le dossier d'un salarié : le destinataire est fixé par le dossier.
const proposal=(o:Partial<{candidates:{employeeId:string;level:"STRONG"|"PARTIAL";draft:boolean}[];proposedEmployeeId:string|null}>)=>({candidates:[],proposedEmployeeId:null,...o})
const src=()=>readFileSync("src/components/hr-documents/Documents.tsx","utf8")

describe("dépôt groupé : un fichier lu comme concernant un autre salarié bloque le lot",()=>{
  it("rapprochement fort vers un autre salarié → OTHER_EMPLOYEE ; vers le salarié du dossier → OK",()=>{
    assert.equal(batchRecipientCheck(proposal({candidates:[{employeeId:"e-autre",level:"STRONG",draft:false}],proposedEmployeeId:"e-autre"}),"e-dossier"),"OTHER_EMPLOYEE")
    assert.equal(batchRecipientCheck(proposal({candidates:[{employeeId:"e-dossier",level:"STRONG",draft:false}],proposedEmployeeId:"e-dossier"}),"e-dossier"),"OK")
  })
  it("homonymes et nom de famille seul : jamais de blocage, vérification humaine demandée",()=>{
    const twins=[{employeeId:"e-dossier",level:"STRONG" as const,draft:false},{employeeId:"e-autre",level:"STRONG" as const,draft:false}]
    assert.equal(batchRecipientCheck(proposal({candidates:twins}),"e-dossier"),"AMBIGUOUS")
    assert.equal(batchRecipientCheck(proposal({candidates:[{employeeId:"e-autre",level:"PARTIAL",draft:false}]}),"e-dossier"),"PARTIAL")
  })
  it("aucune lecture, ou rien de rapproché → OK",()=>{
    assert.equal(batchRecipientCheck(undefined,"e-dossier"),"OK")
    assert.equal(batchRecipientCheck(proposal({}),"e-dossier"),"OK")
  })
  it("le blocage est testé avant la construction de toute requête, et seulement pour les fichiers non encore tentés",()=>{
    const s=src(),guard=s.indexOf('dataset.importBlocked==="true"'),requests=s.indexOf("const requests:{key:string;body:FormData}[]=[]"),post=s.indexOf('await call("/api/hr-documents",{method:"POST",body})')
    assert.ok(guard>0&&guard<requests&&requests<post,"garde avant les requêtes et le premier POST")
    assert.match(s,/pending\.some\(\(\{key\}\)=>!attempts\.current\.has\(key\)&&forms\.get\(key\)\?\.dataset\.importBlocked==="true"\)/)
    assert.match(s,/Aucun fichier n’a été envoyé\./)
  })
  it("fichier bloqué : avertissement par fichier, champs gelés, retrait possible ; attribut posé sur le formulaire du fichier",()=>{
    const s=src()
    assert.match(s,/data-import-blocked=\{blocked\?"true":undefined\}/)
    assert.match(s,/<fieldset disabled=\{busy\|\|attempted\|\|blocked\}/)
    assert.match(s,/un autre salarié que celui de ce dossier\. Ce fichier ne peut pas être déposé ici et bloque le dépôt du lot/)
    assert.match(s,/Retirer ce fichier du lot/)
  })
  it("titre privé du lot : nom du fichier, jamais la proposition de la lecture ; hors dossier, la proposition reste",()=>{
    assert.match(src(),/title:batch\?file\.name\.replace\(\/\\\.\[\^\.\]\+\$\/,""\)\.slice\(0,120\):p\?\.title\?\?undefined/)
  })
  it("textes du lot cohérents avec un destinataire fixé ; textes « choisissez le salarié » réservés au dépôt unitaire",()=>{
    const s=src()
    assert.match(s,/\{!batch&&p&&strong\.length>1&&<p[^>]*>Plusieurs salariés portent ce nom : choisissez explicitement le bon salarié\./)
    assert.match(s,/\{!batch&&p&&!strong\.length&&p\.candidates\.length>0&&<p[^>]*>Nom de famille seulement reconnu : vérifiez le salarié\./)
    assert.match(s,/Le destinataire reste le salarié de ce dossier : vérifiez sur la pièce qu’elle le concerne avant de confirmer\./)
  })
})
