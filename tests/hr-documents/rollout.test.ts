import {before,after,describe,it,mock} from "node:test"
import assert from "node:assert/strict"

const keys=["HR_DOCUMENTS_ENABLED","HR_DOCUMENT_EMPLOYEE_PORTAL_ENABLED","HR_DOCUMENT_OPERATORS"] as const
const original=Object.fromEntries(keys.map(k=>[k,process.env[k]]))
let identity={id:"synthetic-operator",companyId:"synthetic-company",role:"EMPLOYEE"}
let runtime:typeof import("../../src/lib/hr-documents/runtime")
before(async()=>{
  mock.module("@/auth",{namedExports:{auth:async()=>({user:identity})}})
  mock.module("next/navigation",{namedExports:{notFound:()=>{throw new Error("PAGE_NOT_FOUND")}}})
  runtime=await import("../../src/lib/hr-documents/runtime")
})
after(()=>{for(const k of keys){if(original[k]===undefined)delete process.env[k];else process.env[k]=original[k]}})
describe("operator-only RH rollout, before any database or provider call",()=>{
  it("portal absent/false is closed even for ADMIN and SUPER_ADMIN without explicit grants",async()=>{
    process.env.HR_DOCUMENTS_ENABLED="true";delete process.env.HR_DOCUMENT_EMPLOYEE_PORTAL_ENABLED;delete process.env.HR_DOCUMENT_OPERATORS
    assert.equal(runtime.hrEmployeePortalEnabled(),false)
    for(const role of ["EMPLOYEE","TEAM_LEADER","ADMIN","SUPER_ADMIN"]){identity.role=role;await assert.rejects(runtime.hrIdentity(),/DISABLED/)}
    process.env.HR_DOCUMENT_EMPLOYEE_PORTAL_ENABLED="false";await assert.rejects(runtime.hrIdentity(),/DISABLED/)
  })
  it("only the exact explicit operator/company may pass; revocation and company switch close access",async()=>{
    process.env.HR_DOCUMENT_OPERATORS=JSON.stringify([{userId:identity.id,companyId:identity.companyId,capabilities:["READ"]}])
    assert.deepEqual(await runtime.hrIdentity(),{userId:"synthetic-operator",companyId:"synthetic-company"})
    identity={...identity,companyId:"synthetic-other-company"};await assert.rejects(runtime.hrIdentity(),/DISABLED/)
    identity={...identity,companyId:"synthetic-company"};process.env.HR_DOCUMENT_OPERATORS="[]";await assert.rejects(runtime.hrIdentity(),/DISABLED/)
  })
  it("employee portal requires a separate exact true flag, while global off still closes everything",async()=>{
    process.env.HR_DOCUMENT_EMPLOYEE_PORTAL_ENABLED="true"
    assert.deepEqual(await runtime.hrIdentity(),{userId:identity.id,companyId:identity.companyId})
    process.env.HR_DOCUMENTS_ENABLED="false";await assert.rejects(runtime.hrIdentity(),/DISABLED/)
  })
  it("the direct employee page stays closed even for an operator when the portal is off",async()=>{
    process.env.HR_DOCUMENTS_ENABLED="true";process.env.HR_DOCUMENT_EMPLOYEE_PORTAL_ENABLED="false"
    process.env.HR_DOCUMENT_OPERATORS=JSON.stringify([{userId:identity.id,companyId:identity.companyId,capabilities:["READ"]}])
    const page=await import("../../src/app/(dashboard)/mes-documents/page")
    await assert.rejects(page.default(),/PAGE_NOT_FOUND/)
  })
  it("the direct management page returns not-found rather than a server error for an ungranted account",async()=>{
    process.env.HR_DOCUMENT_OPERATORS="[]"
    const page=await import("../../src/app/(dashboard)/rh/documents/page")
    await assert.rejects(page.default({searchParams:Promise.resolve({})}),/PAGE_NOT_FOUND/)
  })
})
