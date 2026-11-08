import { describe,it } from "node:test"
import assert from "node:assert/strict"
import { GooglePrivateDrive,boundedBytes,verifiedDownload } from "../../src/lib/hr-documents/drive"
import type { DriveApiClient } from "../../src/lib/worksite-photos/drive/drive-api.client"
import { digest,HrError } from "../../src/lib/hr-documents/domain"
import { boundedJson,boundedForm,hrHttp } from "../../src/lib/hr-documents/http"
import { withHrDocumentNavItems,getNavItems } from "../../src/lib/navigation/nav-config"
import { groupNavItems } from "../../src/lib/navigation/nav-categories"

describe("RH transport, request and navigation boundaries",()=>{
  it("private ACL is checked through every page; inherited reader or public entry is denied",async()=>{
    let calls=0
    const api={getFile:async()=>({id:"root",name:"private",mimeType:"application/vnd.google-apps.folder",size:null,md5Checksum:null,trashed:false,parents:[]})} as unknown as DriveApiClient
    const drive=new GooglePrivateDrive("synthetic-token","storage@example.test",api,async()=>{
      calls++
      return Response.json(calls===1?{permissions:[{type:"user",role:"owner",emailAddress:"storage@example.test"}],nextPageToken:"page2"}:{permissions:[{type:"anyone",role:"reader"}]})
    })
    await assert.rejects(drive.checkPrivate("root"),/DRIVE_PRIVATE_REQUIRED/);assert.equal(calls,2)
  })
  it("private owner ACL admitted, missing ACL and wrong owner refused",async()=>{
    const api={getFile:async()=>({id:"root",name:"private",mimeType:"application/vnd.google-apps.folder",size:null,md5Checksum:null,trashed:false,parents:[]})} as unknown as DriveApiClient
    for(const [permissions,allowed] of [[[{type:"user",role:"owner",emailAddress:"storage@example.test"}],true],[[],false],[[{type:"user",role:"owner",emailAddress:"other@example.test"}],false]] as const){
      const drive=new GooglePrivateDrive("synthetic","storage@example.test",api,async()=>Response.json({permissions}))
      if(allowed)await drive.checkPrivate("root");else await assert.rejects(drive.checkPrivate("root"),/DRIVE_PRIVATE_REQUIRED/)
    }
  })
  it("byte limits cancel a stream instead of allocating unbounded bodies",async()=>{
    let cancelled=false
    const stream=new ReadableStream<Uint8Array>({start(c){c.enqueue(new Uint8Array(100))},cancel(){cancelled=true}})
    await assert.rejects(boundedBytes(stream,10),/INVALID_PDF/);assert.ok(cancelled)
  })
  it("file mutation between metadata checks and bytes cannot escape integrity validation",async()=>{
    const bytes=Buffer.from("%PDF-1.4\noriginal\n%%EOF")
    const drive={allocate:async()=>"id",createRoot:async()=>{},put:async()=>{},checkPrivate:async()=>{},read:async()=>Buffer.from("%PDF-1.4\nreplaced\n%%EOF")}
    await assert.rejects(verifiedDownload(drive,{driveFileId:"id",rootId:"root",sha256:digest(bytes),size:bytes.length}),/CONTENT_CHANGED/)
  })
  it("cross-origin mutations rejected and malformed/oversized JSON fails safely",async()=>{
    await assert.rejects(boundedJson(new Request("https://app.example.test/api/hr-documents",{method:"POST",headers:{origin:"https://evil.example.test"},body:"{}"})))
    await assert.rejects(boundedJson(new Request("https://app.example.test/api/hr-documents",{method:"POST",headers:{origin:"https://app.example.test"},body:"x"})),/INVALID_INPUT/)
    await assert.rejects(boundedJson(new Request("https://app.example.test/api/hr-documents",{method:"POST",headers:{origin:"https://app.example.test"},body:" ".repeat(17000)})),/INVALID_PDF/)
  })
  it("form parser accepts a bounded browser multipart request with explicit origin",async()=>{
    const form=new FormData();form.set("title","Synthetic document");form.set("file",new File(["%PDF-1.4\n%%EOF"],"synthetic.pdf",{type:"application/pdf"}))
    const request=new Request("https://app.example.test/api/hr-documents",{method:"POST",headers:{origin:"https://app.example.test"},body:form})
    assert.equal((await boundedForm(request)).get("title"),"Synthetic document")
  })
  it("private errors do not reflect raw provider or SQL data and always prohibit cache",async()=>{
    const response=await hrHttp(async()=>{throw new Error("secret provider token and HR payload")})
    assert.equal(response.status,503);assert.match(response.headers.get("cache-control")!,/no-store/)
    assert.doesNotMatch(await response.text(),/secret|token|payload/)
    const denial=await hrHttp(async()=>{throw new HrError("NOT_FOUND",404)})
    assert.equal(denial.status,404);assert.match(denial.headers.get("cache-control")!,/no-store/)
  })
  it("no new navigation with false capabilities; own and operator links grouped in RH once",()=>{
    const original=getNavItems("EMPLOYEE")
    assert.deepEqual(withHrDocumentNavItems(original,false,false),original)
    const links=withHrDocumentNavItems(withHrDocumentNavItems(original,true,true),true,true)
    assert.equal(links.filter(x=>x.href==="/mes-documents").length,1)
    const rh=groupNavItems(links).categories.find(x=>x.id==="rh")!
    assert.ok(rh.items.some(x=>x.href==="/mes-documents"));assert.ok(rh.items.some(x=>x.href==="/rh/documents"))
  })
})

