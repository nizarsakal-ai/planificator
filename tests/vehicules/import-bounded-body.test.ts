import { test } from "node:test"
import assert from "node:assert/strict"
import { readImportBoundedBody } from "../../src/lib/vehicules/import-bounded-body"
import { limitedJson, limitedImportForm } from "../../src/lib/vehicules/import-api"
import { estimateRoute } from "../../src/lib/vehicules/route-estimate-service"
function streamed(chunks:number[],length?:string){let cancelled=false;let reads=0;const body=new ReadableStream<Uint8Array>({pull(controller){const size=chunks[reads++];if(size===undefined)controller.close();else controller.enqueue(new Uint8Array(size))},cancel(){cancelled=true}});const headers=new Headers();if(length!==undefined)headers.set("Content-Length",length);return {input:{body,headers},cancelled:()=>cancelled,reads:()=>reads}}
test("absent length accepts bounded chunked and refuses oversized stream with cancellation",async()=>{const small=streamed([3,3]);assert.equal((await readImportBoundedBody(small.input,{maxBytes:6})).length,6);const large=streamed([4,4,4,4]);await assert.rejects(readImportBoundedBody(large.input,{maxBytes:6}),/PAYLOAD_LIMIT/);assert.equal(large.cancelled(),true);assert.ok(large.reads()<5)})
test("malformed, negative, NaN and huge declared lengths refused before accumulating body",async()=>{for(const header of ["-1","NaN","1.5","01","9007199254740992"]){const s=streamed([5,5],header);await assert.rejects(readImportBoundedBody(s.input,{maxBytes:100}),/CONTENT_LENGTH_INVALID/);assert.equal(s.cancelled(),true)}const s=streamed([5],"200");await assert.rejects(readImportBoundedBody(s.input,{maxBytes:100}),/PAYLOAD_LIMIT/);assert.equal(s.cancelled(),true)})
test("lying small or large Content-Length refused; too-small declaration stops immediately",async()=>{const larger=streamed([4,4,4],"3");await assert.rejects(readImportBoundedBody(larger.input,{maxBytes:20}),/CONTENT_LENGTH_MISMATCH/);assert.equal(larger.cancelled(),true);const smaller=streamed([3],"9");await assert.rejects(readImportBoundedBody(smaller.input,{maxBytes:20}),/CONTENT_LENGTH_MISMATCH/)})
test("reader deadline cancels stalled stream",async()=>{let cancelled=false;const body=new ReadableStream<Uint8Array>({pull(){return new Promise(()=>{})},cancel(){cancelled=true}});await assert.rejects(readImportBoundedBody({body,headers:new Headers()},{maxBytes:20,timeoutMs:10}),/BODY_TIMEOUT/);assert.equal(cancelled,true)})
test("JSON reader counts UTF8 bytes and chunked form parser has bounded source",async()=>{const body=JSON.stringify({text:"é".repeat(60000)});await assert.rejects(limitedJson(new Request("https://app.test",{method:"POST",body})),/PAYLOAD_LIMIT/);const form=new FormData();form.set("file",new File(["12 rue Paris 75001 Paris"],"source.txt",{type:"text/plain"}));const req=new Request("https://app.test",{method:"POST",body:form});const parsed=await limitedImportForm(req);assert.equal((parsed.get("file") as File).name,"source.txt")})
test("chunked provider response is bounded before JSON parse",async()=>{process.env.PLANIFICATOR_ROUTING_ENABLED="true";process.env.PLANIFICATOR_ROUTING_OSRM_URL="https://bounded-provider.example.test";let cancelled=false;const fake=async(_u:any,init:any)=>{assert.equal(init.redirect,"error");return new Response(new ReadableStream({pull(c){c.enqueue(new Uint8Array(60000))},cancel(){cancelled=true}}))};await assert.rejects(estimateRoute({coordinatesConfirmed:true,points:[{latitude:7,longitude:10},{latitude:8,longitude:11}]},fake as any),/ROUTING_RESPONSE_LIMIT/);assert.equal(cancelled,true);delete process.env.PLANIFICATOR_ROUTING_ENABLED;delete process.env.PLANIFICATOR_ROUTING_OSRM_URL})
test("upload and review deny unauthenticated and wrong-tenant callers without reading body",async()=>{
 const {handleImportUpload,handleImportReview}=await import("../../src/lib/vehicules/import-api")
 process.env.PLANIFICATOR_VEHICLES_V3_ENABLED="true"
 try{for(const wrongTenant of [false,true]){const deps={auth:async()=>wrongTenant?{user:{id:"actor",role:"ADMIN",companyId:"company"}}:null,db:{$transaction:async(fn:any)=>fn({$queryRaw:async()=>[]})}} as any
 for(const kind of ["upload","review"]){const request=new Request("https://app.test/api",{method:"POST",headers:{origin:"https://app.test","content-type":"application/json"},body:"this body must not be read"});const response=kind==="upload"?await handleImportUpload(request,"truck",deps):await handleImportReview(request,"truck","import",deps);assert.equal(response.status,wrongTenant?404:401);assert.equal(request.bodyUsed,false)}}}finally{delete process.env.PLANIFICATOR_VEHICLES_V3_ENABLED}
})
test("private source download rejects oversized chunked body and forbids redirects",async()=>{
 const {readImportSource}=await import("../../src/lib/vehicules/import-storage")
 const previous=[process.env.CLOUDINARY_CLOUD_NAME,process.env.CLOUDINARY_API_KEY,process.env.CLOUDINARY_API_SECRET]
 process.env.CLOUDINARY_CLOUD_NAME="fixture-cloud";process.env.CLOUDINARY_API_KEY="fixture-key";process.env.CLOUDINARY_API_SECRET="fixture-secret"
 let cancelled=false
 try{await assert.rejects(readImportSource(`vehicle-imports/${"a".repeat(24)}/${"b".repeat(24)}/00000000-0000-4000-8000-000000000000`,(async(_url:any,options:any)=>{assert.equal(options.redirect,"error");const signed=new URL(String(_url));assert.equal(signed.pathname.endsWith("/download"),true);assert.ok(Number(signed.searchParams.get("expires_at"))>Math.floor(Date.now()/1000));assert.ok(Number(signed.searchParams.get("expires_at"))<=Math.floor(Date.now()/1000)+300);assert.ok(signed.searchParams.get("signature"));return new Response(new ReadableStream({pull(c){c.enqueue(new Uint8Array(1048576))},cancel(){cancelled=true}}))}) as any),/SOURCE_SIZE_LIMIT/);assert.equal(cancelled,true)}finally{for(const [i,key] of ["CLOUDINARY_CLOUD_NAME","CLOUDINARY_API_KEY","CLOUDINARY_API_SECRET"].entries()){if(previous[i]===undefined)delete process.env[key];else process.env[key]=previous[i]}}
})

