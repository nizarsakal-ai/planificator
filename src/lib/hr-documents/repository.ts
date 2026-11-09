import { randomUUID } from "node:crypto"
import { Prisma, type PrismaClient } from "@prisma/client"
import { resolveCompanyAccess } from "@/lib/company-access"
import { capabilitiesFor, digest, employeeDraftsEnabled, HrError, MESSAGE_PAGE, OWN_SUBMISSION_STATUSES, REQUEST_SCAN_PAGE, privateSpaceEnabled, SUBMISSION_INTENT_PREFIX, type Actor, type DraftInput, type Identity } from "./domain"
import type { DocumentRecord, MessageRecord, Repository, Storage, Tx, Notice } from "./service"

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
  async employee(companyId:string,id:string,opts?:{allowDraft?:boolean}) {
    await this.db.$queryRaw`SELECT id FROM employees WHERE id=${id} AND "companyId"=${companyId} FOR SHARE`
    const employee=await this.db.employee.findFirst({where:{id,companyId,active:true,user:{active:true},company:{active:true}},select:{id:true,userId:true,firstName:true,lastName:true,user:{select:{email:true}}}})
    if(employee)return {id:employee.id,userId:employee.userId,email:employee.user.email,firstName:employee.firstName,lastName:employee.lastName}
    // PLV2-DOC-RH-002 : fiche à compléter (inactive), seulement pour déposer et revoir, jamais pour publier.
    if(!opts?.allowDraft||!employeeDraftsEnabled())return null
    const draft=await this.db.employee.findFirst({where:{id,companyId,active:false,hrDraft:{is:{companyId,status:"OPEN"}},company:{active:true}},select:{id:true,userId:true,firstName:true,lastName:true}})
    return draft?{id:draft.id,userId:draft.userId,firstName:draft.firstName,lastName:draft.lastName,draft:true}:null
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
    // Salarié : ses documents publiés ; avec l'espace privé, aussi ses propres dépôts (jamais un brouillon RH).
    const own:Prisma.HrDocumentWhereInput={employeeId:actor.employeeId??"__NO_EMPLOYEE__",...(privateSpaceEnabled()
      ?{OR:[{status:"PUBLISHED"},{uploadedById:actor.userId,uploadIntent:{startsWith:SUBMISSION_INTENT_PREFIX},status:{in:[...OWN_SUBMISSION_STATUSES]}}]}
      :{status:"PUBLISHED"})}
    const where:Prisma.HrDocumentWhereInput={companyId:actor.companyId,...(manage?(employeeId?{employeeId}:{}):own),...(cursor?{id:{gt:cursor}}:{})}
    return this.db.hrDocument.findMany({where,orderBy:{id:"asc"},take:26})
  }
  async employees(companyId:string){
    const active=await this.db.employee.findMany({where:{companyId,active:true,user:{active:true}},select:{id:true,firstName:true,lastName:true},orderBy:[{lastName:"asc"},{id:"asc"}],take:500})
    if(!employeeDraftsEnabled())return active
    const drafts=await this.db.employee.findMany({where:{companyId,active:false,hrDraft:{is:{companyId,status:"OPEN"}}},select:{id:true,firstName:true,lastName:true},orderBy:[{lastName:"asc"},{id:"asc"}],take:200})
    return [...active,...drafts.map(d=>({...d,draft:true}))]
  }
  async draftByKey(companyId:string,createdById:string,key:string){
    const row=await this.db.hrEmployeeDraft.findUnique({where:{companyId_createdById_createKey:{companyId,createdById,createKey:key}},select:{employee:{select:{id:true,firstName:true,lastName:true}}}})
    return row?{...row.employee,draft:true}:null
  }
  async createDraft(companyId:string,createdById:string,input:Omit<DraftInput,"key">&{key:string},passwordHash:string){
    // Adresse réservée (.invalid) : aucune boîte réelle, aucune invitation ; à remplacer par l'e-mail du salarié avant activation.
    const user=await this.db.user.create({data:{email:`rh-fiche-${randomUUID()}@fiche-a-completer.invalid`,password:passwordHash,
      name:`${input.firstName} ${input.lastName}`,role:"EMPLOYEE",active:false,companyId},select:{id:true}})
    const employee=await this.db.employee.create({data:{userId:user.id,companyId,role:"EMPLOYEE",active:false,firstName:input.firstName,lastName:input.lastName},select:{id:true,firstName:true,lastName:true}})
    await this.db.hrEmployeeDraft.create({data:{id:randomUUID(),companyId,employeeId:employee.id,createdById,createKey:input.key,
      birthDate:input.birthDate?new Date(`${input.birthDate}T00:00:00Z`):null,sex:input.sex??null,nationality:input.nationality??null,
      identityExpiry:input.identityExpiry?new Date(`${input.identityExpiry}T00:00:00Z`):null,documentNumberEnd:input.documentNumberEnd??null,
      sourceSha256:input.sourceSha256??null}})
    return {...employee,draft:true}
  }

  // ——— Espace privé RH ↔ salarié ———
  async ownDuplicate(companyId:string,employeeId:string,category:string,period:string,sha256:string){
    return !!await this.db.hrDocument.findFirst({where:{companyId,employeeId,category,period,sha256},select:{id:true}})
  }
  async messages(companyId:string,employeeId:string,cursor?:string){
    // Curseur d'un autre fil : la ligne de départ doit appartenir au même salarié et à la même société.
    if(cursor&&!await this.db.hrMessage.findFirst({where:{id:cursor,companyId,employeeId},select:{id:true}}))throw new HrError("INVALID_INPUT")
    const rows=await this.db.hrMessage.findMany({where:{companyId,employeeId},orderBy:[{createdAt:"desc"},{id:"desc"}],take:MESSAGE_PAGE+1,
      ...(cursor?{cursor:{id:cursor},skip:1}:{})})
    return rows as MessageRecord[]
  }
  async message(companyId:string,id:string){return await this.db.hrMessage.findFirst({where:{id,companyId}}) as MessageRecord|null}
  async messageByKey(companyId:string,authorId:string,key:string){
    return await this.db.hrMessage.findUnique({where:{companyId_authorId_createKey:{companyId,authorId,createKey:key}}}) as MessageRecord|null
  }
  async insertMessage(value:MessageRecord){await this.db.hrMessage.create({data:value})}
  async markRead(companyId:string,employeeId:string,ids:string[],at:Date){
    await this.db.hrMessage.updateMany({where:{companyId,employeeId,id:{in:ids},readAt:null},data:{readAt:at}})
  }
  async closeRequest(companyId:string,employeeId:string,id:string){
    const {count}=await this.db.hrMessage.updateMany({where:{id,companyId,employeeId,kind:"REQUEST",requestStatus:"OPEN"},data:{requestStatus:"DONE"}})
    if(count!==1)throw new HrError("REQUEST_CLOSED",409)
  }
  async requestIdsPage(companyId:string,employeeId:string,after?:string){
    const rows=await this.db.hrMessage.findMany({where:{companyId,employeeId,kind:"REQUEST",...(after?{id:{gt:after}}:{})},select:{id:true},orderBy:{id:"asc"},take:REQUEST_SCAN_PAGE})
    return rows.map(r=>r.id)
  }
  async recordAccess(doc:DocumentRecord,userId:string,at:Date){
    await this.db.hrDocumentAccess.createMany({data:[{id:randomUUID(),companyId:doc.companyId,documentId:doc.id,version:doc.version,userId,firstAt:at}],skipDuplicates:true})
  }
  accesses(companyId:string,documentIds:string[],userId:string){
    return this.db.hrDocumentAccess.findMany({where:{companyId,documentId:{in:documentIds},userId},select:{documentId:true,version:true,firstAt:true}})
  }
}
