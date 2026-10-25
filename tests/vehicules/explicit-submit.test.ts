import {test} from "node:test"
import assert from "node:assert/strict"
import {isExplicitSubmit,preventImplicitEnter} from "../../src/components/vehicules/explicit-submit"
test("editing fields cannot implicitly save; textarea and intentionally activated buttons remain accessible",()=>{
 for(const tag of ["INPUT","SELECT"]){let blocked=false;preventImplicitEnter({key:"Enter",target:{tagName:tag},preventDefault(){blocked=true}} as any);assert.equal(blocked,true)}
 for(const tag of ["TEXTAREA","BUTTON","A"]){let blocked=false;preventImplicitEnter({key:"Enter",target:{tagName:tag},preventDefault(){blocked=true}} as any);assert.equal(blocked,false)}
 for(const value of [null,"false","true"]){let prevented=false;const e={nativeEvent:{submitter:value===null?null:{getAttribute:()=>value}},preventDefault(){prevented=true}};assert.equal(isExplicitSubmit(e as any),value==="true");assert.equal(prevented,true)}
})
