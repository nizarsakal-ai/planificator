import { digest,HrError,requireCapability,type Identity } from "./domain"
import type { Repository } from "./service"

export type NoticeTransport=(input:{to:string;url:string;idempotencyKey:string})=>Promise<void>
/** Explicit opt-in. No email content, recipient or provider exception is logged. */
export async function deliverNotice(repo:Repository,identity:Identity,documentId:string,options:{enabled:boolean;appUrl:string;send:NoticeTransport;clock?:()=>Date}) {
  if(!options.enabled)return "DISABLED"
  const now=(options.clock??(()=>new Date()))()
  const origin=new URL(options.appUrl)
  if(origin.protocol!=="https:"||origin.username||origin.password)throw new HrError("STORAGE_NOT_READY",409)
  const claim=await repo.run(identity,async(tx,a)=>{
    requireCapability(a,"PUBLISH");requireCapability(a,"READ")
    const doc=await tx.find(a.companyId,documentId),notice=await tx.notice(a.companyId,documentId)
    if(!doc||doc.status!=="PUBLISHED"||!notice||notice.publishedVersion!==doc.version)throw new HrError("NOT_FOUND",404)
    const employee=await tx.employee(a.companyId,doc.employeeId)
    if(!employee?.email||employee.userId!==notice.userId)throw new HrError("NOT_FOUND",404)
    if(notice.status==="SENT")return {done:true as const}
    // A lost provider acknowledgement must not cause a blind send outside its 24h idempotency window.
    if(notice.attemptAt && now.getTime()-notice.attemptAt.getTime()>23*3600_000){await tx.saveNotice({...notice,status:"UNKNOWN"},notice.status);return {done:true as const,unknown:true}}
    if(notice.status==="UNKNOWN")return {done:true as const,unknown:true}
    if(notice.status==="PROCESSING")return {done:true as const,busy:true}
    const firstAttempt=notice.attemptAt??now
    await tx.saveNotice({...notice,status:"PROCESSING",attemptAt:firstAttempt},"PENDING")
    return {done:false as const,notice:{...notice,attemptAt:firstAttempt},email:employee.email}
  })
  if(claim.done)return "unknown" in claim?"UNKNOWN":"busy" in claim?"PROCESSING":"SENT"
  try{
    await options.send({to:claim.email,url:new URL("/mes-documents",origin.origin).toString(),idempotencyKey:`hr-document-${digest(claim.notice.id)}`})
  }catch{
    // Ambiguous failure: stop automatic retries, preserve the decision and require reconciliation.
    await repo.run(identity,async(tx,a)=>{
      requireCapability(a,"PUBLISH")
      const current=await tx.noticeById(a.companyId,claim.notice.id,claim.notice.publishedVersion)
      if(current?.status==="PROCESSING")await tx.saveNotice({...current,status:"UNKNOWN"},"PROCESSING")
    })
    return "UNKNOWN"
  }
  await repo.run(identity,async(tx,a)=>{
    requireCapability(a,"PUBLISH")
    const current=await tx.noticeById(a.companyId,claim.notice.id,claim.notice.publishedVersion)
    if(current?.status==="PROCESSING")await tx.saveNotice({...current,status:"SENT",sentAt:now},"PROCESSING")
  })
  return "SENT"
}
