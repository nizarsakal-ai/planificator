import { randomUUID } from "node:crypto"
import { assertContent, canRead, detectKind, digest, DOWNLOADABLE_STATUSES, draftSchema, employeeDraftsEnabled, employeeSelectionSchema, employeeVisible, HrError, KIND_EXTENSION, MESSAGE_PAGE, messageSchema, privateSpaceEnabled, recognitionEnabled, REQUEST_SCAN_PAGE, requireCapability, reviewSchema, SUBMISSION_INTENT_PREFIX, submissionSchema, validateDocument, type Actor, type DocumentKind, type DraftInput, type Identity } from "./domain"
import { verifiedDownload, type PrivateDrive } from "./drive"
import { recognize, type EmployeeRef, type Proposal } from "./recognition/engine"
import type { Reading } from "./recognition/ocr"
import type { ExternalRecognition } from "./recognition/external"

export type DocumentRecord = { id:string; companyId:string; employeeId:string; category:string; period:string; title:string;
  status:string; version:number; sha256:string; size:number; driveFileId:string; rootId:string; uploadedById:string;
  uploadKey:string; uploadIntent:string; reviewedById:string|null; createdAt:Date; publishedAt:Date|null }
export type Storage = { companyId:string; rootId:string; connectionGeneration:string; accountEmail:string }
export type Notice = {id:string;companyId:string;documentId:string;publishedVersion:number;userId:string;status:string;attemptAt:Date|null;sentAt:Date|null}
export type PublicDocument = Pick<DocumentRecord,"id"|"employeeId"|"category"|"period"|"title"|"status"|"version"|"size"|"createdAt"|"publishedAt"|"reviewedById">&{fromEmployee?:boolean}
export function project(doc:DocumentRecord):PublicDocument {
  const {id,employeeId,category,period,title,status,version,size,createdAt,publishedAt,reviewedById}=doc
  const base={id,employeeId,category,period,title,status,version,size,createdAt,publishedAt,reviewedById}
  // Origine factuelle d'une pièce déposée par le salarié (marqueur posé au dépôt, jamais déduit d'un nom).
  return doc.uploadIntent?.startsWith(SUBMISSION_INTENT_PREFIX)?{...base,fromEmployee:true}:base
}
export type MessageRecord = { id:string; companyId:string; employeeId:string; authorId:string; authorSide:"HR"|"EMPLOYEE";
  kind:"MESSAGE"|"REQUEST"; body:string; documentId:string|null; requestStatus:"OPEN"|"DONE"|null; createKey:string; createdAt:Date; readAt:Date|null }