test("decoded provider responses use actual bytes while incoming encoded requests keep strict length checks",async()=>{
 const small=streamed([8],"3");small.input.headers.set("Content-Encoding","gzip")
 assert.equal((await readImportBoundedBody(small.input,{maxBytes:8,decodedContent:true})).length,8)
 const bomb=streamed([8,8,8,8],"3");bomb.input.headers.set("Content-Encoding","br")
 await assert.rejects(readImportBoundedBody(bomb.input,{maxBytes:10,decodedContent:true}),/PAYLOAD_LIMIT/);assert.equal(bomb.cancelled(),true)
 const incoming=streamed([8],"3");incoming.input.headers.set("Content-Encoding","gzip")
 await assert.rejects(readImportBoundedBody(incoming.input,{maxBytes:20}),/CONTENT_LENGTH_MISMATCH/)
 const identity=streamed([8],"3");identity.input.headers.set("Content-Encoding","identity")
 await assert.rejects(readImportBoundedBody(identity.input,{maxBytes:20,decodedContent:true}),/CONTENT_LENGTH_MISMATCH/)
})
test("signed document fetch ignores encoded wire length but verifies decoded size and SHA",async()=>{
 const {defaultFetchSigned,readVerifiedDocumentBytes}=await import("../../src/lib/vehicules/v3/document-service")
 const {createHash}=await import("node:crypto");const bytes=Buffer.from("%PDF-1.4 compressed-response-test")
 const original=globalThis.fetch
 try{globalThis.fetch=(async()=>new Response(bytes,{headers:{"Content-Encoding":"gzip","Content-Length":"12"}})) as typeof fetch
 const result=await defaultFetchSigned("https://storage.example.test/private");assert.equal(result.contentLength,null)
 const expected={sizeBytes:bytes.length,sha256:createHash("sha256").update(bytes).digest("hex")}
 assert.deepEqual(Buffer.from(await readVerifiedDocumentBytes(result,expected,1000)),bytes)
 const corrupted=await defaultFetchSigned("https://storage.example.test/private")
 await assert.rejects(readVerifiedDocumentBytes(corrupted,{...expected,sha256:"0".repeat(64)},1000),/DOCUMENT_FILE_INTEGRITY/)
 }finally{globalThis.fetch=original}
})