describe("STORAGE_NOT_READY : motif journalisé sans valeur, réponse inchangée",()=>{
  it("le motif fixe est journalisé côté serveur et n'apparaît jamais dans la réponse",async()=>{
    const original=console.warn,seen:unknown[][]=[]
    console.warn=(...args:unknown[])=>{seen.push(args)}
    try{
      const response=await hrHttp(async()=>{throw new HrError("STORAGE_NOT_READY",409,"connexion_drive_non_active")})
      assert.equal(response.status,409)
      const body=await response.json() as Record<string,unknown>
      assert.deepEqual(Object.keys(body).sort(),["code","error"]);assert.equal(body.code,"STORAGE_NOT_READY")
      assert.equal(body.error,"Le stockage RH n’est pas encore configuré.")
      assert.deepEqual(seen,[["[hr-documents] STORAGE_NOT_READY",{reason:"connexion_drive_non_active"}]])
      seen.length=0
      await hrHttp(async()=>{throw new HrError("STORAGE_NOT_READY",409)})
      assert.deepEqual(seen,[["[hr-documents] STORAGE_NOT_READY",{reason:"non_precise"}]])
      seen.length=0
      await hrHttp(async()=>{throw new HrError("NOT_FOUND",404)})
      assert.deepEqual(seen,[])
    }finally{console.warn=original}
  })
  it("chaque levée de STORAGE_NOT_READY porte un motif fixe ; le transport distingue connexion inactive et compte différent",async()=>{
    const { readFileSync }=await import("node:fs")
    for(const f of ["src/lib/hr-documents/runtime.ts","src/lib/hr-documents/service.ts","src/lib/hr-documents/notification.ts"]){
      const src=readFileSync(f,"utf8")
      assert.doesNotMatch(src,/HrError\("STORAGE_NOT_READY",409\)/,f)
    }
    const runtime=readFileSync("src/lib/hr-documents/runtime.ts","utf8")
    assert.match(runtime,/connection\.status!=="ACTIVE"\)throw new HrError\("STORAGE_NOT_READY",409,"connexion_drive_non_active"\)/)
    const service=readFileSync("src/lib/hr-documents/service.ts","utf8")
    assert.match(service,/binding\.generation!==storage\.connectionGeneration\) throw new HrError\("STORAGE_NOT_READY",409,"generation_differente"\)/)
  })
  it("le téléchargement passe par fetch : aucune navigation directe vers la route de téléchargement",async()=>{
    const { readFileSync }=await import("node:fs")
    const src=readFileSync("src/components/hr-documents/Documents.tsx","utf8")
    assert.doesNotMatch(src,/href=\{`\/api\/hr-documents\/\$\{doc\.id\}\/download`\}/)
    assert.match(src,/const \{blob,name\}=await fetchHrDocument\(id\)/)
    assert.match(src,/onClick=\{\(\)=>\{setError\(""\);void downloadDocument\(doc\.id\)/)
  })
})