export type PublicMessage = Pick<MessageRecord,"id"|"authorSide"|"kind"|"body"|"documentId"|"requestStatus"|"createdAt"|"readAt">&{mine:boolean}
function projectMessage(m:MessageRecord,userId:string):PublicMessage {
  const {id,authorSide,kind,body,documentId,requestStatus,createdAt,readAt}=m
  return {id,authorSide,kind,body,documentId,requestStatus,createdAt,readAt,mine:m.authorId===userId}
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
  /** Espace privé : doublon limité au même salarié (pas d'indice sur les documents des autres). */
  ownDuplicate(companyId:string,employeeId:string,category:string,period:string,sha256:string):Promise<boolean>
  messages(companyId:string,employeeId:string,cursor?:string):Promise<MessageRecord[]>
  message(companyId:string,id:string):Promise<MessageRecord|null>
  messageByKey(companyId:string,authorId:string,key:string):Promise<MessageRecord|null>
  insertMessage(value:MessageRecord):Promise<void>
  markRead(companyId:string,employeeId:string,ids:string[],at:Date):Promise<void>
  closeRequest(companyId:string,employeeId:string,id:string):Promise<void>
  /** Une page d'identifiants des demandes de pièce de ce salarié, par identifiant croissant après `after` (REQUEST_SCAN_PAGE au plus). */
  requestIdsPage(companyId:string,employeeId:string,after?:string):Promise<string[]>
  recordAccess(doc:DocumentRecord,userId:string,at:Date):Promise<void>
  accesses(companyId:string,documentIds:string[],userId:string):Promise<{documentId:string;version:number;firstAt:Date}[]>
  createDraft(companyId:string,createdById:string,input:Omit<DraftInput,"key">&{key:string},passwordHash:string):Promise<EmployeeRef>
}
/** Lecture locale : texte brut (couche texte) ou lecture complète avec son statut (OCR, moteur absent, échec, illisible). */
export type TextExtractor=(bytes:Uint8Array,kind:DocumentKind)=>Promise<string|Reading>
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
   * Lecture locale d'abord (couche texte PDF, sinon OCR local) ; secours externe seulement s'il est branché et activé.
   */
  async recognize(identity:Identity,bytes:Uint8Array,fileName:string):Promise<Proposal&{sha256:string;kind:DocumentKind}> {
    if(!recognitionEnabled())throw new HrError("DISABLED",404)
    const {hash,kind}=validateDocument(bytes)
    const employees=await this.repo.run(identity,async(tx,a)=>{requireCapability(a,"IMPORT");requireCapability(a,"READ");return tx.employees(a.companyId)})
    const started=Date.now()
    const read=await this.extract(bytes,kind).catch(():Reading=>({text:"",status:"TECHNICAL_FAILURE",reason:"OCR_ERROR",durationMs:Date.now()-started,pages:1,rotation:null,confidence:null,mrzFound:false}))
    let {text,...reading}:Reading=typeof read==="string"
      ?{text:read,status:read.trim()?"TEXT_LAYER":"UNREADABLE",reason:null,durationMs:Date.now()-started,pages:1,rotation:null,confidence:null,mrzFound:false}:read
    let external=false
    if(!text.trim()&&this.external){const result=await this.external({bytes,kind}).catch(()=>null);if(result?.text){text=result.text;external=true}}
    const proposal=recognize({text,fileName:fileName.slice(0,255),employees,now:this.clock(),reading})
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
    if (!storage) throw new HrError("STORAGE_NOT_READY",409,"stockage_absent")
    const binding=await this.connect(companyId)
    if (binding.accountEmail!==storage.accountEmail) throw new HrError("STORAGE_NOT_READY",409,"compte_drive_different")
    if (binding.generation!==storage.connectionGeneration) throw new HrError("STORAGE_NOT_READY",409,"generation_differente")
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
    if(!storage)throw new HrError("STORAGE_NOT_READY",409,"stockage_absent")
    const binding=await this.connect(identity.companyId)
    if(binding.accountEmail!==storage.accountEmail)throw new HrError("STORAGE_NOT_READY",409,"compte_drive_different")
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
      // Suivi factuel côté RH : première remise réussie de la version publiée au salarié (pas une signature).
      let opened=new Map<string,Date>()
      if(manage&&selected&&privateSpaceEnabled()){
        const employee=await tx.employee(a.companyId,selected)
        if(employee){
          const published=docs.filter(d=>d.status==="PUBLISHED")
          const rows=published.length?await tx.accesses(a.companyId,published.map(d=>d.id),employee.userId):[]
          opened=new Map(rows.filter(r=>published.some(d=>d.id===r.documentId&&d.version===r.version)).map(r=>[r.documentId,r.firstAt]))
        }
      }
      return docs.map(doc=>({...project(doc),canResume:manage&&doc.uploadedById===a.userId,...(opened.has(doc.id)?{openedAt:opened.get(doc.id)}:{})}))
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
    if(!connection)throw new HrError("STORAGE_NOT_READY",409,"connexion_drive_non_active")
    if(connection.accountEmail!==storage.accountEmail)throw new HrError("STORAGE_NOT_READY",409,"compte_drive_different")
    if(connection.generation!==storage.connectionGeneration)throw new HrError("STORAGE_NOT_READY",409,"generation_differente")
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
      if(!doc||!canRead(a,doc)||!(DOWNLOADABLE_STATUSES as readonly string[]).includes(doc.status))throw new HrError("NOT_FOUND",404)
      // Une pièce reçue n'est lisible que si l'espace privé est actif.
      if(doc.status==="RECEIVED"&&!privateSpaceEnabled())throw new HrError("NOT_FOUND",404)
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
      // Fait serveur seulement : version publiée remise avec succès au salarié destinataire lui-même.
      if(privateSpaceEnabled()&&doc.status==="PUBLISHED"&&a.employeeId===doc.employeeId)await tx.recordAccess(doc,a.userId,this.clock())
    })
    const kind=detectKind(bytes)??"pdf"
    return {bytes,kind,title:`document-${initial.doc.period}.${KIND_EXTENSION[kind]}`}
  }

  // ——— Espace privé RH ↔ salarié ———————————————————————————————————————————————————————————————
  private requirePrivateSpace(){if(!privateSpaceEnabled())throw new HrError("DISABLED",404)}
  /** Côté du fil : RH si un salarié est désigné (habilitation READ et salarié actif de la société), sinon le salarié lui-même. */
  private async participant(tx:Tx,a:Actor,employeeId?:string):Promise<{side:"HR"|"EMPLOYEE";employeeId:string;employeeUserId:string}>{
    if(employeeId){
      requireCapability(a,"READ")
      const employee=await tx.employee(a.companyId,employeeId)
      if(!employee)throw new HrError("NOT_FOUND",404)
      return {side:"HR",employeeId:employee.id,employeeUserId:employee.userId}
    }
    if(!a.employeeId)throw new HrError("FORBIDDEN",403)
    if(!await tx.employee(a.companyId,a.employeeId))throw new HrError("FORBIDDEN",403)
    return {side:"EMPLOYEE",employeeId:a.employeeId,employeeUserId:a.userId}
  }
  private async openRequest(tx:Tx,companyId:string,employeeId:string,requestId:string){
    const request=await tx.message(companyId,requestId)
    if(!request||request.employeeId!==employeeId||request.kind!=="REQUEST")throw new HrError("NOT_FOUND",404)
    if(request.requestStatus!=="OPEN")throw new HrError("REQUEST_CLOSED",409)
  }
  /** Intention d'un dépôt salarié : contenu, métadonnées et demande éventuelle (la clé n'en fait pas partie). */
  private submissionIntent(category:string,period:string,title:string,requestId:string|null,hash:string,size:number){
    return SUBMISSION_INTENT_PREFIX+digest(JSON.stringify(["SUBMIT",category,period,title,requestId,hash,size]))
  }
  /** Reçu existant : même société, même salarié, même auteur, même intention ; sinon refus. */
  private ownReceipt(previous:DocumentRecord,a:Actor,employeeId:string,intent:string){
    if(previous.companyId!==a.companyId||previous.employeeId!==employeeId||previous.uploadedById!==a.userId||previous.uploadIntent!==intent)throw new HrError("RECEIPT_CONFLICT",409)
    return previous
  }
  /** Dépôt d'une pièce par le salarié vers les RH : toujours pour lui-même, reçue à vérifier, jamais publiée automatiquement. */
  async submit(identity:Identity,raw:unknown,bytes:Uint8Array) {
    this.requirePrivateSpace()
    const input=submissionSchema.parse(raw)
    const {hash,kind}=validateDocument(bytes)
    const requestId=input.requestId??null
    const intent=this.submissionIntent(input.category,input.period,input.title,requestId,hash,bytes.length)
    // C1 : le reçu de cette clé est examiné AVANT d'exiger une demande ouverte, pour qu'un rejeu identique après succès
    // (réponse HTTP perdue) ou la reprise d'une réservation antérieure restent possibles même si la demande est close.
    const first=await this.repo.run(identity,async(tx,a)=>{
      const {employeeId}=await this.participant(tx,a)
      const found=await tx.upload(a.companyId,a.userId,input.key)
      const previous=found?this.ownReceipt(found,a,employeeId,intent):null
      if(!previous&&input.requestId)await this.openRequest(tx,a.companyId,employeeId,input.requestId)
      return {previous,storage:await tx.storage(a.companyId)}
    })
    if(first.previous&&first.previous.status!=="RECEIVING")return project(first.previous)
    const {drive}=await this.binding(identity.companyId,first.storage)
    const storage=first.storage!
    await drive.checkPrivate(storage.rootId)
    let doc=first.previous
    if(!doc){
      const remoteId=await drive.allocate()
      doc=await this.repo.run(identity,async(tx,a)=>{
        const {employeeId}=await this.participant(tx,a)
        await this.checkStorage(tx,a,storage)
        const found=await tx.upload(a.companyId,a.userId,input.key)
        if(found)return this.ownReceipt(found,a,employeeId,intent)
        if(input.requestId)await this.openRequest(tx,a.companyId,employeeId,input.requestId)
        if(await tx.ownDuplicate(a.companyId,employeeId,input.category,input.period,hash))throw new HrError("DUPLICATE",409)
        const value:DocumentRecord={id:randomUUID(),companyId:a.companyId,employeeId,category:input.category,period:input.period,
          title:input.title,status:"RECEIVING",version:1,sha256:hash,size:bytes.length,driveFileId:remoteId,rootId:storage.rootId,
          uploadedById:a.userId,uploadKey:input.key,uploadIntent:intent,reviewedById:null,createdAt:this.clock(),publishedAt:null}
        await tx.insert(value);await tx.event(value,a.userId,"SUBMISSION_RESERVED");return value
      })
      if(doc.status!=="RECEIVING")return project(doc)
    }
    return this.completeSubmission(identity,storage,drive,doc,requestId,bytes,kind)
  }
  /**
   * C2 : reprise explicite par le salarié de SON dépôt resté « Envoi en cours » (échec Drive, onglet fermé), depuis une
   * nouvelle session d'écran, en resélectionnant le même fichier. Le serveur vérifie identité (société, salarié, auteur,
   * marqueur de dépôt salarié), contenu (empreinte et taille) et intention (recalculée, demande éventuelle retrouvée).
   * Jamais un brouillon RH, jamais le dépôt d'un autre : ces cas répondent « introuvable ».
   */
  async resumeSubmission(identity:Identity,id:string,version:number,bytes:Uint8Array) {
    this.requirePrivateSpace()
    const {kind}=validateDocument(bytes)
    const initial=await this.repo.run(identity,async(tx,a)=>{
      const {employeeId}=await this.participant(tx,a)
      const doc=await tx.find(a.companyId,id)
      if(!doc||doc.employeeId!==employeeId||doc.uploadedById!==a.userId||!doc.uploadIntent.startsWith(SUBMISSION_INTENT_PREFIX))throw new HrError("NOT_FOUND",404)
      if(doc.status!=="RECEIVING"||doc.version!==version)throw new HrError("CONFLICT",409)
      assertContent(bytes,doc.sha256,doc.size)
      const matches=(r:string|null)=>this.submissionIntent(doc.category,doc.period,doc.title,r,doc.sha256,doc.size)===doc.uploadIntent
      // Recherche complète, page par page, dans les seules demandes de ce salarié (aucune limite d'ancienneté).
      let requestId:string|null|undefined=matches(null)?null:undefined
      for(let after:string|undefined;requestId===undefined;){
        const page=await tx.requestIdsPage(a.companyId,employeeId,after)
        requestId=page.find(matches)
        if(requestId!==undefined||page.length<REQUEST_SCAN_PAGE)break
        after=page[page.length-1]
      }
      if(requestId===undefined)throw new HrError("RECEIPT_CONFLICT",409)
      return {doc,requestId,storage:await tx.storage(a.companyId)}
    })
    const {drive}=await this.binding(identity.companyId,initial.storage)
    const storage=initial.storage!
    if(initial.doc.rootId!==storage.rootId)throw new HrError("CONFLICT",409)
    await drive.checkPrivate(storage.rootId)
    return this.completeSubmission(identity,storage,drive,initial.doc,initial.requestId,bytes,kind)
  }
  /** Écriture Drive vérifiée puis passage RECEIVING → RECEIVED ; la demande liée n'est close que si elle est encore ouverte. */
  private async completeSubmission(identity:Identity,storage:Storage,drive:PrivateDrive,doc:DocumentRecord,requestId:string|null,bytes:Uint8Array,kind:DocumentKind) {
    await drive.put(doc.driveFileId,doc.rootId,bytes,kind)
    await verifiedDownload(drive,doc)
    return this.repo.run(identity,async(tx,a)=>{
      const {employeeId}=await this.participant(tx,a)
      await this.checkStorage(tx,a,storage)
      const current=await tx.find(a.companyId,doc.id);if(!current)throw new HrError("NOT_FOUND",404)
      if(current.status!=="RECEIVING")return project(current)
      if(current.uploadedById!==a.userId||current.employeeId!==employeeId||current.version!==doc.version)throw new HrError("CONFLICT",409)
      const next={...current,status:"RECEIVED",version:current.version+1}
      await tx.save(next,current.version);await tx.event(next,a.userId,"SUBMITTED")
      // Transactions sérialisées par le verrou consultatif de société : une demande déjà close est simplement laissée close.
      if(requestId){const request=await tx.message(a.companyId,requestId);if(request?.requestStatus==="OPEN"&&request.employeeId===employeeId)await tx.closeRequest(a.companyId,employeeId,request.id)}
      return project(next)
    })
  }
  /** RH : une pièce reçue entre dans le circuit existant de vérification (READY) ; rien n'est publié ici. */
  async accept(identity:Identity,id:string,version:number) {
    this.requirePrivateSpace()
    return this.repo.run(identity,async(tx,a)=>{
      requireCapability(a,"IMPORT");requireCapability(a,"READ")
      const doc=await tx.find(a.companyId,id)
      if(!doc)throw new HrError("NOT_FOUND",404)
      if(doc.status!=="RECEIVED"||doc.version!==version)throw new HrError("CONFLICT",409)
      if(!await tx.employee(a.companyId,doc.employeeId))throw new HrError("NOT_FOUND",404)
      const next={...doc,status:"READY",reviewedById:null,version:version+1}
      await tx.save(next,version);await tx.event(next,a.userId,"SUBMISSION_ACCEPTED");return project(next)
    })
  }
  /** Fil privé ; « lu » n'est posé que sur les messages de l'autre partie effectivement renvoyés par ce chargement. */
  async thread(identity:Identity,employeeId?:string,cursor?:string) {
    this.requirePrivateSpace()
    const selected=employeeSelectionSchema.parse(employeeId)
    if(cursor!==undefined&&!/^[A-Za-z0-9_-]{1,128}$/.test(cursor))throw new HrError("INVALID_INPUT")
    return this.repo.run(identity,async(tx,a)=>{
      const {side,employeeId:target}=await this.participant(tx,a,selected)
      const rows=await tx.messages(a.companyId,target,cursor)
      const page=rows.slice(0,MESSAGE_PAGE),now=this.clock()
      const unread=page.filter(m=>m.authorSide!==side&&!m.readAt).map(m=>m.id)
      if(unread.length)await tx.markRead(a.companyId,target,unread,now)
      return {side,messages:page.map(m=>projectMessage(unread.includes(m.id)?{...m,readAt:now}:m,a.userId)),
        nextCursor:rows.length>MESSAGE_PAGE?page[page.length-1].id:null}
    })
  }
  async post(identity:Identity,raw:unknown) {
    this.requirePrivateSpace()
    const input=messageSchema.parse(raw)
    return this.repo.run(identity,async(tx,a)=>{
      const {side,employeeId,employeeUserId}=await this.participant(tx,a,input.employeeId)
      if(side==="HR")requireCapability(a,"IMPORT")
      if(input.kind==="REQUEST"&&side!=="HR")throw new HrError("FORBIDDEN",403)
      const previous=await tx.messageByKey(a.companyId,a.userId,input.key)
      if(previous){
        if(previous.employeeId!==employeeId||previous.body!==input.body||previous.kind!==input.kind||previous.documentId!==(input.documentId??null))throw new HrError("RECEIPT_CONFLICT",409)
        return projectMessage(previous,a.userId)
      }
      if(input.documentId){
        // Pièce jointe : document de ce salarié, que le salarié peut lui-même voir (jamais un brouillon RH).
        const doc=await tx.find(a.companyId,input.documentId)
        if(!doc||!canRead(a,doc)||!employeeVisible(doc,employeeId,employeeUserId))throw new HrError("NOT_FOUND",404)
      }
      const value:MessageRecord={id:randomUUID(),companyId:a.companyId,employeeId,authorId:a.userId,authorSide:side,kind:input.kind,
        body:input.body,documentId:input.documentId??null,requestStatus:input.kind==="REQUEST"?"OPEN":null,createKey:input.key,createdAt:this.clock(),readAt:null}
      await tx.insertMessage(value)
      return projectMessage(value,a.userId)
    })
  }
}
