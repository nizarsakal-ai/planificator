import assert from "node:assert/strict"
import { test } from "node:test"
import { assertExpenseRequest, expenseGet, expensePost, costGet } from "../../src/lib/vehicules/v3/expense-api"
import type { ExpenseDeps } from "../../src/lib/vehicules/v3/expense-service"
const request = (headers: Record<string,string> = {}) => new Request("https://test.local/api/trucks/t/expenses", { method: "POST", headers: { Origin: "https://test.local", "Content-Type": "application/json", ...headers }, body: "{}" })
test("mutations enforce origin, fetch metadata and JSON", () => {
  assert.doesNotThrow(() => assertExpenseRequest(request()))
  const invalidOrigins:Record<string,string>[]=[{ Origin: "https://evil.test" }, { Origin: "null" }, { "Sec-Fetch-Site": "cross-site" }];for(const h of invalidOrigins) assert.throws(() => assertExpenseRequest(request(h)), /INVALID_ORIGIN/)
  assert.throws(() => assertExpenseRequest(request({ "Content-Type": "text/plain" })), /INVALID_CONTENT_TYPE/)
  assert.throws(() => assertExpenseRequest(request({ "Content-Length": "40000" })), /PAYLOAD_TOO_LARGE/)
})
test("disabled APIs neither authenticate nor access database, private responses", async () => {
  const previous = process.env.PLANIFICATOR_VEHICLES_V3_ENABLED; delete process.env.PLANIFICATOR_VEHICLES_V3_ENABLED
  const deps = { auth: async () => { throw new Error("must not authenticate") }, db: null } as unknown as ExpenseDeps
  try {
    for (const response of [await expenseGet(new Request("https://test.local/x"), "t", deps), await expensePost(request(), "t", deps), await costGet(new Request("https://test.local/x"), "t", deps)]) {
      assert.equal(response.status, 404); assert.equal(response.headers.get("Cache-Control"), "private, no-store"); assert.equal(response.headers.get("Vary"), "Cookie")
    }
  } finally { if (previous !== undefined) process.env.PLANIFICATOR_VEHICLES_V3_ENABLED = previous }
})
test("unauthenticated expense write does not consume its body", async()=>{
 const previous=process.env.PLANIFICATOR_VEHICLES_V3_ENABLED;process.env.PLANIFICATOR_VEHICLES_V3_ENABLED="true"
 const r=request();try{const response=await expensePost(r,"t",{auth:async()=>null,db:null} as unknown as ExpenseDeps);assert.equal(response.status,401);assert.equal(r.bodyUsed,false)}finally{if(previous===undefined)delete process.env.PLANIFICATOR_VEHICLES_V3_ENABLED;else process.env.PLANIFICATOR_VEHICLES_V3_ENABLED=previous}
})
function preflightDeps():ExpenseDeps{
 const tx={truck:{findFirst:async()=>({id:"t",companyId:"company",teamId:null,chauffeurId:null,active:true,archivedAt:null})},$queryRaw:async(strings:TemplateStringsArray)=>{const sql=strings.join("");if(sql.includes('FROM "users"'))return[{id:"actor",companyId:"company",role:"ADMIN",active:true,name:"Fixture"}];if(sql.includes('FROM "companies"'))return[{id:"company",active:true}];if(sql.includes('FROM "employees"'))return[];return[{id:"t"}]}}
 return {auth:async()=>({user:{id:"actor",role:"ADMIN",companyId:"company"}}),db:{$transaction:async(fn:any)=>fn(tx)}} as unknown as ExpenseDeps
}
test("preauthorized chunked oversized and lying declared lengths stop before parsing command",async()=>{
 const previous=process.env.PLANIFICATOR_VEHICLES_V3_ENABLED;process.env.PLANIFICATOR_VEHICLES_V3_ENABLED="true"
 try{const large=new Request("https://test.local/api",{method:"POST",headers:{Origin:"https://test.local","Content-Type":"application/json"},body:"x".repeat(40000)});assert.equal((await expensePost(large,"t",preflightDeps())).status,413)
 const mismatch=request({"Content-Length":"1"});assert.equal((await expensePost(mismatch,"t",preflightDeps())).status,400)
 for(const value of ["NaN","-1","01","9007199254740992"])assert.throws(()=>assertExpenseRequest(request({"Content-Length":value})),/PAYLOAD_TOO_LARGE/)
 }finally{if(previous===undefined)delete process.env.PLANIFICATOR_VEHICLES_V3_ENABLED;else process.env.PLANIFICATOR_VEHICLES_V3_ENABLED=previous}
})

test("expense origin uses real Host with internal localhost URL; foreign/forwarded hosts never bypass", () => {
 const make=(headers:Record<string,string>)=>new Request("http://localhost:3101/api/trucks/t/expenses",{method:"POST",headers:{host:"127.0.0.1:3101",origin:"http://127.0.0.1:3101","content-type":"application/json",...headers},body:"{}"})
 assert.doesNotThrow(()=>assertExpenseRequest(make({})))
 const invalidOrigins:Record<string,string>[]=[{origin:"http://localhost:3101"},{origin:"https://127.0.0.1:3101"},{origin:"http://evil.test"},{origin:"http://evil.test","x-forwarded-host":"evil.test","sec-fetch-site":"same-origin"},{"sec-fetch-site":"cross-site"},{host:"127.0.0.1:3101,evil.test"}];for(const headers of invalidOrigins) assert.throws(()=>assertExpenseRequest(make(headers)),/INVALID_ORIGIN/)
})
