import {test} from "node:test"
import assert from "node:assert/strict"
import {assignTeamCore, type AssignTeamDeps} from "../../../src/lib/actions/assignment-team.core"
const run=(error:unknown)=>assignTeamCore({worksiteId:"site",teamId:"team",dateFrom:"2026-10-25",dateTo:"2026-10-25"},{companyId:"company",actorUserId:"admin"},{
 findWorksite:async()=>({id:"site",name:"Site",status:"PLANNED"}),findTeam:async()=>({members:[],leader:null}),findTeamConflict:async()=>null,findEmployeeConflicts:async()=>[],transaction:async()=>{throw error},sendAssignmentCreatedEmail:async()=>{}
} satisfies AssignTeamDeps)
test("daily assignment reports reserved team/driver without exposing SQL or suggesting a futile retry",async()=>{
 for(const resource of ["TEAM","DRIVER"]){const result=await run(Object.assign(new Error("Constraint violation"),{code:"P2004",meta:{database_error:`ERROR: DAILY_${resource}_PLANNING_CONFLICT SQL23514 private details`}}));assert.equal(result.ok,false);if(!result.ok){assert.equal(result.code,resource==="TEAM"?"TEAM_CONFLICT":"EMPLOYEE_CONFLICT");assert.match(String(result.details?.message),/réserv/);assert.doesNotMatch(JSON.stringify(result),/private|23514|réessayer/)}}
 const generic=await run(new Error("unrelated"));assert.equal(generic.ok,false);if(!generic.ok)assert.equal(generic.code,"TRANSACTION_FAILED")
})
