import {test} from "node:test"
import assert from "node:assert/strict"
import {handleMaintenanceCorrectionPost} from "../../src/lib/vehicules/maintenance-api"
import {ADMIN,TRUCK,V3MemoryDb,MemoryDocumentStorage,key} from "./v3/v3-test-db"
const request=(origin:string,body:string)=>new Request("https://app.test/api",{method:"POST",headers:{origin,"Content-Type":"application/json","Idempotency-Key":key()},body})
test("maintenance correction checks origin and identity before body parsing, and bounds an authorized body",async()=>{
 const db=new V3MemoryDb(),deps=db.deps(ADMIN,new MemoryDocumentStorage())
 assert.equal((await handleMaintenanceCorrectionPost(request("https://evil.test","bad"),TRUCK,"maint-1",deps)).status,403)
 assert.equal((await handleMaintenanceCorrectionPost(request("https://app.test","bad"),TRUCK,"maint-1",{...deps,auth:async()=>null})).status,401)
 assert.equal((await handleMaintenanceCorrectionPost(request("https://app.test",'"'+"a".repeat(33000)+'"'),TRUCK,"maint-1",deps)).status,413)
})
