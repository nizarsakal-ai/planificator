import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { describe, it } from "node:test"
import React from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { DocumentFolders, documentMonth } from "../../src/components/hr-documents/DocumentFolders"
import { HrFolderView } from "../../src/components/hr-documents/EmployeeHrFolder"
import { ALL_CATEGORY_CODES, LEGACY_CATEGORIES } from "../../src/lib/hr-documents/catalog"
import type { FolderDoc } from "../../src/components/hr-documents/space-client"
;(globalThis as {React?:typeof React}).React=React

// Données synthétiques uniquement.
type Entry={id:string;category:string;period:string;title:string}
const entry=(id:string,category:string,period="2026-01"):Entry=>({id,category,period,title:`Titre ${id}`})
const FOLDERS=["Identité et administratif","Contrat et avenants","Bulletins de paie","Formations et CACES","Absences et congés","Suivi RH et départ"]
const render=(documents:Entry[])=>renderToStaticMarkup(<DocumentFolders documents={documents}
  renderDocument={(doc,month)=><li key={doc.id} data-doc={doc.id}>{month?`[${month}] `:""}{doc.title}</li>}/>)
/** Contenu de chaque sous-dossier, dans l'ordre d'affichage : libellé → identifiants des documents. */
function folders(html:string){
  const result=new Map<string,string[]>()
  for(const section of html.split("<section").slice(1)){
    const label=/<h3[^>]*>(?:<svg.*?<\/svg>)?([^<]+)<\/h3>/.exec(section)![1]
    result.set(label,[...section.matchAll(/data-doc="([^"]+)"/g)].map(m=>m[1]))
  }
  return result
}

describe("dossier RH d'un salarié : six sous-dossiers, bulletins par année puis par mois",()=>{
  it("les six sous-dossiers sont toujours présents, dans l'ordre validé, même vides",()=>{
    const empty=folders(render([]))
    assert.deepEqual([...empty.keys()],FOLDERS)
    assert.equal((render([]).match(/Aucun document affiché/g)??[]).length,6)
  })
  it("chaque catégorie du catalogue est rangée dans un seul sous-dossier attendu",()=>{
    const expected:Record<string,string>={PAYSLIP:"Bulletins de paie",CONTRACT:"Contrat et avenants",AMENDMENT:"Contrat et avenants",OTHER:"Suivi RH et départ",
      ID_CARD:"Identité et administratif",PASSPORT:"Identité et administratif",RESIDENCE_PERMIT:"Identité et administratif",DRIVING_LICENSE:"Identité et administratif",
      ID_PHOTO:"Identité et administratif",SOCIAL_SECURITY:"Identité et administratif",BANK_DETAILS:"Identité et administratif",PROOF_OF_ADDRESS:"Identité et administratif",
      HEALTH_INSURANCE:"Identité et administratif",MEDICAL_VISIT:"Identité et administratif",EMPLOYER_CERTIFICATE:"Suivi RH et départ",WORK_CERTIFICATE:"Suivi RH et départ",
      FINAL_SETTLEMENT:"Suivi RH et départ",LEAVE_DOCUMENT:"Absences et congés",HR_FOLLOWUP:"Suivi RH et départ",QUALIFICATION:"Formations et CACES"}
    // Le tableau attendu couvre exactement le catalogue : une catégorie ajoutée sans classement fait échouer ce test.
    assert.deepEqual(Object.keys(expected).sort(),[...ALL_CATEGORY_CODES].sort())
    const grouped=folders(render(ALL_CATEGORY_CODES.map(code=>entry(code,code))))
    for(const [code,folder] of Object.entries(expected)){
      assert.deepEqual([...grouped].filter(([,ids])=>ids.includes(code)).map(([label])=>label),[folder],code)
    }
  })
  it("documents historiques : les quatre codes d'origine et un code inconnu restent tous affichés, une seule fois",()=>{
    const docs=[...LEGACY_CATEGORIES.map(code=>entry(`legacy-${code}`,code,"2019-03")),entry("unknown","CODE_RETIRE","2018-12")]
    const grouped=folders(render(docs))
    assert.deepEqual([...grouped.values()].flat().sort(),docs.map(d=>d.id).sort())
    assert.deepEqual(grouped.get("Suivi RH et départ"),["legacy-OTHER","unknown"])
    assert.deepEqual(grouped.get("Bulletins de paie"),["legacy-PAYSLIP"])
    assert.deepEqual(grouped.get("Contrat et avenants"),["legacy-CONTRACT","legacy-AMENDMENT"])
  })
  it("bulletins : années décroissantes, mois décroissants dans l'année, libellé du mois en français, compteur par année",()=>{
    // Ordre d'arrivée volontairement mélangé, comme une pagination par identifiant.
    const html=render([entry("p-2025-11","PAYSLIP","2025-11"),entry("p-2026-02","PAYSLIP","2026-02"),entry("p-2024-01","PAYSLIP","2024-01"),
      entry("p-2026-04","PAYSLIP","2026-04"),entry("p-2025-12","PAYSLIP","2025-12"),entry("p-2026-03","PAYSLIP","2026-03"),entry("c1","CONTRACT","2026-04")])
    assert.deepEqual(folders(html).get("Bulletins de paie"),["p-2026-04","p-2026-03","p-2026-02","p-2025-12","p-2025-11","p-2024-01"])
    const years=[...html.matchAll(/<details([^>]*)><summary[^>]*>(?:<svg.*?<\/svg>)?(\d{4})<span[^>]*>(\d+) PDF<\/span>/g)].map(m=>[m[2],m[3],/\bopen\b/.test(m[1])])
    assert.deepEqual(years,[["2026","3",true],["2025","2",false],["2024","1",false]])
    assert.match(html,/\[Avril 2026\] Titre p-2026-04/);assert.match(html,/\[Décembre 2025\] Titre p-2025-12/);assert.match(html,/\[Janvier 2024\] Titre p-2024-01/)
    // Le mois n'est transmis qu'aux bulletins : un contrat garde son titre.
    assert.match(html,/data-doc="c1">Titre c1</)
  })
  it("deux bulletins du même mois restent distincts ; une période illisible n'est ni perdue ni datée à tort",()=>{
    const html=render([entry("a","PAYSLIP","2026-05"),entry("b","PAYSLIP","2026-05"),entry("x","PAYSLIP","période-inconnue")])
    assert.deepEqual([...folders(html).get("Bulletins de paie")!].sort(),["a","b","x"])
    assert.match(html,/Sans période/);assert.match(html,/2 PDF/)
    assert.equal(documentMonth("2026-13"),"2026-13");assert.equal(documentMonth("2026-08"),"Août 2026")
  })
  it("pagination : une page suivante complète les années sans dupliquer ni déplacer un document",()=>{
    const page1=[entry("p1","PAYSLIP","2026-01"),entry("p2","PAYSLIP","2024-06")]
    const page2=[entry("p3","PAYSLIP","2026-07"),entry("p4","PAYSLIP","2025-02"),entry("q1","QUALIFICATION","2025-02")]
    assert.deepEqual(folders(render(page1)).get("Bulletins de paie"),["p1","p2"])
    const all=folders(render([...page1,...page2]))
    assert.deepEqual(all.get("Bulletins de paie"),["p3","p1","p4","p2"]);assert.deepEqual(all.get("Formations et CACES"),["q1"])
  })
})

describe("espace salarié et dossier RH : mêmes sous-dossiers, actions et protections inchangées",()=>{
  const doc=(o:Partial<FolderDoc>):FolderDoc=>({id:"d1",employeeId:"e-a",title:"Bulletin synthétique",period:"2026-04",category:"PAYSLIP",status:"PUBLISHED",version:3,size:2048,createdAt:"2026-05-02T10:00:00.000Z",...o})
  const noop=()=>{}
  const view=(o:Partial<Parameters<typeof HrFolderView>[0]>)=>renderToStaticMarkup(<HrFolderView mode="employee" docs={[]} complete family={null} query="" view="grid" canAccept={false} busy={false}
    onFamily={noop} onQuery={noop} onView={noop} onPreview={noop} onDownload={noop} onAccept={noop} {...o}/>)
  it("vue grille : six sous-dossiers, bulletin titré par son mois, aperçu et téléchargement seulement si consultable",()=>{
    const html=view({docs:[doc({}),doc({id:"d2",status:"RECEIVING",title:"Envoi synthétique",category:"OTHER",fromEmployee:true})]})
    for(const label of FOLDERS)assert.match(html,new RegExp(label))
    assert.match(html,/Avril 2026/);assert.match(html,/Bulletin synthétique/)
    assert.equal((html.match(/>Visualiser</g)??[]).length,1);assert.equal((html.match(/>Télécharger</g)??[]).length,1)
  })
  it("vue liste : aucun regroupement, titre d'origine conservé",()=>{
    const html=view({docs:[doc({})],view:"list"})
    assert.doesNotMatch(html,/Bulletins de paie/);assert.doesNotMatch(html,/Avril 2026/);assert.match(html,/Bulletin synthétique/)
  })
  it("le lot ne touche ni le serveur ni les droits : aperçu et téléchargement passent toujours par fetchHrDocument",()=>{
    const page=readFileSync("src/components/hr-documents/Documents.tsx","utf8")
    assert.match(page,/const viewable = \["READY","REVIEWED","PUBLISHED"\]\.includes\(doc\.status\)/)
    assert.match(page,/async function downloadDocument\(id:string\)\{\s*const \{blob,name\}=await fetchHrDocument\(id\)/)
    assert.doesNotMatch(page,/href=\{?[`"']\/api\/hr-documents/)
    // Dépôt groupé : chaque fichier garde sa clé, et une reprise renvoie le corps déjà tenté (même clé, mêmes champs).
    assert.match(page,/const previous=attempts\.current\.get\(key\)\s*if\(previous\)\{requests\.push\(\{key,body:previous\}\);continue\}/)
    assert.match(page,/body\.set\("key",key\)/)
    // Le sélecteur de dossier ne propose pas une fiche à compléter : son dossier n'est pas ouvrable.
    assert.match(page,/employees\.filter\(e=>!e\.draft\)\.map\(e=><option/)
  })
})
