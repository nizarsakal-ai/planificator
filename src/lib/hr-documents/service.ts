import { randomUUID } from "node:crypto"
import { assertContent, canRead, detectKind, digest, draftSchema, employeeDraftsEnabled, employeeSelectionSchema, HrError, KIND_EXTENSION, recognitionEnabled, requireCapability, reviewSchema, validateDocument, type Actor, type DocumentKind, type DraftInput, type Identity } from "./domain"
import { verifiedDownload, type PrivateDrive } from "./drive"
import { recognize, type EmployeeRef, type Proposal } from "./recognition/engine"
import type { ExternalRecognition } from "./recognition/external"

export type DocumentRecord = { id:string; companyId:string; employeeId:string; category:string; period:string; title:string;
  status:string; version:number; sha256:string; size:number; driveFileId:string; rootId:string; uploadedById:string;
  uploadKey:string; uploadIntent:string; reviewedById:string|null; createdAt:Date; publishedAt:Date|null }
export type Storage = { companyId:string; rootId:string; connectionGeneration:string; accountEmail:string }
export type Notice = {id:string;companyId:string;documentId:string;publishedVersion:number;userId:string;status:string;attemptAt:Date|null;sentAt:Date|null}
export type PublicDocument = Pick<DocumentRecord,"id"|"employeeId"|"category"|"period"|"title"|"status"|"version"|"size"|"createdAt"|"publishedAt"|"reviewedById">
export function project(doc:DocumentRecord):PublicDocument {
  const {id,employeeId,category,period,title,status,version,size,createdAt,publishedAt,reviewedById}=doc
  return {id,employeeId,category,period,title,status,version,size,createdAt,publishedAt,reviewedById}
}
export interface Tx {
  actor(identity:Identity):Promise<Actor>
  employee(companyId:string,id:string,opts?:{allowDraft?:boolean}):Promise<{id:string;userId:string;email?:string;firstName?:string;lastName?:string;draft?:boolean}|null>
  storage(companyId:string):Promise<Storage|null>
  connection(companyId:string):Promise<{generation:string;accountEmail:string}|null>
  store(value:Storage):Promise<void>
  saveStorage(value:Storage,actorId:string):Promise<void>
  find(companyId:string,id:string):Promise<DocumentRecord|null>
  upload(companyId:string,userId:string,key:string):Promise<DocumentRecord|null>
  duplicate(companyId:string,employeeId:string,category:string,period:string,sha256:string,except?:string):Promise<boolean>
  insert(doc:DocumentRecord):Promise<void>
  save(doc:DocumentRecord,previousVersion:number):Promise<void>
  event(doc:DocumentRecord,actorId:string,action:string):Promise<void>
  receipt(companyId:string,actorId:string,key:string):Promise<{intent:string;documentId:string;version:number}|null>
  recordReceipt(companyId:string,actorId:string,key:string,intent:string,doc:DocumentRecord):Promise<void>
  notify(doc:DocumentRecord,userId:string):Promise<void>
  notice(companyId:string,documentId:string):Promise<Notice|null>
  noticeById(companyId:string,id:string,version:number):Promise<Notice|null>
  saveNotice(notice:Notice,expectedStatus:string):Promise<void>
  list(actor:Actor,manage:boolean,cursor:string|undefined,employeeId?:string):Promise<DocumentRecord[]>
  employees(companyId:string):Promise<EmployeeRef[]>
  draftByKey(companyId:string,createdById:string,key:string):Promise<EmployeeRef|null>
  createDraft(companyId:string,createdById:string,input:Omit<DraftInput,"key">&{key:string},passwordHash:string):Promise<EmployeeRef>
}
export type TextExtractor=(bytes:Uint8Array,kind:DocumentKind)=>Promise<string>
export interface Repository { run<T>(identity:Identity,fn:(tx:Tx,actor:Actor)=>Promise<T>):Promise<T> }
export type DriveBinding = {drive:PrivateDrive;generation:string;accountEmail:string}
export type DriveFactory = (companyId:string)=>Promise<DriveBinding>

