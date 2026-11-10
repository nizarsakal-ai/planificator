import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { describe, it } from "node:test"
import React from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { createPreviewSession, PreviewBody, PREVIEW_MESSAGES, restoreFocus, type PreviewState } from "../../src/components/hr-documents/DocumentPreview"
import { PDF_CANVAS_MESSAGES } from "../../src/components/hr-documents/PdfCanvasPreview"
import { fetchHrDocument, HR_DOWNLOAD_MESSAGES, type HrDownload } from "../../src/lib/hr-documents/download-client"
;(globalThis as {React?:typeof React}).React=React

// Données synthétiques uniquement : aucun document ni salarié réel.
const pdf=():HrDownload=>({blob:new Blob([new TextEncoder().encode("%PDF-1.4 synthetic")],{type:"application/pdf"}),name:"document-2026-11.pdf",mime:"application/pdf"})
const heic=():HrDownload=>({blob:new Blob([new Uint8Array([0,0,0,24])],{type:"image/heic"}),name:"document-2026-11.heic",mime:"image/heic"})
function deferred<T>(){let resolve!:(v:T)=>void,reject!:(e:unknown)=>void;const promise=new Promise<T>((a,b)=>{resolve=a;reject=b});return {promise,resolve,reject}}
function harness(fetchDocument:(id:string)=>Promise<HrDownload>){
  const created:Blob[]=[],revoked:string[]=[],states:PreviewState[]=[],saved:{blob:Blob;name:string}[]=[]
  let n=0
  const session=createPreviewSession({fetchDocument,onChange:s=>states.push(s),urls:{create:b=>{created.push(b);return `blob:synthetic/${++n}`},revoke:u=>revoked.push(u)}})
  const save=(blob:Blob,name:string)=>{saved.push({blob,name})}
  return {session,created,revoked,states,saved,save}
}
const A={id:"doc-a",title:"Bulletin synthétique A"},B={id:"doc-b",title:"Bulletin synthétique B"}

