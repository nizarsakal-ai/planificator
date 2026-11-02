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