describe("téléchargement RH côté navigateur : seul un document validé est enregistré",()=>{
  type Init=RequestInit|undefined
  const respond=(body:BodyInit|null,init:ResponseInit&{redirected?:boolean}={})=>{
    const response=new Response(body,init)
    if(init.redirected)Object.defineProperty(response,"redirected",{value:true})
    return response
  }
  const pdfBytes=new TextEncoder().encode("%PDF-1.4 synthetic")
  it("200 PDF : blob, nom de Content-Disposition, type ; URL encodée, sans cache, même origine",async()=>{
    const { fetchHrDocument }=await import("../../src/lib/hr-documents/download-client")
    const calls:Array<[string,Init]>=[]
    const out=await fetchHrDocument("doc 1/x",async(url,init)=>{calls.push([url,init]);return respond(pdfBytes,{status:200,headers:{"Content-Type":"application/pdf","Content-Disposition":'attachment; filename="synthetic.pdf"'}})})
    assert.equal(calls[0][0],"/api/hr-documents/doc%201%2Fx/download")
    assert.equal(calls[0][1]?.cache,"no-store");assert.equal(calls[0][1]?.credentials,"same-origin")
    assert.equal(out.name,"synthetic.pdf");assert.equal(out.mime,"application/pdf")
    assert.deepEqual(new Uint8Array(await out.blob.arrayBuffer()),pdfBytes)
  })
  it("200 image autorisée sans nom : extension déduite du type",async()=>{
    const { fetchHrDocument }=await import("../../src/lib/hr-documents/download-client")
    const out=await fetchHrDocument("d",async()=>respond(new Uint8Array([1,2]),{status:200,headers:{"Content-Type":"image/png"}}))
    assert.equal(out.name,"document.png");assert.equal(out.mime,"image/png")
  })
  it("409 JSON : message métier de la route, aucun fichier",async()=>{
    const { fetchHrDocument }=await import("../../src/lib/hr-documents/download-client")
    await assert.rejects(fetchHrDocument("d",async()=>respond(JSON.stringify({error:"Le stockage RH n’est pas encore configuré.",code:"STORAGE_NOT_READY"}),{status:409,headers:{"Content-Type":"application/json"}})),
      {message:"Le stockage RH n’est pas encore configuré."})
  })
  it("session expirée : 200 HTML redirigé, 200 HTML direct ou 403 non JSON → message de session, jamais document.pdf",async()=>{
    const { fetchHrDocument,HR_DOWNLOAD_MESSAGES }=await import("../../src/lib/hr-documents/download-client")
    const html="<!doctype html><title>Connexion</title>"
    await assert.rejects(fetchHrDocument("d",async()=>respond(html,{status:200,headers:{"Content-Type":"text/html; charset=utf-8"},redirected:true})),{message:HR_DOWNLOAD_MESSAGES.session})
    await assert.rejects(fetchHrDocument("d",async()=>respond(html,{status:200,headers:{"Content-Type":"text/html"}})),{message:HR_DOWNLOAD_MESSAGES.session})
    await assert.rejects(fetchHrDocument("d",async()=>respond("denied",{status:403,headers:{"Content-Type":"text/plain"}})),{message:HR_DOWNLOAD_MESSAGES.session})
  })
  it("200 de type inattendu (JSON, octets bruts, sans type) → refus, aucun fichier",async()=>{
    const { fetchHrDocument,HR_DOWNLOAD_MESSAGES }=await import("../../src/lib/hr-documents/download-client")
    for(const type of ["application/json","application/octet-stream",""]){
      await assert.rejects(fetchHrDocument("d",async()=>respond("x",{status:200,headers:type?{"Content-Type":type}:{}})),{message:HR_DOWNLOAD_MESSAGES.unexpected},type)
    }
  })
  it("échec réseau à l'appel ou pendant la lecture → message réseau",async()=>{
    const { fetchHrDocument,HR_DOWNLOAD_MESSAGES }=await import("../../src/lib/hr-documents/download-client")
    await assert.rejects(fetchHrDocument("d",async()=>{throw new TypeError("Failed to fetch")}),{message:HR_DOWNLOAD_MESSAGES.network})
    const broken=respond(pdfBytes,{status:200,headers:{"Content-Type":"application/pdf"}})
    Object.defineProperty(broken,"blob",{value:async()=>{throw new TypeError("network error")}})
    await assert.rejects(fetchHrDocument("d",async()=>broken),{message:HR_DOWNLOAD_MESSAGES.network})
  })
  it("erreur non JSON hors session → message générique ; JSON sans message → message générique",async()=>{
    const { fetchHrDocument,HR_DOWNLOAD_MESSAGES }=await import("../../src/lib/hr-documents/download-client")
    await assert.rejects(fetchHrDocument("d",async()=>respond("oops",{status:502,headers:{"Content-Type":"text/plain"}})),{message:HR_DOWNLOAD_MESSAGES.unavailable})
    await assert.rejects(fetchHrDocument("d",async()=>respond("{}",{status:503,headers:{"Content-Type":"application/json"}})),{message:HR_DOWNLOAD_MESSAGES.unavailable})
  })
  it("les types acceptés sont exactement ceux servis par la route (KIND_MIME) ; le module client n'importe rien de serveur",async()=>{
    const { HR_DOWNLOAD_MIME }=await import("../../src/lib/hr-documents/download-client")
    const { KIND_MIME }=await import("../../src/lib/hr-documents/domain")
    assert.deepEqual([...HR_DOWNLOAD_MIME].sort(),Object.values(KIND_MIME).sort())
    const { readFileSync }=await import("node:fs")
    assert.doesNotMatch(readFileSync("src/lib/hr-documents/download-client.ts","utf8"),/^import /m)
  })
})