describe("aperçu RH : fenêtre interne privée, téléchargement seulement sur action explicite",()=>{
  it("Visualiser charge le document une fois et l'affiche, sans aucun enregistrement automatique",async()=>{
    const calls:string[]=[];const h=harness(async id=>{calls.push(id);return pdf()})
    await h.session.open(A)
    assert.deepEqual(calls,["doc-a"])
    const s=h.session.state;assert.equal(s.status,"ready")
    // r1 : un PDF ne crée plus aucune URL blob ; ses octets validés sont rendus en canvas.
    assert.equal(h.created.length,0);assert.equal(s.status==="ready"&&s.url,null)
    assert.equal(s.status==="ready"&&s.pdf?.type,"application/pdf")
    assert.equal(h.saved.length,0)
    assert.deepEqual(h.states.map(s=>s.status),["loading","ready"])
  })
  it("double clic sur Visualiser (chargement ou affiché) : un seul appel réseau",async()=>{
    const d=deferred<HrDownload>();let calls=0;const h=harness(()=>{calls++;return d.promise})
    const first=h.session.open(A);void h.session.open(A)
    d.resolve(pdf());await first;await h.session.open(A)
    assert.equal(calls,1);assert.equal(h.created.length,0)
  })
  it("Fermer révoque l'URL blob, revient à l'état initial et n'autorise plus aucun téléchargement",async()=>{
    const h=harness(async()=>({...pdf(),mime:"image/png",name:"document-2026-10.png"}))
    await h.session.open(A);h.session.close()
    assert.deepEqual(h.revoked,["blob:synthetic/1"])
    assert.equal(h.session.state.status,"idle")
    assert.equal(h.session.download(h.save),false);assert.equal(h.saved.length,0)
  })
  it("changement de document : l'URL précédente est révoquée avant l'affichage suivant",async()=>{
    const h=harness(async id=>id===A.id?{...pdf(),mime:"image/jpeg",name:"document-2026-09.jpg"}:{...pdf(),mime:"image/png",name:"document-2026-10.png"})
    await h.session.open(A);await h.session.open(B)
    assert.deepEqual(h.revoked,["blob:synthetic/1"])
    const s=h.session.state;assert.equal(s.status,"ready");assert.equal(s.status==="ready"&&s.id,"doc-b")
    assert.equal(h.created[1].type,"image/png")
  })
  it("réponse tardive après fermeture ou après un autre document : ignorée, aucune URL créée",async()=>{
    const late=deferred<HrDownload>(),lateB=deferred<HrDownload>()
    const h=harness(id=>id===A.id?late.promise:lateB.promise)
    const a=h.session.open(A);h.session.close();late.resolve(pdf());await a
    assert.equal(h.created.length,0);assert.equal(h.session.state.status,"idle")
    const lateA2=deferred<HrDownload>(),h2=harness(id=>id===A.id?lateA2.promise:lateB.promise)
    const a2=h2.session.open(A),b2=h2.session.open(B);lateB.resolve(pdf());await b2;lateA2.resolve(pdf());await a2
    const s=h2.session.state;assert.equal(s.status==="ready"&&s.id,"doc-b");assert.equal(s.status==="ready"&&s.pdf!==null,true);assert.equal(h2.created.length,0)
    const failing=deferred<HrDownload>(),h3=harness(()=>failing.promise)
    const a3=h3.session.open(A);h3.session.close();failing.reject(new Error("tardif"));await a3
    assert.equal(h3.session.state.status,"idle")
  })
  it("Télécharger enregistre les octets déjà vérifiés, sous le nom de la route, uniquement sur action",async()=>{
    const doc=pdf();let calls=0;const h=harness(async()=>{calls++;return doc})
    assert.equal(h.session.download(h.save),false)
    await h.session.open(A)
    assert.equal(h.saved.length,0)
    assert.equal(h.session.download(h.save),true)
    assert.equal(h.saved.length,1);assert.equal(h.saved[0].blob,doc.blob);assert.equal(h.saved[0].name,"document-2026-11.pdf")
    assert.equal(calls,1)
  })
  it("HEIC non affichable : aucune URL d'aperçu, message clair, téléchargement toujours possible",async()=>{
    const h=harness(async()=>heic())
    await h.session.open(A)
    const s=h.session.state;assert.equal(s.status,"ready");assert.equal(s.status==="ready"&&s.url,null);assert.equal(s.status==="ready"&&s.pdf,null)
    assert.equal(h.created.length,0)
    assert.match(renderToStaticMarkup(<PreviewBody state={s}/>),/HEIC/)
    assert.equal(h.session.download(h.save),true);assert.equal(h.saved[0].name,"document-2026-11.heic")
    h.session.close();assert.deepEqual(h.revoked,[])
  })
  it("erreurs : page de connexion HTML, redirection, 409 JSON et réseau refusés par fetchHrDocument → message, rien d'affiché",async()=>{
    const html="<!doctype html><title>Connexion</title>"
    const cases:[()=>Promise<Response>,string][]=[
      [async()=>new Response(html,{status:200,headers:{"Content-Type":"text/html"}}),HR_DOWNLOAD_MESSAGES.session],
      [async()=>{const r=new Response(html,{status:200,headers:{"Content-Type":"text/html"}});Object.defineProperty(r,"redirected",{value:true});return r},HR_DOWNLOAD_MESSAGES.session],
      [async()=>new Response(JSON.stringify({error:"Le stockage RH n’est pas encore configuré.",code:"STORAGE_NOT_READY"}),{status:409,headers:{"Content-Type":"application/json"}}),"Le stockage RH n’est pas encore configuré."],
      [async()=>{throw new TypeError("Failed to fetch")},HR_DOWNLOAD_MESSAGES.network],
    ]
    for(const [respond,message] of cases){
      const urls:string[]=[]
      const h=harness(id=>fetchHrDocument(id,async(input)=>{urls.push(input);return respond()}))
      await h.session.open(A)
      const s=h.session.state;assert.equal(s.status,"error");assert.equal(s.status==="error"&&s.message,message)
      assert.equal(h.created.length,0);assert.equal(h.session.download(h.save),false)
      assert.deepEqual(urls,["/api/hr-documents/doc-a/download"])
      assert.match(renderToStaticMarkup(<PreviewBody state={s}/>),/role="alert"/)
    }
    const h=harness(async()=>{throw new Error("")})
    await h.session.open(A);const s=h.session.state;assert.equal(s.status==="error"&&s.message,PREVIEW_MESSAGES.unavailable)
  })
  it("rendu r1 : PDF en zone canvas titrée et défilable au clavier, jamais de cadre ni d'URL ; image avec texte alternatif",()=>{
    const base={id:"doc-a",title:"Bulletin synthétique A",name:"x"}
    const zone=renderToStaticMarkup(<PreviewBody state={{status:"ready",...base,url:null,pdf:pdf().blob,mime:"application/pdf"}}/>)
    assert.doesNotMatch(zone,/<iframe|<object|<embed|blob:|src=/)
    assert.match(zone,/role="region"/);assert.match(zone,/aria-label="Aperçu de Bulletin synthétique A"/);assert.match(zone,/tabindex="0"/)
    assert.ok(zone.includes(PDF_CANVAS_MESSAGES.loading),"chargement annoncé avant le rendu")
    const img=renderToStaticMarkup(<PreviewBody state={{status:"ready",...base,url:"blob:synthetic/2",pdf:null,mime:"image/jpeg"}}/>)
    assert.match(img,/<img[^>]*alt="Aperçu de Bulletin synthétique A"/)
    assert.match(renderToStaticMarkup(<PreviewBody state={{status:"loading",id:"doc-a",title:"t"}}/>),/role="status"/)
    assert.equal(renderToStaticMarkup(<PreviewBody state={{status:"idle"}}/>),"")
  })
  it("r1 : aucun chemin d'aperçu PDF ne dépend du lecteur du navigateur (navigateurs intégrés : plus d'aperçu blanc)",()=>{
    const src=readFileSync("src/components/hr-documents/DocumentPreview.tsx","utf8")
    assert.doesNotMatch(src,/<iframe|<object|<embed|pdfViewerEnabled|canShowPdfInline/)
    assert.match(src,/<PreviewBody state=\{state\}\/>/)
    assert.match(src,/<PdfCanvasPreview key=\{state\.id\} blob=\{state\.pdf\} title=\{state\.title\}\/>/)
    const canvas=readFileSync("src/components/hr-documents/PdfCanvasPreview.tsx","utf8")
    // PDF.js local de la dépendance existante, chargé à la demande ; aucune URL distante, aucun CDN, aucun worker externe.
    assert.match(canvas,/import\("unpdf\/pdfjs"\)/)
    assert.doesNotMatch(canvas,/https?:\/\/|workerSrc|cdn|createObjectURL|\.download\s*=/i)
    assert.doesNotMatch(canvas,/standardFontDataUrl|cMapUrl|wasmUrl/)
    // Les images ne dépendent pas du rendu PDF.
    assert.match(renderToStaticMarkup(<PreviewBody state={{status:"ready",id:"doc-a",title:"t",name:"x",url:"blob:synthetic/2",pdf:null,mime:"image/png"}}/>),/<img[^>]*src="blob:synthetic\/2"/)
  })
  it("focus rendu au bouton Visualiser mémorisé ; repli Radix si le bouton a disparu",()=>{
    let prevented=0,focused=0
    const event={preventDefault:()=>{prevented++}}
    const button={isConnected:true,focus:()=>{focused++}} as unknown as HTMLElement
    assert.equal(restoreFocus(event,button),true);assert.equal(prevented,1);assert.equal(focused,1)
    assert.equal(restoreFocus(event,{isConnected:false,focus:()=>{focused++}} as unknown as HTMLElement),false)
    assert.equal(restoreFocus(event,null),false);assert.equal(prevented,1);assert.equal(focused,1)
    const preview=readFileSync("src/components/hr-documents/DocumentPreview.tsx","utf8")
    assert.match(preview,/onCloseAutoFocus=\{event => \{ restoreFocus\(event, returnFocus\?\.current\) \}\}/)
    const page=readFileSync("src/components/hr-documents/Documents.tsx","utf8")
    assert.match(page,/onClick=\{e=>\{previewTrigger\.current=e\.currentTarget;/)
    assert.match(page,/returnFocus=\{previewTrigger\}/)
  })
  it("image non décodable : repli vers un message et Télécharger, jamais une image cassée seule ; libellé sans promesse absolue",()=>{
    const preview=readFileSync("src/components/hr-documents/DocumentPreview.tsx","utf8")
    assert.match(preview,/onError=\{\(\) => setFailed\(true\)\}/)
    assert.match(preview,/if \(failed\) return <p role="status" className=\{notice\}>\{PREVIEW_MESSAGES\.imageFailed\}<\/p>/)
    assert.match(preview,/Aucun téléchargement automatique|aucun téléchargement automatique/)
    assert.doesNotMatch(preview,/Rien n’est enregistré/)
  })
  it("droits et circuit inchangés : même route contrôlée, aucun lien public, lecteur externe ni nouvel onglet",()=>{
    const preview=readFileSync("src/components/hr-documents/DocumentPreview.tsx","utf8")
    assert.doesNotMatch(preview,/window\.open|target="_blank"|\/api\/hr-documents|href=|docs\.google|drive\.google|<embed|<object/)
    assert.match(preview,/fetchDocument = fetchHrDocument/)
    assert.match(preview,/useEffect\(\(\) => \(\) => session\.current\?\.close\(\), \[\]\)/)
    const page=readFileSync("src/components/hr-documents/Documents.tsx","utf8")
    // Visualiser n'apparaît que pour les statuts déjà téléchargeables et n'appelle aucune action métier.
    assert.match(page,/\{\["READY","REVIEWED","PUBLISHED"\]\.includes\(doc\.status\)&&<button[^>]*aria-haspopup="dialog" onClick=\{e=>\{previewTrigger\.current=e\.currentTarget;setError\(""\);setPreview\(/)
    const route=readFileSync("src/app/api/hr-documents/[id]/download/route.ts","utf8")
    assert.match(route,/hrService\(\)\.download\(await hrIdentity\(\)/);assert.match(route,/attachment; filename=/)
  })
})
