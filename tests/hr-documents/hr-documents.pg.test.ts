import { after,describe,it } from "node:test"
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { PrismaClient } from "@prisma/client"
import { capabilitiesFor,digest,HrError,type Identity } from "../../src/lib/hr-documents/domain"
import { PrismaHrRepository } from "../../src/lib/hr-documents/repository"
import { HrDocumentsService,type Repository } from "../../src/lib/hr-documents/service"
import type { PrivateDrive } from "../../src/lib/hr-documents/drive"
import { deliverNotice } from "../../src/lib/hr-documents/notification"

const testUrl=process.env.HR_DOCUMENT_TEST_DATABASE_URL
if(!testUrl)throw new Error("HR_DOCUMENT_TEST_DATABASE_URL required: an isolated local disposable database")
const parsed=new URL(testUrl)
if(!["127.0.0.1","localhost"].includes(parsed.hostname)||parsed.pathname!=="/planificator_hr_docs_test")throw new Error("Disposable local HR test database only")
const db=new PrismaClient({datasources:{db:{url:testUrl}},log:[]})
const run=randomUUID().slice(0,8);let seq=0
const pdf=(suffix="one")=>Buffer.from(`%PDF-1.4\nsynthetic test ${suffix}\n%%EOF\n`)
class FakeDrive implements PrivateDrive {
  roots=new Set<string>();files=new Map<string,{root:string;bytes:Uint8Array}>();private=true;failCreate=false;failPut=false
  onRead:(()=>Promise<void>)|undefined
  async allocate(){return randomUUID()}
  async checkPrivate(id:string,parent?:string){if(!this.private)throw new HrError("DRIVE_PRIVATE_REQUIRED",409);if(parent?this.files.get(id)?.root!==parent:!this.roots.has(id))throw new HrError("DRIVE_UNAVAILABLE",503)}
  async createRoot(id:string){if(this.failCreate){this.failCreate=false;throw new HrError("DRIVE_UNAVAILABLE",503)}this.roots.add(id)}
  async put(id:string,root:string,bytes:Uint8Array){if(this.failPut){this.failPut=false;throw new HrError("DRIVE_UNAVAILABLE",503)}if(!this.files.has(id))this.files.set(id,{root,bytes:bytes.slice()})}
  async read(id:string){const value=this.files.get(id);if(!value)throw new HrError("DRIVE_UNAVAILABLE",503);const hook=this.onRead;this.onRead=undefined;if(hook)await hook();return value.bytes.slice()}
}
async function fixture(){
  const n=`${run}-${++seq}`,companyId=`hr-c-${n}`,operator={userId:`hr-o-${n}`,companyId},owner={userId:`hr-u-${n}`,companyId},other={userId:`hr-v-${n}`,companyId}
  await db.company.create({data:{id:companyId,name:"Synthetic HR company",slug:companyId}})
  for(const [identity,role] of [[operator,"ADMIN"],[owner,"EMPLOYEE"],[other,"EMPLOYEE"]] as const){await db.user.create({data:{id:identity.userId,email:`${identity.userId}@example.test`,password:"not-a-real-credential",role,companyId}})}
  const employeeId=`hr-e-${n}`,otherEmployeeId=`hr-f-${n}`
  for(const [id,userId] of [[employeeId,owner.userId],[otherEmployeeId,other.userId]])await db.employee.create({data:{id,userId,companyId,firstName:"Synthetic",lastName:"Employee"}})
  await db.worksitePhotoDriveConnection.create({data:{companyId,accountEmail:"storage@example.test",accessToken:"synthetic-encrypted-access",refreshToken:"synthetic-encrypted-refresh",tokenExpiry:new Date(Date.now()+3600_000),connectedById:operator.userId}})
  let grants=JSON.stringify([{...operator,capabilities:["IMPORT","PUBLISH","READ","CONFIGURE"]}])
  const repo=new PrismaHrRepository(db,()=>grants),drive=new FakeDrive()
  const connect=async()=>{
    const connection=await db.worksitePhotoDriveConnection.findUniqueOrThrow({where:{companyId}})
    return {drive,generation:digest(connection.refreshToken),accountEmail:connection.accountEmail}
  }
  const service=new HrDocumentsService(repo,connect)
  const input=()=>({employeeId,category:"PAYSLIP",period:"2026-11",title:"Synthetic payslip",key:randomUUID()})
  const ready=async(bytes=pdf())=>{await service.configure(operator);return service.import(operator,input(),bytes)}
  const reviewed=async()=>{const doc=await ready();return service.review(operator,doc.id,{...input(),expectedVersion:doc.version})}
  const published=async()=>{const doc=await reviewed();return service.publish(operator,doc.id,doc.version,randomUUID())}
  return {companyId,operator,owner,other,employeeId,otherEmployeeId,repo,drive,connect,service,input,ready,reviewed,published,revoke:()=>{grants="[]"}}
}
after(async()=>{await db.$disconnect()})
describe("HR documents × disposable PostgreSQL, Google and email simulated",()=>{
  it("strict explicit grants, no role shortcut and no malformed wildcard",()=>{
    const who={userId:"u",companyId:"c"}
    assert.deepEqual(capabilitiesFor(undefined,who),[])
    assert.deepEqual(capabilitiesFor('[{"userId":"*","companyId":"c","capabilities":["READ"]}]',who),[])
    assert.deepEqual(capabilitiesFor('[{"userId":"u","companyId":"c","capabilities":["READ"],"admin":true}]',who),[])
  })
  it("imports privately, reviews, publishes, owner downloads; peers and other companies denied",async()=>{
    const f=await fixture(),doc=await f.ready()
    assert.equal((await f.service.list(f.owner)).length,0)
    await assert.rejects(f.service.download(f.owner,doc.id),/NOT_FOUND/)
    const review=await f.service.review(f.operator,doc.id,{...f.input(),expectedVersion:doc.version})
    const published=await f.service.publish(f.operator,doc.id,review.version,randomUUID())
    assert.equal(published.status,"PUBLISHED")
    assert.deepEqual(Buffer.from((await f.service.download(f.owner,doc.id)).bytes),pdf())
    await assert.rejects(f.service.download(f.other,doc.id),/NOT_FOUND/)
    const alien=await fixture();await assert.rejects(f.service.download(alien.operator,doc.id),/NOT_FOUND/)
    assert.equal(await db.hrDocumentNotice.count({where:{documentId:doc.id}}),1)
    assert.equal(await db.hrDocumentEvent.count({where:{documentId:doc.id}}),4)
  })
  it("lost initial root creation resumes the same reservation",async()=>{
    const f=await fixture();f.drive.failCreate=true
    await assert.rejects(f.service.configure(f.operator),/DRIVE_UNAVAILABLE/)
    const reserved=await db.hrDocumentStore.findUniqueOrThrow({where:{companyId:f.companyId}})
    await f.service.configure(f.operator)
    assert.ok(f.drive.roots.has(reserved.rootId));assert.equal(f.drive.roots.size,1)
  })
  it("interrupted import resumes same ID; different payload/key conflicts and exact duplicates refused",async()=>{
    const f=await fixture();await f.service.configure(f.operator);f.drive.failPut=true
    const input=f.input();await assert.rejects(f.service.import(f.operator,input,pdf()),/DRIVE_UNAVAILABLE/)
    const reserved=await db.hrDocument.findFirstOrThrow({where:{companyId:f.companyId}})
    const doc=await f.service.import(f.operator,input,pdf())
    assert.equal(doc.id,reserved.id);assert.equal(f.drive.files.size,1)
    await assert.rejects(f.service.import(f.operator,{...input,title:"Changed"},pdf()),/RECEIPT_CONFLICT/)
    await assert.rejects(f.service.import(f.operator,f.input(),pdf()),/DUPLICATE/)
  })
  it("same PDF for two beneficiaries is blocked, including concurrent imports",async()=>{
    const f=await fixture();await f.service.configure(f.operator)
    const values=await Promise.allSettled([f.service.import(f.operator,f.input(),pdf()),f.service.import(f.operator,{...f.input(),employeeId:f.otherEmployeeId},pdf())])
    assert.equal(values.filter(x=>x.status==="fulfilled").length,1)
    assert.equal(await db.hrDocument.count({where:{companyId:f.companyId}}),1)
  })
  it("double publication and replay create one receipt, notice and event",async()=>{
    const f=await fixture(),doc=await f.reviewed(),key=randomUUID()
    const values=await Promise.all([f.service.publish(f.operator,doc.id,doc.version,key),f.service.publish(f.operator,doc.id,doc.version,key)])
    assert.ok(values.every(x=>x.status==="PUBLISHED"))
    assert.equal(await db.hrDocumentReceipt.count({where:{companyId:f.companyId,key}}),1)
    assert.equal(await db.hrDocumentEvent.count({where:{documentId:doc.id,action:"PUBLISHED"}}),1)
    assert.equal(await db.hrDocumentNotice.count({where:{documentId:doc.id}}),1)
    await assert.rejects(f.service.publish(f.operator,doc.id,doc.version+1,key),/RECEIPT_CONFLICT/)
  })
  it("reviewed assignment changed in another review invalidates prior publication",async()=>{
    const f=await fixture(),doc=await f.reviewed()
    await f.service.review(f.operator,doc.id,{...f.input(),title:"New review",expectedVersion:doc.version})
    await assert.rejects(f.service.publish(f.operator,doc.id,doc.version,randomUUID()),/CONFLICT/)
  })
  it("file replaced remotely returns zero unapproved bytes and blocks delivery",async()=>{
    const f=await fixture(),doc=await f.published(),row=await db.hrDocument.findUniqueOrThrow({where:{id:doc.id}})
    f.drive.files.get(row.driveFileId)!.bytes=pdf("modified")
    await assert.rejects(f.service.download(f.owner,doc.id),/CONTENT_CHANGED/)
    assert.equal((await db.hrDocument.findUniqueOrThrow({where:{id:doc.id}})).status,"BLOCKED")
  })
  it("recipient revoked during remote read wins before bytes are delivered",async()=>{
    const f=await fixture(),doc=await f.published()
    f.drive.onRead=async()=>{await db.user.update({where:{id:f.owner.userId},data:{active:false}})}
    await assert.rejects(f.service.download(f.owner,doc.id),/FORBIDDEN/)
  })
  it("Drive disconnected during import prevents READY",async()=>{
    const f=await fixture();await f.service.configure(f.operator)
    f.drive.onRead=async()=>{await db.worksitePhotoDriveConnection.update({where:{companyId:f.companyId},data:{status:"DISCONNECTED"}})}
    await assert.rejects(f.service.import(f.operator,f.input(),pdf()),/STORAGE_NOT_READY/)
    assert.equal((await db.hrDocument.findFirstOrThrow({where:{companyId:f.companyId}})).status,"UPLOADING")
  })
  it("Drive reconnected during download or publication prevents delivery and publication",async()=>{
    for(const mode of ["download","publish"]){
      const f=await fixture(),doc=mode==="download"?await f.published():await f.reviewed()
      f.drive.onRead=async()=>{await db.worksitePhotoDriveConnection.update({where:{companyId:f.companyId},data:{refreshToken:"new-generation"}})}
      await assert.rejects(mode==="download"?f.service.download(f.owner,doc.id):f.service.publish(f.operator,doc.id,doc.version,randomUUID()),/STORAGE_NOT_READY/)
      if(mode==="publish")assert.equal((await db.hrDocument.findUniqueOrThrow({where:{id:doc.id}})).status,"REVIEWED")
    }
  })
  it("operator grant revoked during remote publication prevents commit",async()=>{
    const f=await fixture(),doc=await f.reviewed();f.drive.onRead=async()=>{f.revoke()}
    await assert.rejects(f.service.publish(f.operator,doc.id,doc.version,randomUUID()),/FORBIDDEN/)
    assert.equal((await db.hrDocument.findUniqueOrThrow({where:{id:doc.id}})).status,"REVIEWED")
  })
  it("event failure rolls publication, receipt and notice back together",async()=>{
    const f=await fixture(),doc=await f.reviewed()
    const failing:Repository={run:(identity,fn)=>f.repo.run(identity,(tx,a)=>fn(new Proxy(tx,{get(target,key){
      if(key==="event")return async(_doc:unknown,_actor:string,action:string)=>{if(action==="PUBLISHED")throw new Error("SYNTHETIC_EVENT_FAILURE")}
      const value=Reflect.get(target,key);return typeof value==="function"?value.bind(target):value
    }}),a))}
    const broken=new HrDocumentsService(failing,f.connect)
    await assert.rejects(broken.publish(f.operator,doc.id,doc.version,randomUUID()),/SYNTHETIC_EVENT_FAILURE/)
    assert.equal((await db.hrDocument.findUniqueOrThrow({where:{id:doc.id}})).status,"REVIEWED")
    assert.equal(await db.hrDocumentNotice.count({where:{documentId:doc.id}}),0)
  })
  it("shared Drive root fails closed; strict payload and file size rejected",async()=>{
    const f=await fixture();await f.service.configure(f.operator);f.drive.private=false
    await assert.rejects(f.service.import(f.operator,f.input(),pdf()),/DRIVE_PRIVATE_REQUIRED/)
    f.drive.private=true
    await assert.rejects(f.service.import(f.operator,{...f.input(),companyId:"injected"},pdf()))
    await assert.rejects(f.service.import(f.operator,f.input(),Buffer.from("not a PDF")),/INVALID_PDF/)
  })
  it("notice is opt-in and sent once; ambiguous transport never silently retries",async()=>{
    const f=await fixture(),doc=await f.published();let sends=0
    const options={enabled:false,appUrl:"https://app.example.test",send:async()=>{sends++}}
    assert.equal(await deliverNotice(f.repo,f.operator,doc.id,options),"DISABLED");assert.equal(sends,0)
    options.enabled=true
    await Promise.all([deliverNotice(f.repo,f.operator,doc.id,options),deliverNotice(f.repo,f.operator,doc.id,options)])
    await deliverNotice(f.repo,f.operator,doc.id,options);assert.equal(sends,1)
    const g=await fixture(),another=await g.published()
    const ambiguous={...options,send:async()=>{sends++;throw new Error("synthetic lost acknowledgement")}}
    assert.equal(await deliverNotice(g.repo,g.operator,another.id,ambiguous),"UNKNOWN")
    assert.equal(await deliverNotice(g.repo,g.operator,another.id,ambiguous),"UNKNOWN");assert.equal(sends,2)
  })
  it("composite employee/company FK rejects cross-company persistence",async()=>{
    const f=await fixture(),g=await fixture(),doc=await f.ready()
    await assert.rejects(db.hrDocument.update({where:{id:doc.id},data:{employeeId:g.employeeId}}))
  })
  it("a reserved upload resumes after a complete service restart without its browser key",async()=>{
    const f=await fixture();await f.service.configure(f.operator);f.drive.failPut=true
    await assert.rejects(f.service.import(f.operator,f.input(),pdf()),/DRIVE_UNAVAILABLE/)
    const row=await db.hrDocument.findFirstOrThrow({where:{companyId:f.companyId}})
    const restarted=new HrDocumentsService(f.repo,f.connect)
    await assert.rejects(restarted.resume(f.other,row.id,row.version,pdf()),/FORBIDDEN|NOT_FOUND/)
    await assert.rejects(restarted.resume(f.operator,row.id,row.version,pdf("different")),/CONTENT_CHANGED/)
    assert.equal((await restarted.resume(f.operator,row.id,row.version,pdf())).status,"READY")
    assert.equal(f.drive.files.size,1)
  })
  it("blocked document is reverified without automatic republication, or restored from original bytes",async()=>{
    const f=await fixture(),doc=await f.published(),row=await db.hrDocument.findUniqueOrThrow({where:{id:doc.id}})
    f.drive.private=false;await assert.rejects(f.service.download(f.owner,doc.id),/DRIVE_PRIVATE_REQUIRED/)
    f.drive.private=true
    const blocked=await db.hrDocument.findUniqueOrThrow({where:{id:doc.id}})
    const ready=await f.service.reverify(f.operator,doc.id,blocked.version)
    assert.equal(ready.status,"READY");await assert.rejects(f.service.download(f.owner,doc.id),/NOT_FOUND/)
    await assert.rejects(f.service.review(f.operator,doc.id,{...f.input(),employeeId:f.otherEmployeeId,expectedVersion:ready.version}),/CONFLICT/)
    const review=await f.service.review(f.operator,doc.id,{...f.input(),expectedVersion:ready.version})
    await f.service.publish(f.operator,doc.id,review.version,randomUUID())
    assert.equal(await db.hrDocumentNotice.count({where:{documentId:doc.id}}),2)
    f.drive.files.get(row.driveFileId)!.bytes=pdf("changed")
    await assert.rejects(f.service.download(f.owner,doc.id),/CONTENT_CHANGED/)
    const next=await db.hrDocument.findUniqueOrThrow({where:{id:doc.id}})
    assert.equal((await f.service.reverify(f.operator,doc.id,next.version,pdf())).status,"READY")
    const restored=await db.hrDocument.findUniqueOrThrow({where:{id:doc.id}})
    assert.notEqual(restored.driveFileId,row.driveFileId);assert.ok(f.drive.files.has(row.driveFileId),"old storage reference retained")
  })
  it("same-account OAuth reconnection requires explicit controlled reassociation, other account refused",async()=>{
    const f=await fixture(),doc=await f.published()
    await db.worksitePhotoDriveConnection.update({where:{companyId:f.companyId},data:{refreshToken:"reconnected-same-account"}})
    await assert.rejects(f.service.download(f.owner,doc.id),/STORAGE_NOT_READY/)
    await assert.rejects(f.service.reassociate(f.owner),/FORBIDDEN/)
    await f.service.reassociate(f.operator)
    assert.deepEqual(Buffer.from((await f.service.download(f.owner,doc.id)).bytes),pdf())
    assert.equal(await db.hrDocumentStoreEvent.count({where:{companyId:f.companyId}}),1)
    await db.worksitePhotoDriveConnection.update({where:{companyId:f.companyId},data:{accountEmail:"other-account@example.test",refreshToken:"other"}})
    await assert.rejects(f.service.reassociate(f.operator),/STORAGE_NOT_READY/)
  })
  it("editing a reviewed document invalidates its previous publication version",async()=>{
    const f=await fixture(),doc=await f.reviewed()
    const ready=await f.service.edit(f.operator,doc.id,doc.version)
    assert.equal(ready.status,"READY");assert.equal(ready.reviewedById,null)
    await assert.rejects(f.service.publish(f.operator,doc.id,doc.version,randomUUID()),/CONFLICT/)
  })
  it("completion of an older notice never marks a newer in-flight publication SENT or UNKNOWN",async()=>{
    for(const lostAck of [false,true]){
      const f=await fixture(),doc=await f.published()
      let start1!:()=>void,release1!:()=>void,start2!:()=>void,release2!:()=>void
      const started1=new Promise<void>(r=>{start1=r}),gate1=new Promise<void>(r=>{release1=r})
      const started2=new Promise<void>(r=>{start2=r}),gate2=new Promise<void>(r=>{release2=r})
      const first=deliverNotice(f.repo,f.operator,doc.id,{enabled:true,appUrl:"https://app.example.test",send:async()=>{start1();await gate1;if(lostAck)throw new Error("synthetic lost acknowledgement")}})
      await started1
      f.drive.private=false;await assert.rejects(f.service.download(f.owner,doc.id));f.drive.private=true
      const blocked=await db.hrDocument.findUniqueOrThrow({where:{id:doc.id}})
      const ready=await f.service.reverify(f.operator,doc.id,blocked.version)
      const review=await f.service.review(f.operator,doc.id,{...f.input(),expectedVersion:ready.version})
      await f.service.publish(f.operator,doc.id,review.version,randomUUID())
      const second=deliverNotice(f.repo,f.operator,doc.id,{enabled:true,appUrl:"https://app.example.test",send:async()=>{start2();await gate2}})
      await started2;release1();await first
      const notices=await db.hrDocumentNotice.findMany({where:{documentId:doc.id},orderBy:{publishedVersion:"asc"}})
      assert.equal(notices[0].status,lostAck?"UNKNOWN":"SENT")
      assert.equal(notices[1].status,"PROCESSING")
      release2();await second
      assert.equal((await db.hrDocumentNotice.findUniqueOrThrow({where:{id:notices[1].id}})).status,"SENT")
    }
  })
})