/** A single service controls both the operator and employee entry points. */
export class HrDocumentsService {
  constructor(private readonly repo:Repository,private readonly connect:DriveFactory,private readonly clock=()=>new Date(),
    private readonly extract:TextExtractor=async()=>"",private readonly external:ExternalRecognition|null=null,
    private readonly hashPassword:(secret:string)=>Promise<string>=async()=>{throw new HrError("DISABLED",404)}) {}
  /**
   * PLV2-DOC-RH-002 — proposition de classement, sans écriture : rien n'est conservé, publié ni rattaché ici.
   * Texte local d'abord (couche texte PDF + MRZ + nom du fichier) ; secours externe seulement s'il est branché et activé.
   */
  async recognize(identity:Identity,bytes:Uint8Array,fileName:string):Promise<Proposal&{sha256:string;kind:DocumentKind}> {
    if(!recognitionEnabled())throw new HrError("DISABLED",404)
    const {hash,kind}=validateDocument(bytes)
    const employees=await this.repo.run(identity,async(tx,a)=>{requireCapability(a,"IMPORT");requireCapability(a,"READ");return tx.employees(a.companyId)})
    let text=await this.extract(bytes,kind).catch(()=>"")
    let external=false
    if(!text.trim()&&this.external){const result=await this.external({bytes,kind}).catch(()=>null);if(result?.text){text=result.text;external=true}}
    const proposal=recognize({text,fileName:fileName.slice(0,255),employees,now:this.clock()})
    return {...proposal,sources:external?[...proposal.sources,"EXTERNAL"]:proposal.sources,sha256:hash,kind}
  }
  /** Fiche à compléter : inactive, compte sans mot de passe utilisable, aucune invitation envoyée. */
  async createDraft(identity:Identity,raw:unknown):Promise<EmployeeRef> {
    if(!employeeDraftsEnabled())throw new HrError("DISABLED",404)
    const input=draftSchema.parse(raw)
    // Secret aléatoire jamais transmis : le compte ne peut pas servir à se connecter (il est aussi inactif).
    const passwordHash=await this.hashPassword(randomUUID()+randomUUID())
    return this.repo.run(identity,async(tx,a)=>{
      requireCapability(a,"IMPORT");requireCapability(a,"READ")
      const previous=await tx.draftByKey(a.companyId,a.userId,input.key)
      if(previous)return previous
      return tx.createDraft(a.companyId,a.userId,input,passwordHash)
    })
  }
  private async binding(companyId:string,storage:Storage|null) {
    if (!storage) throw new HrError("STORAGE_NOT_READY",409)
    const binding=await this.connect(companyId)
    if (binding.generation!==storage.connectionGeneration || binding.accountEmail!==storage.accountEmail) throw new HrError("STORAGE_NOT_READY",409)
    return {storage,drive:binding.drive}
  }
  async configure(identity:Identity) {
    await this.repo.run(identity,async(_,a)=>requireCapability(a,"CONFIGURE"))
    const binding=await this.connect(identity.companyId)
    const existing=await this.repo.run(identity,async(tx,a)=>{requireCapability(a,"CONFIGURE");return tx.storage(a.companyId)})
    if (existing) {
      const current=await this.binding(identity.companyId,existing)
      await current.drive.createRoot(existing.rootId)
      await this.repo.run(identity,async(tx,a)=>{requireCapability(a,"CONFIGURE");await this.checkStorage(tx,a,existing)})
      return
    }
    // Reserve the root before a remote call: interrupted creation reuses the same ID.
    const rootId=await binding.drive.allocate()
    const storage=await this.repo.run(identity,async(tx,a)=>{
      requireCapability(a,"CONFIGURE"); const current=await tx.storage(a.companyId)
      if(current) return current
      const value={companyId:a.companyId,rootId,connectionGeneration:binding.generation,accountEmail:binding.accountEmail}
      await tx.store(value);return value
    })
    await this.binding(identity.companyId,storage)
    await binding.drive.createRoot(storage.rootId)
    await this.repo.run(identity,async(tx,a)=>{requireCapability(a,"CONFIGURE");await this.checkStorage(tx,a,storage)})
  }
  async reassociate(identity:Identity) {
    const storage=await this.repo.run(identity,async(tx,a)=>{requireCapability(a,"CONFIGURE");return tx.storage(a.companyId)})
    if(!storage)throw new HrError("STORAGE_NOT_READY",409)
    const binding=await this.connect(identity.companyId)
    if(binding.accountEmail!==storage.accountEmail)throw new HrError("STORAGE_NOT_READY",409)
    await binding.drive.checkPrivate(storage.rootId)
    await this.repo.run(identity,async(tx,a)=>{
      requireCapability(a,"CONFIGURE")
      const current=await tx.storage(a.companyId),connection=await tx.connection(a.companyId)
      if(!current||current.rootId!==storage.rootId||current.accountEmail!==storage.accountEmail||!connection||connection.accountEmail!==storage.accountEmail||connection.generation!==binding.generation)throw new HrError("CONFLICT",409)
      await tx.saveStorage({...storage,connectionGeneration:connection.generation},a.userId)
    })
  }
  async list(identity:Identity,manage=false,cursor?:string,employeeId?:string) {
    const selected=employeeSelectionSchema.parse(employeeId)
    return this.repo.run(identity,async(tx,a)=>{
      if(manage)requireCapability(a,"READ")
      if(selected){
        if(!manage)throw new HrError("FORBIDDEN",403)
        if(!await tx.employee(a.companyId,selected))throw new HrError("NOT_FOUND",404)
      }
      const docs=await tx.list(a,manage,cursor,selected)
      return docs.map(doc=>({...project(doc),canResume:manage&&doc.uploadedById===a.userId}))
    })
  }
  async employees(identity:Identity) {
    return this.repo.run(identity,async(tx,a)=>{requireCapability(a,"READ");return tx.employees(a.companyId)})
  }
  async import(identity:Identity,raw:unknown,bytes:Uint8Array) {
    const input=reviewSchema.parse(raw); const hash=digest(bytes)
    // Validate before reservation; real file kind (PDF, or images behind their flag) and maximum size are part of the contract.
    const {validateDocument}=await import("./domain");const {kind}=validateDocument(bytes)
    const intent=digest(JSON.stringify([input.employeeId,input.category,input.period,input.title,hash,bytes.length]))
    const storage=await this.repo.run(identity,async(tx,a)=>{
      requireCapability(a,"IMPORT");requireCapability(a,"READ")
      if(!await tx.employee(a.companyId,input.employeeId,{allowDraft:true}))throw new HrError("NOT_FOUND",404)
      return tx.storage(a.companyId)
    })
    const {drive}=await this.binding(identity.companyId,storage)
    await drive.checkPrivate(storage!.rootId)
    const remoteId=await drive.allocate()
    const doc=await this.repo.run(identity,async(tx,a)=>{
      requireCapability(a,"IMPORT");requireCapability(a,"READ")
      await this.checkStorage(tx,a,storage!)
      if(!await tx.employee(a.companyId,input.employeeId,{allowDraft:true}))throw new HrError("NOT_FOUND",404)
      const previous=await tx.upload(a.companyId,a.userId,input.key)
      if(previous){if(previous.uploadIntent!==intent)throw new HrError("RECEIPT_CONFLICT",409);return previous}
      if(await tx.duplicate(a.companyId,input.employeeId,input.category,input.period,hash))throw new HrError("DUPLICATE",409)
      const value:DocumentRecord={id:randomUUID(),companyId:a.companyId,employeeId:input.employeeId,category:input.category,
        period:input.period,title:input.title,status:"UPLOADING",version:1,sha256:hash,size:bytes.length,driveFileId:remoteId,
        rootId:storage!.rootId,uploadedById:a.userId,uploadKey:input.key,uploadIntent:intent,reviewedById:null,createdAt:this.clock(),publishedAt:null}
      await tx.insert(value);await tx.event(value,a.userId,"IMPORT_RESERVED");return value
    })
    if(doc.status!=="UPLOADING")return project(doc)
    await drive.put(doc.driveFileId,doc.rootId,bytes,kind)
    return this.finishImport(identity,doc,drive,storage!)
  }
  private async finishImport(identity:Identity,doc:DocumentRecord,drive:PrivateDrive,storage:Storage) {
    // The remote operation is performed by import/resume before this final transaction.
    await verifiedDownload(drive,doc)
    return this.repo.run(identity,async(tx,a)=>{
      requireCapability(a,"IMPORT");requireCapability(a,"READ");await this.checkStorage(tx,a,storage)
      const current=await tx.find(a.companyId,doc.id);if(!current)throw new HrError("NOT_FOUND",404)
      if(current.status!=="UPLOADING")return project(current)
      if(current.version!==doc.version||current.uploadedById!==a.userId)throw new HrError("CONFLICT",409)
      if(!await tx.employee(a.companyId,current.employeeId,{allowDraft:true}))throw new HrError("NOT_FOUND",404)
      const next={...current,status:"READY",version:current.version+1}
      await tx.save(next,current.version);await tx.event(next,a.userId,"IMPORTED");return project(next)
    })
  }
  async resume(identity:Identity,id:string,version:number,bytes:Uint8Array) {
    const {doc,storage}=await this.repo.run(identity,async(tx,a)=>{
      requireCapability(a,"IMPORT");requireCapability(a,"READ")
      const doc=await tx.find(a.companyId,id)
      if(!doc||doc.uploadedById!==a.userId)throw new HrError("NOT_FOUND",404)
      assertContent(bytes,doc.sha256,doc.size)
      if(doc.version!==version||doc.status!=="UPLOADING")throw new HrError("CONFLICT",409)
      return {doc,storage:await tx.storage(a.companyId)}
    })
    const {drive}=await this.binding(identity.companyId,storage)
    await drive.put(doc.driveFileId,doc.rootId,bytes,validateDocument(bytes,true).kind)
    return this.finishImport(identity,doc,drive,storage!)
  }
  async reverify(identity:Identity,id:string,version:number,bytes?:Uint8Array) {
    const {doc,storage}=await this.repo.run(identity,async(tx,a)=>{
      requireCapability(a,"IMPORT");requireCapability(a,"READ")
      const doc=await tx.find(a.companyId,id)
      if(!doc)throw new HrError("NOT_FOUND",404)
      if(doc.status!=="BLOCKED"||doc.version!==version)throw new HrError("CONFLICT",409)
      if(bytes)assertContent(bytes,doc.sha256,doc.size)
      return {doc,storage:await tx.storage(a.companyId)}
    })
    const {drive}=await this.binding(identity.companyId,storage)
    const fileId=bytes?await drive.allocate():doc.driveFileId
    if(bytes)await drive.put(fileId,doc.rootId,bytes,validateDocument(bytes,true).kind)
    await verifiedDownload(drive,{...doc,driveFileId:fileId})
    return this.repo.run(identity,async(tx,a)=>{
      requireCapability(a,"IMPORT");requireCapability(a,"READ");await this.checkStorage(tx,a,storage!)
      const current=await tx.find(a.companyId,doc.id);if(!current)throw new HrError("NOT_FOUND",404)
      if(current.status!=="BLOCKED"||current.version!==version)throw new HrError("CONFLICT",409)
      if(!await tx.employee(a.companyId,current.employeeId))throw new HrError("NOT_FOUND",404)
      const next={...current,driveFileId:fileId,status:"READY",reviewedById:null,version:version+1}
      await tx.save(next,version);await tx.event(next,a.userId,bytes?"ORIGINAL_RESTORED":"REVERIFIED");return project(next)
    })
  }
  private async checkStorage(tx:Tx,a:Actor,storage:Storage) {
    const current=await tx.storage(a.companyId)
    if(!current||current.rootId!==storage.rootId||current.connectionGeneration!==storage.connectionGeneration)throw new HrError("CONFLICT",409)
    const connection=await tx.connection(a.companyId)
    if(!connection||connection.generation!==storage.connectionGeneration||connection.accountEmail!==storage.accountEmail)throw new HrError("STORAGE_NOT_READY",409)
  }
  async review(identity:Identity,id:string,raw:unknown) {
    const input=reviewSchema.parse(raw)
    if(!input.expectedVersion)throw new HrError("INVALID_INPUT")
    return this.repo.run(identity,async(tx,a)=>{
      requireCapability(a,"IMPORT");requireCapability(a,"READ")
      const doc=await tx.find(a.companyId,id)
      if(!doc)throw new HrError("NOT_FOUND",404)
      const intent=digest(JSON.stringify([id,input,"REVIEW"]))
      const receipt=await tx.receipt(a.companyId,a.userId,input.key)
      if(receipt){if(receipt.intent!==intent)throw new HrError("RECEIPT_CONFLICT",409);return project(doc)}
      if(!["READY","REVIEWED"].includes(doc.status)||doc.version!==input.expectedVersion)throw new HrError("CONFLICT",409)
      if(doc.publishedAt&&(doc.employeeId!==input.employeeId||doc.category!==input.category||doc.period!==input.period||doc.title!==input.title))throw new HrError("CONFLICT",409)
      if(!await tx.employee(a.companyId,input.employeeId,{allowDraft:true}))throw new HrError("NOT_FOUND",404)
      if(await tx.duplicate(a.companyId,input.employeeId,input.category,input.period,doc.sha256,id))throw new HrError("DUPLICATE",409)
      const next={...doc,employeeId:input.employeeId,category:input.category,period:input.period,title:input.title,
        status:"REVIEWED",reviewedById:a.userId,version:doc.version+1}
      await tx.save(next,doc.version);await tx.event(next,a.userId,"REVIEWED")
      await tx.recordReceipt(a.companyId,a.userId,input.key,intent,next);return project(next)
    })
  }
  async edit(identity:Identity,id:string,version:number) {
    return this.repo.run(identity,async(tx,a)=>{
      requireCapability(a,"IMPORT");requireCapability(a,"READ")
      const doc=await tx.find(a.companyId,id)
      if(!doc)throw new HrError("NOT_FOUND",404)
      if(doc.status!=="REVIEWED"||doc.version!==version)throw new HrError("CONFLICT",409)
      const next={...doc,status:"READY",reviewedById:null,version:version+1}
      await tx.save(next,version);await tx.event(next,a.userId,"REVIEW_INVALIDATED");return project(next)
    })
  }
  async publish(identity:Identity,id:string,version:number,key:string) {
    const intent=digest(JSON.stringify([id,version,"PUBLISH"]))
    const initial=await this.repo.run(identity,async(tx,a)=>{
      requireCapability(a,"PUBLISH");requireCapability(a,"READ")
      const doc=await tx.find(a.companyId,id);if(!doc)throw new HrError("NOT_FOUND",404)
      const receipt=await tx.receipt(a.companyId,a.userId,key)
      if(receipt){if(receipt.intent!==intent)throw new HrError("RECEIPT_CONFLICT",409);return {doc,done:true,storage:null}}
      if(doc.version!==version||doc.status!=="REVIEWED")throw new HrError("CONFLICT",409)
      return {doc,done:false,storage:await tx.storage(a.companyId)}
    })
    if(initial.done)return project(initial.doc)
    const {drive,storage}=await this.binding(identity.companyId,initial.storage)
    try { await verifiedDownload(drive,initial.doc) } catch(e){await this.blockChanged(identity,id,initial.doc.version,e);throw e}
    return this.repo.run(identity,async(tx,a)=>{
      requireCapability(a,"PUBLISH");requireCapability(a,"READ");await this.checkStorage(tx,a,storage)
      const receipt=await tx.receipt(a.companyId,a.userId,key)
      const doc=await tx.find(a.companyId,id);if(!doc)throw new HrError("NOT_FOUND",404)
      if(receipt){if(receipt.intent!==intent)throw new HrError("RECEIPT_CONFLICT",409);return project(doc)}
      if(doc.status!=="REVIEWED"||doc.version!==version)throw new HrError("CONFLICT",409)
      if(await tx.duplicate(a.companyId,doc.employeeId,doc.category,doc.period,doc.sha256,id))throw new HrError("DUPLICATE",409)
      const employee=await tx.employee(a.companyId,doc.employeeId)
      if(!employee){if(await tx.employee(a.companyId,doc.employeeId,{allowDraft:true}))throw new HrError("DRAFT_EMPLOYEE",409);throw new HrError("NOT_FOUND",404)}
      const next={...doc,status:"PUBLISHED",version:version+1,publishedAt:this.clock()}
      await tx.save(next,version);await tx.event(next,a.userId,"PUBLISHED")
      await tx.recordReceipt(a.companyId,a.userId,key,intent,next);await tx.notify(next,employee.userId)
      return project(next)
    })
  }
  private async blockChanged(identity:Identity,id:string,version:number,error:unknown) {
    if(!(error instanceof HrError) || !["CONTENT_CHANGED","INVALID_PDF","DRIVE_PRIVATE_REQUIRED"].includes(error.code))return
    await this.repo.run(identity,async(tx,a)=>{
      const doc=await tx.find(a.companyId,id)
      if(doc&&doc.version===version&&canRead(a,doc)){
        const next={...doc,status:"BLOCKED",version:version+1,reviewedById:null}
        await tx.save(next,version);await tx.event(next,a.userId,"DELIVERY_BLOCKED")
      }
    })
  }
  async download(identity:Identity,id:string) {
    const initial=await this.repo.run(identity,async(tx,a)=>{
      const doc=await tx.find(a.companyId,id)
      if(!doc||!canRead(a,doc)||!["READY","REVIEWED","PUBLISHED"].includes(doc.status))throw new HrError("NOT_FOUND",404)
      return {doc,storage:await tx.storage(a.companyId)}
    })
    const {drive,storage}=await this.binding(identity.companyId,initial.storage)
    let bytes:Uint8Array
    try {bytes=await verifiedDownload(drive,initial.doc)}catch(e){await this.blockChanged(identity,id,initial.doc.version,e);throw e}
    assertContent(bytes,initial.doc.sha256,initial.doc.size)
    // Revocation or reclassification during the remote read wins before bytes leave the server.
    await this.repo.run(identity,async(tx,a)=>{
      await this.checkStorage(tx,a,storage)
      const doc=await tx.find(a.companyId,id)
      if(!doc||!canRead(a,doc)||doc.version!==initial.doc.version)throw new HrError("NOT_FOUND",404)
    })
    const kind=detectKind(bytes)??"pdf"
    return {bytes,kind,title:`document-${initial.doc.period}.${KIND_EXTENSION[kind]}`}
  }
}
