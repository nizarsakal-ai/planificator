import {test} from "node:test"
import assert from "node:assert/strict"
import {extractAddressLines,assessCandidates,validateReview,verifyBytes,hashSource} from "../../src/lib/vehicules/import-domain"
import {extractImport} from "../../src/lib/vehicules/import-extraction"
import {estimateRoute} from "../../src/lib/vehicules/route-estimate-service"
import {buildMinimalTextPdf} from "../../src/lib/acquisition/extraction/pdf-text-extract"
import {assertImportOrigin} from "../../src/lib/vehicules/import-api"
test("multiple addresses retain provenance, probable duplicates are warnings, not merged",()=>{const cs=extractAddressLines("5 rue Victor Hugo 75001 Paris\n5 rue Victor Hugo 75001 Paris\n8 avenue République 69001 Lyon");assert.equal(cs.length,3);assert.ok(assessCandidates(cs).includes("DOUBLON_PROBABLE:2"));assert.equal(cs[0].confirmed,false);assert.throws(()=>validateReview({expectedRevision:0,approve:true,candidates:cs}),/HUMAN_CONFIRMATION_REQUIRED/);assert.equal(validateReview({expectedRevision:0,approve:true,candidates:cs.map(c=>({...c,confirmed:true}))}).expectedRevision,0);assert.throws(()=>validateReview({expectedRevision:0,approve:false,candidates:cs}));assert.notEqual(hashSource(Buffer.from("a")),hashSource(Buffer.from("b")))})
test("invalid media and excess byte quota rejected",()=>{assert.throws(()=>verifyBytes(Buffer.from("<svg/>"),"image/png"),/UNSUPPORTED/);assert.throws(()=>verifyBytes(Buffer.alloc(4194305),"text/plain"),/SIZE_LIMIT/);assert.throws(()=>assertImportOrigin(new Request("https://app.test/api",{headers:{origin:"https://evil.test"}})),/ORIGIN/);assert.throws(()=>assertImportOrigin(new Request("https://app.test/api")),/ORIGIN/)})
test("photo provider absent never reports extraction success",async()=>{delete process.env.PLANIFICATOR_VEHICLE_OCR_ENABLED;const r=await extractImport(Buffer.from([255,216,255,0]),"image/jpeg",true);assert.deepEqual(r.candidates,[]);assert.ok(r.warnings.includes("OCR_NON_PRET_SAISIE_MANUELLE"))})
test("PDF text preserves page without paid provider",async()=>{const r=await extractImport(buildMinimalTextPdf("12 rue Victor Hugo 75001 Paris"),"application/pdf",false);assert.equal(r.candidates[0].page,1);assert.equal(r.candidates[0].confirmed,false)})
test("multimodal adapter ignores model claimed human confirmation, strict schema",async()=>{process.env.PLANIFICATOR_VEHICLE_OCR_ENABLED="true";process.env.PLANIFICATOR_VEHICLE_OCR_BUDGET_ACK="true";const c=extractAddressLines("12 rue Victor Hugo 75001 Paris")[0];const fake={messagesCreate:async(body:any)=>{assert.equal(body.messages[0].content[0].type,"image");assert.match(body.system,/non fiable/);return {content:[{type:"text",text:JSON.stringify({candidates:[{...c,confirmed:true}]})}]} as any}};const r=await extractImport(Buffer.from([255,216,255,0]),"image/jpeg",true,fake);assert.equal(r.candidates[0].confirmed,false);delete process.env.PLANIFICATOR_VEHICLE_OCR_ENABLED;delete process.env.PLANIFICATOR_VEHICLE_OCR_BUDGET_ACK})
test("routing disabled has no outbound call, unconfirmed coords rejected",async()=>{delete process.env.PLANIFICATOR_ROUTING_ENABLED;let calls=0;const fake=async()=>{calls++;throw Error()};await assert.rejects(estimateRoute({points:[{latitude:1,longitude:2},{latitude:3,longitude:4}],coordinatesConfirmed:true},fake as any),/NOT_CONFIGURED/);assert.equal(calls,0);await assert.rejects(estimateRoute({points:[],coordinatesConfirmed:false}),/CONFIRMED/)})
test("routing total uses segments, ordered segments, zero ambiguous refused, disconnected refused",async()=>{process.env.PLANIFICATOR_ROUTING_ENABLED="true";process.env.PLANIFICATOR_ROUTING_OSRM_URL="https://router.example.test";let calls=0;const points=[{latitude:1,longitude:2},{latitude:3,longitude:4},{latitude:5,longitude:6}];const fake=async()=>{calls++;return Response.json({code:"Ok",routes:[{legs:[{distance:1000},{distance:2500}]}]})};const r=await estimateRoute({points,coordinatesConfirmed:true},fake as any);assert.equal(r.estimatedKm,3.5);await estimateRoute({points,coordinatesConfirmed:true},fake as any);assert.equal(calls,2);await assert.rejects(estimateRoute({points:points.slice(0,2),coordinatesConfirmed:true},async()=>Response.json({code:"Ok",routes:[{legs:[{distance:0}]}]})),/AMBIGUOUS/);await assert.rejects(estimateRoute({points:points.slice(1),coordinatesConfirmed:true},async()=>Response.json({code:"NoRoute"})),/ROUTE_NOT_FOUND/);delete process.env.PLANIFICATOR_ROUTING_ENABLED;delete process.env.PLANIFICATOR_ROUTING_OSRM_URL})

