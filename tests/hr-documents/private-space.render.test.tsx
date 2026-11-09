import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { describe, it } from "node:test"
import React from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { attachableDocs, HrFolderView, statusLabel } from "../../src/components/hr-documents/EmployeeHrFolder"
import { MessageList, type ThreadMessage } from "../../src/components/hr-documents/HrMessages"
import { callJson, type FolderDoc } from "../../src/components/hr-documents/space-client"
import { canRead, employeeVisible, type Actor } from "../../src/lib/hr-documents/domain"
import { HR_DOWNLOAD_MESSAGES } from "../../src/lib/hr-documents/download-client"
;(globalThis as {React?:typeof React}).React=React

// Données synthétiques uniquement.
const doc=(o:Partial<FolderDoc>):FolderDoc=>({id:"d1",employeeId:"e-a",title:"Bulletin synthétique",period:"2026-11",category:"PAYSLIP",status:"PUBLISHED",version:3,size:2048,createdAt:"2026-11-08T10:00:00.000Z",...o})
const noop=()=>{}
/** Environnement complet (type ProcessEnv réel, NODE_ENV compris) avec le seul drapeau de l'espace privé fixé ou absent. */
const envWith=(flag?:string):NodeJS.ProcessEnv=>{const env={...process.env};if(flag===undefined)delete env.HR_DOCUMENT_PRIVATE_SPACE_ENABLED;else env.HR_DOCUMENT_PRIVATE_SPACE_ENABLED=flag;return env}
const view=(o:Partial<Parameters<typeof HrFolderView>[0]>)=>renderToStaticMarkup(<HrFolderView mode="hr" docs={[]} complete family={null} query="" view="grid" canAccept={false} busy={false}
  onFamily={noop} onQuery={noop} onView={noop} onPreview={noop} onDownload={noop} onAccept={noop} {...o}/>)

