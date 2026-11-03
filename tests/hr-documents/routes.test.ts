import { before,after,describe,it,mock } from "node:test"
import assert from "node:assert/strict"

let authCalls=0
type Route=(request:Request,context:{params:Promise<{id:string}>})=>Promise<Response>
const routes:{name:string;handler:Route;method:string}[]=[]
const saved=process.env.HR_DOCUMENTS_ENABLED
const savedPortal=process.env.HR_DOCUMENT_EMPLOYEE_PORTAL_ENABLED
before(async()=>{
  mock.module("@/auth",{namedExports:{auth:async()=>{authCalls++;return {user:{id:"synthetic-user",companyId:"synthetic-company"}}}}})
  const list=await import("../../src/app/api/hr-documents/route")
  const employees=await import("../../src/app/api/hr-documents/employees/route")
  const storage=await import("../../src/app/api/hr-documents/storage/route")
  const download=await import("../../src/app/api/hr-documents/[id]/download/route")
  const publish=await import("../../src/app/api/hr-documents/[id]/publish/route")
  const review=await import("../../src/app/api/hr-documents/[id]/review/route")
  const notify=await import("../../src/app/api/hr-documents/[id]/notify/route")
  const edit=await import("../../src/app/api/hr-documents/[id]/edit/route")
  const recover=await import("../../src/app/api/hr-documents/[id]/recover/route")
  const recognize=await import("../../src/app/api/hr-documents/recognize/route")
  routes.push({name:"list",handler:list.GET,method:"GET"},{name:"import",handler:list.POST,method:"POST"},
    {name:"employees",handler:employees.GET,method:"GET"},{name:"storage",handler:storage.POST,method:"POST"},
    {name:"download",handler:download.GET,method:"GET"},{name:"publish",handler:publish.POST,method:"POST"},
    {name:"review",handler:review.POST,method:"POST"},{name:"notify",handler:notify.POST,method:"POST"},
    {name:"edit",handler:edit.POST,method:"POST"},{name:"recover",handler:recover.POST,method:"POST"},
    {name:"recognize",handler:recognize.POST,method:"POST"},{name:"employee-draft",handler:employees.POST,method:"POST"})
})
after(()=>{if(saved===undefined)delete process.env.HR_DOCUMENTS_ENABLED;else process.env.HR_DOCUMENTS_ENABLED=saved;if(savedPortal===undefined)delete process.env.HR_DOCUMENT_EMPLOYEE_PORTAL_ENABLED;else process.env.HR_DOCUMENT_EMPLOYEE_PORTAL_ENABLED=savedPortal})
describe("actual RH HTTP route guards",()=>{
  it("all routes fail closed with flag absent, before auth or database/Google/email",async()=>{
    delete process.env.HR_DOCUMENTS_ENABLED
    for(const route of routes){
      const response=await route.handler(new Request(`https://app.example.test/api/hr-documents/${route.name}`,{method:route.method}),{params:Promise.resolve({id:"synthetic-id"})})
      assert.equal(response.status,404,route.name);assert.match(response.headers.get("cache-control")!,/no-store/)
    }
    assert.equal(authCalls,0)
  })
  it("enabled mutation routes reject absent Origin without touching storage",async()=>{
    process.env.HR_DOCUMENTS_ENABLED="true"
    process.env.HR_DOCUMENT_EMPLOYEE_PORTAL_ENABLED="true"
    for(const route of routes.filter(r=>r.method==="POST")){
      const response=await route.handler(new Request(`https://app.example.test/api/hr-documents/${route.name}`,{method:"POST"}),{params:Promise.resolve({id:"synthetic-id"})})
      assert.equal(response.status,403,route.name)
    }
  })
  it("rejects malformed or repeated employee selectors before querying the database",async()=>{
    process.env.HR_DOCUMENTS_ENABLED="true";process.env.HR_DOCUMENT_EMPLOYEE_PORTAL_ENABLED="true"
    const route=routes.find(r=>r.name==="list")!
    for(const query of ["employeeId=bad%2Fid","employeeId=a&employeeId=b","employeeId="]){
      const response=await route.handler(new Request(`https://app.example.test/api/hr-documents?manage=true&${query}`),{params:Promise.resolve({id:"synthetic-id"})})
      assert.equal(response.status,400);assert.match(response.headers.get("cache-control")!,/no-store/)
    }
  })
})
