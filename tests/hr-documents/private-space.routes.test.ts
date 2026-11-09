import { after,before,describe,it,mock } from "node:test"
import assert from "node:assert/strict"

// Gardes HTTP des nouvelles routes de l'espace privé : drapeau d'abord (404 sans authentification), origine exigée,
// sélecteurs répétés refusés, aucun champ employeeId accepté au dépôt salarié. Aucune base ni Google touchés.
let authCalls=0
type Route=(request:Request,context:{params:Promise<{id:string}>})=>Promise<Response>
const routes:{name:string;handler:Route;method:string;url:string}[]=[]
const saved={docs:process.env.HR_DOCUMENTS_ENABLED,portal:process.env.HR_DOCUMENT_EMPLOYEE_PORTAL_ENABLED,space:process.env.HR_DOCUMENT_PRIVATE_SPACE_ENABLED}
const restore=(k:string,v:string|undefined)=>{if(v===undefined)delete process.env[k];else process.env[k]=v}
before(async()=>{
  mock.module("@/auth",{namedExports:{auth:async()=>{authCalls++;return {user:{id:"synthetic-user",companyId:"synthetic-company"}}}}})
  const messages=await import("../../src/app/api/hr-documents/messages/route")
  const submissions=await import("../../src/app/api/hr-documents/submissions/route")
  const accept=await import("../../src/app/api/hr-documents/[id]/accept/route")
  const resume=await import("../../src/app/api/hr-documents/submissions/[id]/resume/route")
  routes.push({name:"thread",handler:messages.GET,method:"GET",url:"https://app.example.test/api/hr-documents/messages"},
    {name:"post",handler:messages.POST,method:"POST",url:"https://app.example.test/api/hr-documents/messages"},
    {name:"submit",handler:submissions.POST,method:"POST",url:"https://app.example.test/api/hr-documents/submissions"},
    {name:"accept",handler:accept.POST,method:"POST",url:"https://app.example.test/api/hr-documents/synthetic-id/accept"},
    {name:"resume",handler:resume.POST,method:"POST",url:"https://app.example.test/api/hr-documents/submissions/synthetic-id/resume"})
})
after(()=>{restore("HR_DOCUMENTS_ENABLED",saved.docs);restore("HR_DOCUMENT_EMPLOYEE_PORTAL_ENABLED",saved.portal);restore("HR_DOCUMENT_PRIVATE_SPACE_ENABLED",saved.space)})
const call=(r:typeof routes[number],init:RequestInit={},url=r.url)=>r.handler(new Request(url,{method:r.method,...init}),{params:Promise.resolve({id:"synthetic-id"})})

describe("espace privé RH : gardes des routes",()=>{
  it("drapeau de l'espace privé absent : 404 privé, avant toute authentification, même avec le module RH actif",async()=>{
    process.env.HR_DOCUMENTS_ENABLED="true";process.env.HR_DOCUMENT_EMPLOYEE_PORTAL_ENABLED="true";delete process.env.HR_DOCUMENT_PRIVATE_SPACE_ENABLED
    authCalls=0
    for(const r of routes){const res=await call(r);assert.equal(res.status,404,r.name);assert.match(res.headers.get("cache-control")!,/no-store/)}
    assert.equal(authCalls,0)
  })
  it("module RH absent : 404 aussi",async()=>{
    delete process.env.HR_DOCUMENTS_ENABLED;process.env.HR_DOCUMENT_PRIVATE_SPACE_ENABLED="true"
    for(const r of routes)assert.equal((await call(r)).status,404,r.name)
  })
  it("mutations sans Origin : 403 sans toucher au stockage",async()=>{
    process.env.HR_DOCUMENTS_ENABLED="true";process.env.HR_DOCUMENT_EMPLOYEE_PORTAL_ENABLED="true";process.env.HR_DOCUMENT_PRIVATE_SPACE_ENABLED="true"
    for(const r of routes.filter(x=>x.method==="POST"))assert.equal((await call(r)).status,403,r.name)
  })
  it("sélecteurs répétés ou mal formés refusés avant la base",async()=>{
    process.env.HR_DOCUMENTS_ENABLED="true";process.env.HR_DOCUMENT_EMPLOYEE_PORTAL_ENABLED="true";process.env.HR_DOCUMENT_PRIVATE_SPACE_ENABLED="true"
    const thread=routes.find(r=>r.name==="thread")!
    for(const q of ["employeeId=a&employeeId=b","cursor=a&cursor=b"])assert.equal((await call(thread,{},`${thread.url}?${q}`)).status,400,q)
  })
  it("portail salarié absent : fil personnel et dépôt salarié indisponibles",async()=>{
    process.env.HR_DOCUMENTS_ENABLED="true";delete process.env.HR_DOCUMENT_EMPLOYEE_PORTAL_ENABLED;process.env.HR_DOCUMENT_PRIVATE_SPACE_ENABLED="true"
    for(const name of ["submit","resume"]){const r=routes.find(x=>x.name===name)!;assert.equal((await call(r,{headers:{origin:"https://app.example.test"}})).status,404,name)}
  })
  it("dépôt et reprise salarié : un champ employeeId (ou tout champ hors liste) est refusé 400 avant le service",async()=>{
    process.env.HR_DOCUMENTS_ENABLED="true";process.env.HR_DOCUMENT_EMPLOYEE_PORTAL_ENABLED="true";process.env.HR_DOCUMENT_PRIVATE_SPACE_ENABLED="true"
    const pdfFile=()=>new File(["%PDF-1.4\nsynthetic\n%%EOF\n"],"synthetic.pdf",{type:"application/pdf"})
    const post=(name:string,fields:Record<string,string>)=>{const form=new FormData();for(const [k,v] of Object.entries(fields))form.set(k,v);form.set("file",pdfFile())
      const r=routes.find(x=>x.name===name)!;return call(r,{headers:{origin:"https://app.example.test"},body:form})}
    const submit={category:"OTHER",period:"2026-11",title:"Synthetic",key:"00000000-0000-4000-8000-000000000000"}
    const extras:Record<string,string>[]=[{employeeId:"synthetic-other"},{companyId:"synthetic-other"}]
    for(const extra of extras){
      const res=await post("submit",{...submit,...extra});assert.equal(res.status,400,JSON.stringify(extra))
      const back=await post("resume",{expectedVersion:"1",...extra});assert.equal(back.status,400,JSON.stringify(extra))
    }
    const { readFileSync }=await import("node:fs")
    assert.match(readFileSync("src/app/api/hr-documents/submissions/route.ts","utf8"),/const allowed=\["category","period","title","key","requestId","file"\]/)
    assert.match(readFileSync("src/app/api/hr-documents/submissions/[id]/resume/route.ts","utf8"),/\["file","expectedVersion"\]/)
    const domain=readFileSync("src/lib/hr-documents/domain.ts","utf8")
    assert.match(domain,/export const submissionSchema = z\.object\(\{ category, period, title: [^}]+requestId: id\.optional\(\) \}\)\.strict\(\)/)
  })
})
