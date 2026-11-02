import {describe,it} from "node:test"
import assert from "node:assert/strict"
import {deleteEmployeImpl,type DeleteEmployeDeps} from "../../src/lib/actions/employe-delete.core"
describe("HR document preservation integrates without changing the legacy no-document path",()=>{
  function fixture(){let writes=0;const deps:DeleteEmployeDeps={requireSession:async()=>({companyId:"c",role:"ADMIN"}),findEmployee:async()=>({id:"e",userId:"u"}),hasVehicleHistory:async()=>false,deleteEmployeeRecords:async()=>{writes++},deleteUser:async()=>{},revalidate:()=>{}};return {deps,writes:()=>writes}}
  it("retains existing successful deletion when the optional module guard is absent",async()=>{
    const f=fixture();assert.deepEqual(await deleteEmployeImpl("e",f.deps),{success:true});assert.equal(f.writes(),1)
  })
  it("returns an archive instruction before any write if a preserved document exists",async()=>{
    const f=fixture();f.deps.hasProtectedHrDocuments=async()=>true
    const result=await deleteEmployeImpl("e",f.deps);assert.ok("code" in result)
    assert.equal(result.code,"EMPLOYEE_HAS_HR_DOCUMENTS");assert.equal(f.writes(),0)
  })
  it("handles a document created concurrently, without mislabelling it as a vehicle dependency",async()=>{
    const f=fixture();let checks=0;f.deps.hasProtectedHrDocuments=async()=>++checks>1
    f.deps.deleteEmployeeRecords=async()=>{throw {code:"P2003"}}
    const result=await deleteEmployeImpl("e",f.deps);assert.ok("code" in result)
    assert.equal(result.code,"EMPLOYEE_HAS_HR_DOCUMENTS")
  })
})
