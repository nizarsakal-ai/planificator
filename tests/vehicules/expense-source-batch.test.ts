import {test} from "node:test"
import assert from "node:assert/strict"
import {Prisma} from "@prisma/client"
import {expenseSourceStates} from "../../src/lib/vehicules/v3/expense-service"
test("source eligibility batches many expense sources and still excludes changed/missing sources",async()=>{
 const date=new Date("2020-01-01T00:00:00Z");let calls=0
 const expenses=Array.from({length:1001},(_,i)=>({id:`expense${i}`,companyId:"company",sourceExpenseReportId:`source${i}`,amount:new Prisma.Decimal("10"),currency:"EUR",sourceSnapshot:{currency:"EUR",updatedAt:date.toISOString()}})) as any
 const tx={expenseReport:{findMany:async({where}:any)=>{calls++;assert.equal(where.companyId,"company");assert.ok(where.id.in.length<=500);return where.id.in.filter((id:string)=>id!=="source0").map((id:string)=>({id,companyId:"company",amount:10,status:id==="source1"?"REJECTED":"APPROVED",updatedAt:date}))}}} as any
 const result=await expenseSourceStates(tx,"company",expenses);assert.equal(calls,3);assert.equal(result.get("expense0")!.warning,"SOURCE_MISSING");assert.equal(result.get("expense1")!.eligible,false);assert.equal(result.get("expense1000")!.eligible,true)
})