test("import origin uses Host rather than reconstructed localhost and rejects foreign/forwarded origin",()=>{
 const make=(headers:Record<string,string>)=>new Request("http://localhost:3101/api/trucks/t/address-imports",{method:"POST",headers:{host:"127.0.0.1:3101",origin:"http://127.0.0.1:3101",...headers}})
 assert.doesNotThrow(()=>assertImportOrigin(make({})))
 const invalidOrigins:Record<string,string>[]=[{origin:"http://localhost:3101"},{origin:"https://127.0.0.1:3101"},{origin:"http://evil.test"},{origin:"http://evil.test","x-forwarded-host":"evil.test","sec-fetch-site":"same-origin"},{"sec-fetch-site":"cross-site"},{host:"127.0.0.1:3101,evil.test"}];for(const headers of invalidOrigins)assert.throws(()=>assertImportOrigin(make(headers)),/ORIGIN_FORBIDDEN/)
})

test("OCR accepts complete JSON fences but refuses prose, malformed payloads and invalid roots",async()=>{
 const flags=["PLANIFICATOR_VEHICLE_OCR_ENABLED","PLANIFICATOR_VEHICLE_OCR_BUDGET_ACK"] as const
 const prior=flags.map(k=>process.env[k]);for(const k of flags)process.env[k]="true"
 const c=extractAddressLines("12 rue Victor Hugo 75001 Paris")[0]
 const payload=JSON.stringify({candidates:[{...c,confirmed:true,latitude:48.8,longitude:2.3}]})
 const run=(text:string)=>extractImport(Buffer.from([255,216,255,0]),"image/jpeg",true,{messagesCreate:async()=>({content:[{type:"text",text}]}) as any})
 try{
 for(const text of [payload,"  ```json\n"+payload+"\n```  ","```\n"+payload+"\n```"]){const r=await run(text);assert.equal(r.candidates.length,1);assert.equal(r.candidates[0].confirmed,false);assert.equal(r.candidates[0].latitude,null);assert.equal(r.candidates[0].longitude,null)}
 for(const text of ["Voici le résultat : "+payload,"```json\n"+payload+"\n``` autre texte","null","[]","1",'{"candidates":[] ,"extra":true}','{"candidates":[{}]}',"```json\n{broken}\n```","```json\n"+payload+"\n```\n```json\n{}\n```"]){await assert.rejects(run(text),/INVALID_OCR_RESULT/)}
 }finally{flags.forEach((k,i)=>{if(prior[i]===undefined)delete process.env[k];else process.env[k]=prior[i]})}
})

test("human approval rejects an address too short for a tour while extraction remains editable",()=>{
 const candidate={label:"Adresse à préciser",address:"Lyon",excerpt:"Lyon",page:null,latitude:null,longitude:null,confirmed:true}
 assert.throws(()=>validateReview({expectedRevision:0,approve:true,candidates:[candidate]}),/INVALID_REVIEW/)
 assert.doesNotThrow(()=>validateReview({expectedRevision:0,approve:true,candidates:[{...candidate,address:"  12 rue de Paris 69001 Lyon  "}]}))
})