describe("espace privé RH : rendu et règles côté client (affichage seulement)",()=>{
  it("dossiers par famille avec compteurs ; compteurs marqués « chargés » tant qu'une page reste",()=>{
    const docs=[doc({}),doc({id:"d2",category:"CONTRACT",title:"Contrat synthétique"})]
    const full=view({docs});assert.match(full,/Paie/);assert.match(full,/Contrat/);assert.doesNotMatch(full,/chargés/)
    const partial=view({docs,complete:false});assert.match(partial,/2 chargés/);assert.match(partial,/Compteurs limités aux documents chargés/)
  })
  it("dossier vide et recherche sans résultat : messages explicites",()=>{
    assert.match(view({}),/Aucun document dans ce dossier/)
    assert.match(view({docs:[doc({})],query:"introuvable"}),/Aucun document ne correspond/)
  })
  it("actions : Visualiser et Télécharger séparés ; aucune action sur un dépôt en cours ou bloqué",()=>{
    const html=view({docs:[doc({}),doc({id:"d2",status:"RECEIVING",title:"En cours"}),doc({id:"d3",status:"BLOCKED",title:"Bloqué"})]})
    assert.equal((html.match(/>Visualiser</g)??[]).length,1);assert.equal((html.match(/>Télécharger</g)??[]).length,1)
    assert.match(html,/aria-haspopup="dialog"/)
  })
  it("suivi factuel côté RH : « ouvert le » seulement si le serveur l'a constaté ; jamais signature ni acceptation",()=>{
    assert.match(view({docs:[doc({openedAt:"2026-11-08T11:00:00.000Z"})]}),/Ouvert par le salarié le/)
    assert.match(view({docs:[doc({})]}),/Pas encore ouvert par le salarié/)
    const all=[...Object.values({a:statusLabel("hr","PUBLISHED"),b:statusLabel("hr","RECEIVED"),c:statusLabel("employee","PUBLISHED"),d:statusLabel("employee","RECEIVED")})].join(" ")
    assert.doesNotMatch(all,/sign|accept|remis légalement/i)
    assert.equal(statusLabel("employee","UNKNOWN_STATE"),"Statut inconnu")
  })
  it("pièce reçue : « Passer en vérification » seulement côté RH avec l'habilitation",()=>{
    const received=[doc({status:"RECEIVED",fromEmployee:true})]
    assert.match(view({docs:received,canAccept:true}),/Passer en vérification/)
    assert.doesNotMatch(view({docs:received,canAccept:false}),/Passer en vérification/)
    assert.doesNotMatch(view({docs:received,canAccept:true,mode:"employee"}),/Passer en vérification/)
    assert.match(view({docs:received}),/Transmis par le salarié/)
  })
  it("pièces jointes proposées : publiées ou dépôts suivis du salarié, jamais un dépôt bloqué, en cours ou un brouillon RH",()=>{
    const docs=[doc({id:"p"}),doc({id:"r",status:"RECEIVED",fromEmployee:true}),doc({id:"v",status:"READY",fromEmployee:true}),
      doc({id:"b",status:"BLOCKED",fromEmployee:true}),doc({id:"i",status:"RECEIVING",fromEmployee:true}),doc({id:"d",status:"READY"})]
    assert.deepEqual(attachableDocs(docs).map(d=>d.id),["p","r","v"])
  })
  it("v3 C2 : « Reprendre l'envoi » seulement côté salarié, sur son dépôt resté en cours",()=>{
    const pending=[doc({status:"RECEIVING",fromEmployee:true,title:"Envoi interrompu"})]
    assert.match(view({docs:pending,mode:"employee",onResume:noop}),/Reprendre l’envoi/)
    assert.doesNotMatch(view({docs:pending,mode:"employee"}),/Reprendre l’envoi/)
    assert.doesNotMatch(view({docs:pending,onResume:noop}),/Reprendre l’envoi/)
    assert.doesNotMatch(view({docs:[doc({status:"RECEIVING"})],mode:"employee",onResume:noop}),/Reprendre l’envoi/)
    assert.doesNotMatch(view({docs:pending,mode:"employee",onResume:noop}),/>Visualiser</)
  })
  it("v3 : changement d'employé, aucune donnée de l'ancien dossier (clé de remontage + remise à zéro ; contrôle du code)",()=>{
    assert.match(readFileSync("src/components/employes/EmployeeProfileTabs.tsx","utf8"),/<HrPrivateSpace key=\{employeeId\}/)
    assert.match(readFileSync("src/components/hr-documents/EmployeeHrFolder.tsx","utf8"),/useEffect\(\(\) => \{ setDocs\(\[\]\); setCursor\(null\); setPreview\(null\)/)
    assert.match(readFileSync("src/components/hr-documents/HrMessages.tsx","utf8"),/useEffect\(\(\) => \{ setMessages\(\[\]\); setCursor\(null\)/)
  })
  it("v3 C3 : règle de lecture, dépôt propre lisible seulement avec l'espace privé actif",()=>{
    const a:Actor={userId:"u-a",companyId:"c",employeeId:"e-a",capabilities:[]},hr:Actor={userId:"u-rh",companyId:"c",employeeId:null,capabilities:["READ"]}
    const own={companyId:"c",employeeId:"e-a",uploadedById:"u-a",uploadIntent:"submission:abc"}
    for(const status of ["RECEIVED","READY","REVIEWED"]){
      assert.equal(canRead(a,{...own,status},envWith("true")),true,status)
      assert.equal(canRead(a,{...own,status},envWith()),false,status)
      assert.equal(canRead(hr,{...own,status},envWith()),true,status)
    }
    assert.equal(canRead(a,{...own,status:"PUBLISHED"},envWith()),true)
  })
  it("présentation grille ou liste au clavier : boutons à état pressé",()=>{
    const html=view({docs:[doc({})],view:"list"})
    assert.match(html,/aria-pressed="true"[^>]*>Liste</);assert.match(html,/role="group" aria-label="Dossiers"/)
  })
  it("messages : texte jamais interprété comme HTML, demande de pièce, « lu » seulement constaté",()=>{
    const m=(o:Partial<ThreadMessage>):ThreadMessage=>({id:"m1",authorSide:"HR",kind:"MESSAGE",body:"<b>texte</b>",documentId:null,requestStatus:null,createdAt:"2026-11-08T10:00:00.000Z",readAt:null,mine:true,...o})
    const html=renderToStaticMarkup(<MessageList mode="hr" attachable={[]} onPreview={noop} messages={[m({}),m({id:"m2",kind:"REQUEST",requestStatus:"OPEN",mine:false,authorSide:"HR"})]}/>)
    assert.match(html,/&lt;b&gt;texte&lt;\/b&gt;/);assert.match(html,/Envoyé, pas encore lu/);assert.match(html,/Pièce à compléter/)
    const employee=renderToStaticMarkup(<MessageList mode="employee" attachable={[]} onPreview={noop} onAnswerRequest={noop} messages={[m({id:"m3",kind:"REQUEST",requestStatus:"OPEN",mine:false})]}/>)
    assert.match(employee,/Transmettre la pièce demandée/)
    assert.match(renderToStaticMarkup(<MessageList mode="hr" attachable={[]} onPreview={noop} messages={[m({readAt:"2026-11-08T12:00:00.000Z"})]}/>),/Lu le/)
  })
  it("callJson : page de connexion HTML ou redirection refusée, erreur JSON transmise, réseau signalé",async()=>{
    await assert.rejects(callJson("/x",undefined,async()=>new Response("<html>",{status:200,headers:{"Content-Type":"text/html"}})),{message:HR_DOWNLOAD_MESSAGES.session})
    await assert.rejects(callJson("/x",undefined,async()=>{const r=Response.json({});Object.defineProperty(r,"redirected",{value:true});return r}),{message:HR_DOWNLOAD_MESSAGES.session})
    await assert.rejects(callJson("/x",undefined,async()=>Response.json({error:"Accès non autorisé."},{status:403})),{message:"Accès non autorisé."})
    await assert.rejects(callJson("/x",undefined,async()=>{throw new TypeError("Failed to fetch")}),{message:HR_DOWNLOAD_MESSAGES.network})
  })
  it("règle serveur de lecture : brouillon RH jamais visible du salarié ; dépôt propre visible ; autre salarié jamais",()=>{
    const a:Actor={userId:"u-a",companyId:"c",employeeId:"e-a",capabilities:[]}
    const base={companyId:"c",employeeId:"e-a"},on=envWith("true")
    assert.equal(canRead(a,{...base,status:"PUBLISHED"},on),true)
    for(const status of ["UPLOADING","READY","REVIEWED","BLOCKED"])assert.equal(canRead(a,{...base,status,uploadedById:"u-rh",uploadIntent:"x"},on),false,status)
    assert.equal(canRead(a,{...base,status:"RECEIVED",uploadedById:"u-a",uploadIntent:"submission:abc"},on),true)
    assert.equal(canRead(a,{...base,status:"RECEIVED",uploadedById:"u-a",uploadIntent:"abc"},on),false,"sans marqueur de dépôt salarié")
    assert.equal(canRead(a,{...base,status:"BLOCKED",uploadedById:"u-a",uploadIntent:"submission:abc"},on),false)
    assert.equal(canRead(a,{companyId:"c",employeeId:"e-b",status:"PUBLISHED"},on),false)
    assert.equal(canRead(a,{companyId:"autre",employeeId:"e-a",status:"PUBLISHED"},on),false)
    assert.equal(employeeVisible({...base,status:"READY",uploadedById:"u-rh",uploadIntent:"x"},"e-a","u-a"),false)
  })
  it("confidentialité non déléguée au client : les composants ne filtrent pas par salarié et n'ouvrent ni lien public ni nouvel onglet",()=>{
    for(const f of ["src/components/hr-documents/EmployeeHrFolder.tsx","src/components/hr-documents/HrMessages.tsx","src/components/hr-documents/EmployeeSubmission.tsx"]){
      const src=readFileSync(f,"utf8")
      assert.doesNotMatch(src,/window\.open|target="_blank"|dangerouslySetInnerHTML|docs\.google|drive\.google/,f)
      assert.doesNotMatch(src,/\.filter\([^)]*employeeId/,f)
    }
    assert.doesNotMatch(readFileSync("src/components/hr-documents/EmployeeSubmission.tsx","utf8"),/employeeId/)
  })
})
