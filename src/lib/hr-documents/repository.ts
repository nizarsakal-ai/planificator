import { randomUUID } from "node:crypto"
import { Prisma, type PrismaClient } from "@prisma/client"
import { resolveCompanyAccess } from "@/lib/company-access"
import { capabilitiesFor, digest, HrError, type Actor, type Identity } from "./domain"
import type { DocumentRecord, Repository, Storage, Tx, Notice } from "./service"

export class PrismaHrRepository implements Repository {
  constructor(private readonly db:PrismaClient,private readonly grants=()=>process.env.HR_DOCUMENT_OPERATORS) {}
  async run<T>(identity:Identity,fn:(tx:Tx,actor:Actor)=>Promise<T>) {
    return this.db.$transaction(async db=>{
      // Small HR workloads: one short transaction per company, never a network operation inside.
      await db.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`hr-documents:${identity.companyId}`},0))::text`
      await db.$queryRaw`SELECT id FROM users WHERE id=${identity.userId} FOR SHARE`
      await db.$queryRaw`SELECT id FROM companies WHERE id=${identity.companyId} FOR SHARE`
      await db.$queryRaw`SELECT id FROM employees WHERE "companyId"=${identity.companyId} AND "userId"=${identity.userId} FOR SHARE`
      const tx=new PrismaHrTx(db,this.grants)
      const actor=await tx.actor(identity)
      return fn(tx,actor)
    },{isolationLevel:Prisma.TransactionIsolationLevel.ReadCommitted,maxWait:5000,timeout:10000})
  }
}
class PrismaHrTx implements Tx {
  constructor(private readonly db:Prisma.TransactionClient,private readonly grants:()=>string|undefined) {}
  async actor(identity:Identity):Promise<Actor> {
    const user=await this.db.user.findUnique({where:{id:identity.userId},select:{active:true,role:true,companyId:true,
      company:{select:{active:true}},employeeProfiles:{select:{id:true,companyId:true,active:true,role:true,company:{select:{active:true}}}}}})
    const company=await this.db.company.findUnique({where:{id:identity.companyId},select:{active:true}})
    if(!user?.active||!company?.active)throw new HrError("FORBIDDEN",403)
    const access=resolveCompanyAccess(user,identity.companyId)
    if(access?.companyId!==identity.companyId||!["EMPLOYEE","TEAM_LEADER","ADMIN","SUPER_ADMIN"].includes(access.role))throw new HrError("FORBIDDEN",403)
    const profile=user.employeeProfiles.find(p=>p.companyId===identity.companyId)
    if(profile&&!profile.active)throw new HrError("FORBIDDEN",403)
    return {...identity,employeeId:profile?.id??null,capabilities:capabilitiesFor(this.grants(),identity)}
  }
  async employee(companyId:string,id:string) {
    await this.db.$queryRaw`SELECT id FROM employees WHERE id=${id} AND "companyId"=${companyId} FOR SHARE`
    const employee=await this.db.employee.findFirst({where:{id,companyId,active:true,user:{active:true},company:{active:true}},select:{id:true,userId:true,firstName:true,lastName:true,user:{select:{email:true}}}})
    return employee?{id:employee.id,userId:employee.userId,email:employee.user.email,firstName:employee.firstName,lastName:employee.lastName}:null
  }
  storage(companyId:string){return this.db.hrDocumentStore.findUnique({where:{companyId}})}
  async connection(companyId:string){
    await this.db.$queryRaw`SELECT id FROM worksite_photo_drive_connections WHERE "companyId"=${companyId} FOR SHARE`
    const current=await this.db.worksitePhotoDriveConnection.findUnique({where:{companyId}})
    return current?.status==="ACTIVE"?{generation:digest(current.refreshToken),accountEmail:current.accountEmail.toLowerCase()}:null
  }
  async store(value:Storage){await this.db.hrDocumentStore.create({data:value})}
  async saveStorage(value:Storage,actorId:string){
    await this.db.hrDocumentStore.update({where:{companyId:value.companyId},data:value})
    await this.db.hrDocumentStoreEvent.create({data:{id:randomUUID(),companyId:value.companyId,actorId,action:"SAME_ACCOUNT_REASSOCIATED",generation:value.connectionGeneration}})
  }
  find(companyId:string,id:string){return this.db.hrDocument.findFirst({where:{companyId,id}})}
  upload(companyId:string,userId:string,key:string){return this.db.hrDocument.findUnique({where:{companyId_uploadedById_uploadKey:{companyId,uploadedById:userId,uploadKey:key}}})}
  async duplicate(companyId:string,employeeId:string,category:string,period:string,sha256:string,except?:string){
    return !!await this.db.hrDocument.findFirst({where:{companyId,sha256,OR:[{employeeId,category,period},{employeeId:{not:employeeId}}],...(except?{id:{not:except}}:{})},select:{id:true}})
  }
  async insert(doc:DocumentRecord){await this.db.hrDocument.create({data:doc})}
  async save(doc:DocumentRecord,previousVersion:number){
    const {id,companyId,...data}=doc
    const {count}=await this.db.hrDocument.updateMany({where:{id,companyId,version:previousVersion},data})
    if(count!==1)throw new HrError("CONFLICT",409)
  }
  async event(doc:DocumentRecord,actorId:string,action:string){await this.db.hrDocumentEvent.create({data:{id:randomUUID(),companyId:doc.companyId,documentId:doc.id,actorId,action,version:doc.version,driveFileId:doc.driveFileId,sha256:doc.sha256}})}
  async receipt(companyId:string,actorId:string,key:string){return this.db.hrDocumentReceipt.findUnique({where:{companyId_actorId_key:{companyId,actorId,key}}})}
  async recordReceipt(companyId:string,actorId:string,key:string,intent:string,doc:DocumentRecord){
    await this.db.hrDocumentReceipt.create({data:{id:randomUUID(),companyId,actorId,key,intent,documentId:doc.id,version:doc.version}})
  }
  async notify(doc:DocumentRecord,userId:string){await this.db.hrDocumentNotice.create({data:{id:randomUUID(),companyId:doc.companyId,documentId:doc.id,publishedVersion:doc.version,userId}})}
  notice(companyId:string,documentId:string){return this.db.hrDocumentNotice.findFirst({where:{companyId,documentId},orderBy:{publishedVersion:"desc"}})}
  noticeById(companyId:string,id:string,publishedVersion:number){return this.db.hrDocumentNotice.findFirst({where:{id,companyId,publishedVersion}})}
  async saveNotice(value:Notice,expectedStatus:string){
    const {id,...data}=value
    const result=await this.db.hrDocumentNotice.updateMany({where:{id,companyId:value.companyId,publishedVersion:value.publishedVersion,status:expectedStatus},data})
    if(result.count!==1)throw new HrError("CONFLICT",409)
  }
  list(actor:Actor,manage:boolean,cursor?:string,employeeId?:string){
    const where:Prisma.HrDocumentWhereInput={companyId:actor.companyId,...(manage?(employeeId?{employeeId}:{}):{employeeId:actor.employeeId??"__NO_EMPLOYEE__",status:"PUBLISHED"}),...(cursor?{id:{gt:cursor}}:{})}
    return this.db.hrDocument.findMany({where,orderBy:{id:"asc"},take:26})
  }
  employees(companyId:string){return this.db.employee.findMany({where:{companyId,active:true,user:{active:true}},select:{id:true,firstName:true,lastName:true},orderBy:[{lastName:"asc"},{id:"asc"}],take:500})}
}
