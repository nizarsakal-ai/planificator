import { after,before,describe,it } from "node:test"
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { PrismaClient } from "@prisma/client"
import { digest,HrError,REQUEST_SCAN_PAGE } from "../../src/lib/hr-documents/domain"
import { PrismaHrRepository } from "../../src/lib/hr-documents/repository"
import { HrDocumentsService } from "../../src/lib/hr-documents/service"
import type { PrivateDrive } from "../../src/lib/hr-documents/drive"

// Espace privé RH ↔ salarié × PostgreSQL jetable : données synthétiques uniquement, Google simulé, aucun e-mail.
const testUrl=process.env.HR_DOCUMENT_TEST_DATABASE_URL
if(!testUrl)throw new Error("HR_DOCUMENT_TEST_DATABASE_URL required: an isolated local disposable database")
const parsed=new URL(testUrl)
if(!["127.0.0.1","localhost"].includes(parsed.hostname)||parsed.pathname!=="/planificator_hr_docs_test")throw new Error("Disposable local HR test database only")
const db=new PrismaClient({datasources:{db:{url:testUrl}},log:[]})
const run=randomUUID().slice(0,8);let seq=0
const pdf=(suffix="one")=>Buffer.from(`%PDF-1.4\nsynthetic private space ${suffix}\n%%EOF\n`)
const savedFlag=process.env.HR_DOCUMENT_PRIVATE_SPACE_ENABLED
before(()=>{process.env.HR_DOCUMENT_PRIVATE_SPACE_ENABLED="true"})
after(async()=>{if(savedFlag===undefined)delete process.env.HR_DOCUMENT_PRIVATE_SPACE_ENABLED;else process.env.HR_DOCUMENT_PRIVATE_SPACE_ENABLED=savedFlag;await db.$disconnect()})
class FakeDrive implements PrivateDrive {
  roots=new Set<string>();files=new Map<string,{root:string;bytes:Uint8Array}>();corrupt=new Set<string>();failPut=false
  // Barrière : retient les écritures jusqu'à ce que `n` dépôts aient tous réservé puis atteint Drive.
  private gate:{n:number;waiting:(()=>void)[]}|null=null
  holdPuts(n:number){const gate={n,waiting:[] as (()=>void)[]};this.gate=gate
    // Garde-fou : si un dépôt n'atteint jamais Drive, la barrière s'ouvre et le test échoue sur ses assertions au lieu de bloquer.
    setTimeout(()=>{if(this.gate===gate){this.gate=null;gate.waiting.forEach(r=>r())}},10_000).unref()}
  async allocate(){return randomUUID()}
  async checkPrivate(id:string,parent?:string){if(parent?this.files.get(id)?.root!==parent:!this.roots.has(id))throw new HrError("DRIVE_UNAVAILABLE",503)}
  async createRoot(id:string){this.roots.add(id)}
  async put(id:string,root:string,bytes:Uint8Array){if(this.failPut)throw new HrError("DRIVE_UNAVAILABLE",503)
    const gate=this.gate
    if(gate){await new Promise<void>(release=>{gate.waiting.push(release);if(gate.waiting.length>=gate.n){this.gate=null;gate.waiting.forEach(r=>r())}})}
    if(!this.files.has(id))this.files.set(id,{root,bytes:bytes.slice()})}
  async read(id:string){const v=this.files.get(id);if(!v)throw new HrError("DRIVE_UNAVAILABLE",503);return this.corrupt.has(id)?pdf("altered"):v.bytes.slice()}
}
async function fixture(){
  const n=`${run}-${++seq}`,companyId=`ps-c-${n}`
  const hr={userId:`ps-hr-${n}`,companyId},reader={userId:`ps-rd-${n}`,companyId},leader={userId:`ps-tl-${n}`,companyId}
  const a={userId:`ps-a-${n}`,companyId},b={userId:`ps-b-${n}`,companyId}
  await db.company.create({data:{id:companyId,name:"Synthetic private space company",slug:companyId}})
  for(const [who,role] of [[hr,"ADMIN"],[reader,"ADMIN"],[leader,"TEAM_LEADER"],[a,"EMPLOYEE"],[b,"EMPLOYEE"]] as const)
    await db.user.create({data:{id:who.userId,email:`${who.userId}@example.test`,password:"not-a-real-credential",role,companyId}})
  const employeeA=`ps-ea-${n}`,employeeB=`ps-eb-${n}`,employeeLeader=`ps-el-${n}`
  for(const [id,userId] of [[employeeA,a.userId],[employeeB,b.userId],[employeeLeader,leader.userId]])
    await db.employee.create({data:{id,userId,companyId,firstName:"Synthetic",lastName:"Person"}})
  await db.worksitePhotoDriveConnection.create({data:{companyId,accountEmail:"storage@example.test",accessToken:"synthetic-encrypted-access",refreshToken:"synthetic-encrypted-refresh",tokenExpiry:new Date(Date.now()+3600_000),connectedById:hr.userId}})
  // Habilitations explicites par utilisateur et société : le chef d'équipe et l'ADMIN « lecteur » n'ont pas IMPORT.
  const grants=JSON.stringify([{...hr,capabilities:["IMPORT","PUBLISH","READ","CONFIGURE"]},{...reader,capabilities:["READ"]}])
  const drive=new FakeDrive(),repo=new PrismaHrRepository(db,()=>grants)
  const connect=async()=>{const c=await db.worksitePhotoDriveConnection.findUniqueOrThrow({where:{companyId}});return {drive,generation:digest(c.refreshToken),accountEmail:c.accountEmail}}
  const service=new HrDocumentsService(repo,connect)
  await service.configure(hr)
  const rhDoc=(employeeId=employeeA,suffix=randomUUID())=>service.import(hr,{employeeId,category:"PAYSLIP",period:"2026-11",title:"Synthetic payslip",key:randomUUID()},pdf(suffix))
  const published=async(employeeId=employeeA)=>{
    const doc=await rhDoc(employeeId)
    const r=await service.review(hr,doc.id,{employeeId,category:"PAYSLIP",period:"2026-11",title:"Synthetic payslip",key:randomUUID(),expectedVersion:doc.version})
    return service.publish(hr,doc.id,r.version,randomUUID())
  }
  const submit=(who=a,extra:Record<string,unknown>={},suffix:string=randomUUID())=>service.submit(who,{category:"OTHER",period:"2026-11",title:"Synthetic certificate",key:randomUUID(),...extra},pdf(suffix))
  return {companyId,hr,reader,leader,a,b,employeeA,employeeB,drive,service,rhDoc,published,submit}
}
const ids=(rows:{id:string}[])=>rows.map(r=>r.id).sort()

describe("espace privé RH ↔ salarié : contrôles serveur",()=>{
  it("dépôt salarié : toujours pour lui-même, reçu à vérifier, jamais validé ni publié automatiquement",async()=>{
    const f=await fixture()
    const doc=await f.submit()
    assert.equal(doc.status,"RECEIVED");assert.equal(doc.employeeId,f.employeeA);assert.equal(doc.fromEmployee,true)
    await assert.rejects(f.service.submit(f.a,{employeeId:f.employeeB,category:"OTHER",period:"2026-11",title:"x",key:randomUUID()},pdf("inject")))
    await assert.rejects(f.service.submit(f.hr,{category:"OTHER",period:"2026-11",title:"x",key:randomUUID()},pdf("no-profile")),/FORBIDDEN/)
    const events=await db.hrDocumentEvent.findMany({where:{documentId:doc.id},orderBy:{version:"asc"}})
    assert.deepEqual(events.map(e=>e.action),["SUBMISSION_RESERVED","SUBMITTED"])
    const row=await db.hrDocument.findUniqueOrThrow({where:{id:doc.id}})
    assert.equal(row.publishedAt,null);assert.equal(row.reviewedById,null)
  })
  it("même clé : même pièce renvoyée ; contenu différent refusé ; doublon limité au même salarié",async()=>{
    const f=await fixture(),key=randomUUID()
    const first=await f.service.submit(f.a,{category:"OTHER",period:"2026-11",title:"Synthetic",key},pdf("same"))
    const again=await f.service.submit(f.a,{category:"OTHER",period:"2026-11",title:"Synthetic",key},pdf("same"))
    assert.equal(again.id,first.id)
    await assert.rejects(f.service.submit(f.a,{category:"OTHER",period:"2026-11",title:"Synthetic",key},pdf("other")),/RECEIPT_CONFLICT/)
    await assert.rejects(f.submit(f.a,{title:"Synthetic"},"same"),/DUPLICATE/)
    // Même fichier chez un autre salarié : aucun indice renvoyé au salarié B.
    const crossed=await f.submit(f.b,{},"same");assert.equal(crossed.status,"RECEIVED")
  })
  it("visibilité : le salarié voit ses documents publiés et ses dépôts, jamais un brouillon RH ni les pièces d'un autre",async()=>{
    const f=await fixture(),g=await fixture()
    const pub=await f.published(),draft=await f.rhDoc(),own=await f.submit(),otherOwn=await f.submit(f.b)
    assert.deepEqual(ids(await f.service.list(f.a)),ids([pub,own]))
    assert.deepEqual(ids(await f.service.list(f.b)),ids([otherOwn]))
    assert.equal((await g.service.list(g.a)).length,0)
    await assert.rejects(f.service.download(f.a,draft.id),/NOT_FOUND/)
    await assert.rejects(f.service.download(f.b,own.id),/NOT_FOUND/)
    await assert.rejects(f.service.download(f.b,pub.id),/NOT_FOUND/)
    await assert.rejects(g.service.download(g.hr,own.id),/NOT_FOUND/)
    assert.equal((await f.service.download(f.a,own.id)).bytes.length>0,true)
    assert.equal((await f.service.download(f.hr,own.id)).bytes.length>0,true)
    // Chef d'équipe sans habilitation RH : aucun accès aux pièces de son collègue.
    await assert.rejects(f.service.download(f.leader,own.id),/NOT_FOUND/)
    await assert.rejects(f.service.list(f.leader,true,undefined,f.employeeA),/FORBIDDEN/)
  })
  it("passage en vérification : IMPORT exigé, statut READY, puis revue et publication séparées",async()=>{
    const f=await fixture(),own=await f.submit()
    await assert.rejects(f.service.accept(f.a,own.id,own.version),/FORBIDDEN/)
    await assert.rejects(f.service.accept(f.reader,own.id,own.version),/FORBIDDEN/)
    const ready=await f.service.accept(f.hr,own.id,own.version)
    assert.equal(ready.status,"READY")
    await assert.rejects(f.service.accept(f.hr,own.id,own.version),/CONFLICT/)
    // Le salarié suit sa pièce (« en vérification ») sans voir les brouillons RH créés par les RH.
    assert.ok((await f.service.list(f.a)).some(d=>d.id===own.id&&d.status==="READY"))
  })
  it("suivi factuel : seule une remise réussie au salarié destinataire est enregistrée, une fois par version",async()=>{
    const f=await fixture(),pub=await f.published()
    await f.service.download(f.hr,pub.id)
    assert.equal(await db.hrDocumentAccess.count({where:{documentId:pub.id}}),0)
    await f.service.download(f.a,pub.id);await f.service.download(f.a,pub.id)
    assert.equal(await db.hrDocumentAccess.count({where:{documentId:pub.id}}),1)
    const listed=await f.service.list(f.hr,true,undefined,f.employeeA)
    assert.ok(listed.find(d=>d.id===pub.id)&&"openedAt" in listed.find(d=>d.id===pub.id)!)
    const failing=await f.published()
    const row=await db.hrDocument.findUniqueOrThrow({where:{id:failing.id}});f.drive.corrupt.add(row.driveFileId)
    await assert.rejects(f.service.download(f.a,failing.id))
    assert.equal(await db.hrDocumentAccess.count({where:{documentId:failing.id}}),0)
  })
  it("messages : fil limité au salarié, demande réservée aux RH, « lu » posé seulement au chargement par l'autre partie",async()=>{
    const f=await fixture(),g=await fixture()
    const request=await f.service.post(f.hr,{employeeId:f.employeeA,kind:"REQUEST",body:"Merci de transmettre une attestation synthétique.",key:randomUUID()})
    assert.equal(request.requestStatus,"OPEN");assert.equal(request.readAt,null)
    await assert.rejects(f.service.post(f.a,{kind:"REQUEST",body:"x",key:randomUUID()}),/FORBIDDEN/)
    await assert.rejects(f.service.post(f.reader,{employeeId:f.employeeA,body:"x",key:randomUUID()}),/FORBIDDEN/)
    await assert.rejects(f.service.post(f.leader,{employeeId:f.employeeA,body:"x",key:randomUUID()}),/FORBIDDEN/)
    await assert.rejects(f.service.thread(f.b,f.employeeA),/FORBIDDEN/)
    await assert.rejects(g.service.thread(g.hr,f.employeeA),/NOT_FOUND/)
    assert.equal((await f.service.thread(f.b)).messages.length,0)
    const hrView=await f.service.thread(f.hr,f.employeeA)
    assert.equal(hrView.messages[0].readAt,null,"le chargement par l'auteur ne vaut pas lecture")
    const seen=await f.service.thread(f.a)
    assert.equal(seen.side,"EMPLOYEE");assert.notEqual(seen.messages[0].readAt,null)
    const reply=await f.service.post(f.a,{body:"Réponse synthétique.",key:randomUUID()})
    assert.equal(reply.mine,true)
    assert.notEqual((await f.service.thread(f.hr,f.employeeA)).messages.find(m=>m.id===request.id)!.readAt,null)
    assert.equal(await db.hrDocumentNotice.count({where:{companyId:f.companyId}}),0,"aucune notification e-mail créée par les messages")
  })
  it("pièces jointes : uniquement un document de ce salarié qu'il peut lui-même voir",async()=>{
    const f=await fixture(),pub=await f.published(),draft=await f.rhDoc(),otherPub=await f.published(f.employeeB),own=await f.submit()
    await assert.rejects(f.service.post(f.hr,{employeeId:f.employeeA,body:"x",documentId:draft.id,key:randomUUID()}),/NOT_FOUND/)
    await assert.rejects(f.service.post(f.hr,{employeeId:f.employeeA,body:"x",documentId:otherPub.id,key:randomUUID()}),/NOT_FOUND/)
    await assert.rejects(f.service.post(f.b,{body:"x",documentId:own.id,key:randomUUID()}),/NOT_FOUND/)
    assert.equal((await f.service.post(f.hr,{employeeId:f.employeeA,body:"x",documentId:pub.id,key:randomUUID()})).documentId,pub.id)
    assert.equal((await f.service.post(f.a,{body:"x",documentId:own.id,key:randomUUID()})).documentId,own.id)
  })
  it("demande de pièce close par le dépôt qui y répond ; demande d'un autre salarié refusée",async()=>{
    const f=await fixture()
    const request=await f.service.post(f.hr,{employeeId:f.employeeA,kind:"REQUEST",body:"Pièce synthétique demandée.",key:randomUUID()})
    await assert.rejects(f.submit(f.b,{requestId:request.id}),/NOT_FOUND/)
    await f.submit(f.a,{requestId:request.id})
    assert.equal((await db.hrMessage.findUniqueOrThrow({where:{id:request.id}})).requestStatus,"DONE")
    await assert.rejects(f.submit(f.a,{requestId:request.id}),/REQUEST_CLOSED/)
  })
  it("idempotence des messages et pagination du fil (50 par page, curseur d'un autre fil refusé)",async()=>{
    const f=await fixture(),key=randomUUID()
    const m=await f.service.post(f.a,{body:"Synthétique",key})
    assert.equal((await f.service.post(f.a,{body:"Synthétique",key})).id,m.id)
    await assert.rejects(f.service.post(f.a,{body:"Autre",key}),/RECEIPT_CONFLICT/)
    for(let i=0;i<55;i++)await f.service.post(f.hr,{employeeId:f.employeeA,body:`Synthétique ${i}`,key:randomUUID()})
    const first=await f.service.thread(f.hr,f.employeeA)
    assert.equal(first.messages.length,50);assert.ok(first.nextCursor)
    const second=await f.service.thread(f.hr,f.employeeA,first.nextCursor!)
    assert.equal(second.messages.length,6);assert.equal(second.nextCursor,null)
    const other=await f.service.post(f.b,{body:"Fil B",key:randomUUID()})
    await assert.rejects(f.service.thread(f.hr,f.employeeA,other.id),/INVALID_INPUT/)
  })
  it("drapeau absent : dépôts, messages et passage en vérification indisponibles ; aucune pièce reçue lisible ni accès enregistré",async()=>{
    const f=await fixture(),own=await f.submit(),pub=await f.published()
    delete process.env.HR_DOCUMENT_PRIVATE_SPACE_ENABLED
    try{
      await assert.rejects(f.submit(),/DISABLED/)
      await assert.rejects(f.service.thread(f.a),/DISABLED/)
      await assert.rejects(f.service.post(f.a,{body:"x",key:randomUUID()}),/DISABLED/)
      await assert.rejects(f.service.accept(f.hr,own.id,own.version),/DISABLED/)
      await assert.rejects(f.service.download(f.hr,own.id),/NOT_FOUND/)
      assert.deepEqual(ids(await f.service.list(f.a)),ids([pub]))
      await f.service.download(f.a,pub.id)
      assert.equal(await db.hrDocumentAccess.count({where:{documentId:pub.id}}),0)
    }finally{process.env.HR_DOCUMENT_PRIVATE_SPACE_ENABLED="true"}
  })
  // ——— v3 : corrections C1, C2, C3 et concurrence réelle (revue indépendante Codex v2) ———
  it("C1 : rejeu strict après succès d'une réponse à demande (réponse HTTP perdue) ; autre intention refusée",async()=>{
    const f=await fixture(),key=randomUUID()
    const request=await f.service.post(f.hr,{employeeId:f.employeeA,kind:"REQUEST",body:"Pièce synthétique demandée.",key:randomUUID()})
    const input={category:"OTHER",period:"2026-11",title:"Synthetic answer",key,requestId:request.id}
    const first=await f.service.submit(f.a,input,pdf("c1"))
    assert.equal(first.status,"RECEIVED")
    assert.equal((await db.hrMessage.findUniqueOrThrow({where:{id:request.id}})).requestStatus,"DONE")
    const replay=await f.service.submit(f.a,input,pdf("c1"))
    assert.equal(replay.id,first.id);assert.equal(replay.status,"RECEIVED")
    await assert.rejects(f.service.submit(f.a,{...input,title:"Autre intitulé"},pdf("c1")),/RECEIPT_CONFLICT/)
    await assert.rejects(f.service.submit(f.a,{...input,requestId:undefined},pdf("c1")),/RECEIPT_CONFLICT/)
    await assert.rejects(f.service.submit(f.a,input,pdf("c1-other")),/RECEIPT_CONFLICT/)
    // La même clé employée par un autre salarié n'atteint jamais le reçu de A.
    await assert.rejects(f.service.submit(f.b,input,pdf("c1")),/NOT_FOUND/)
    assert.equal(await db.hrDocument.count({where:{companyId:f.companyId,uploadedById:f.a.userId}}),1)
    assert.deepEqual((await db.hrDocumentEvent.findMany({where:{documentId:first.id},orderBy:{version:"asc"}})).map(e=>e.action),["SUBMISSION_RESERVED","SUBMITTED"])
  })
  it("C1 : reprise d'une réservation antérieure (même clé) même si une autre transmission a clos la demande",async()=>{
    const f=await fixture(),key=randomUUID()
    const request=await f.service.post(f.hr,{employeeId:f.employeeA,kind:"REQUEST",body:"Pièce synthétique demandée.",key:randomUUID()})
    const input={category:"OTHER",period:"2026-11",title:"Synthetic answer",key,requestId:request.id}
    f.drive.failPut=true
    await assert.rejects(f.service.submit(f.a,input,pdf("c1b")),/DRIVE_UNAVAILABLE/)
    f.drive.failPut=false
    const reserved=await db.hrDocument.findFirstOrThrow({where:{companyId:f.companyId,uploadKey:key}})
    assert.equal(reserved.status,"RECEIVING")
    await f.submit(f.a,{requestId:request.id})
    assert.equal((await db.hrMessage.findUniqueOrThrow({where:{id:request.id}})).requestStatus,"DONE")
    const resumed=await f.service.submit(f.a,input,pdf("c1b"))
    assert.equal(resumed.id,reserved.id);assert.equal(resumed.status,"RECEIVED")
    assert.equal((await db.hrMessage.findUniqueOrThrow({where:{id:request.id}})).requestStatus,"DONE")
    await assert.rejects(f.submit(f.a,{requestId:request.id}),/REQUEST_CLOSED/,"une nouvelle opération exige toujours une demande ouverte")
  })
  it("C2 : reprise depuis une nouvelle session d'écran de son propre dépôt interrompu, même fichier, sans doublon",async()=>{
    const f=await fixture(),g=await fixture()
    const request=await f.service.post(f.hr,{employeeId:f.employeeA,kind:"REQUEST",body:"Pièce synthétique demandée.",key:randomUUID()})
    f.drive.failPut=true
    await assert.rejects(f.submit(f.a,{requestId:request.id,title:"Synthetic interrupted"},"c2"),/DRIVE_UNAVAILABLE/)
    f.drive.failPut=false
    // Nouvelle session : la clé est perdue ; le dépôt est retrouvé par la liste du salarié.
    const pending=(await f.service.list(f.a)).find(d=>d.status==="RECEIVING")!
    assert.ok(pending);assert.equal(pending.fromEmployee,true)
    await assert.rejects(f.submit(f.a,{title:"Synthetic interrupted"},"c2"),/DUPLICATE/,"un nouvel envoi des mêmes octets reste un doublon")
    await assert.rejects(f.service.resumeSubmission(f.b,pending.id,pending.version,pdf("c2")),/NOT_FOUND/)
    await assert.rejects(g.service.resumeSubmission(g.a,pending.id,pending.version,pdf("c2")),/NOT_FOUND/)
    await assert.rejects(f.service.resumeSubmission(f.hr,pending.id,pending.version,pdf("c2")),/FORBIDDEN/)
    await assert.rejects(f.service.resumeSubmission(f.leader,pending.id,pending.version,pdf("c2")),/NOT_FOUND/)
    await assert.rejects(f.service.resumeSubmission(f.a,pending.id,pending.version,pdf("c2-other")),/CONTENT_CHANGED/)
    await assert.rejects(f.service.resumeSubmission(f.a,pending.id,pending.version+1,pdf("c2")),/CONFLICT/)
    const draft=await f.rhDoc()
    await assert.rejects(f.service.resumeSubmission(f.a,draft.id,draft.version,pdf("c2")),/NOT_FOUND/,"jamais un brouillon RH")
    const done=await f.service.resumeSubmission(f.a,pending.id,pending.version,pdf("c2"))
    assert.equal(done.id,pending.id);assert.equal(done.status,"RECEIVED")
    assert.equal((await db.hrMessage.findUniqueOrThrow({where:{id:request.id}})).requestStatus,"DONE","demande retrouvée par l'intention et close")
    assert.equal(await db.hrDocument.count({where:{companyId:f.companyId,uploadedById:f.a.userId}}),1)
    await assert.rejects(f.service.resumeSubmission(f.a,pending.id,done.version,pdf("c2")),/CONFLICT/,"déjà reçu")
  })
  it("C3 : espace privé coupé, le salarié perd la lecture directe de ses dépôts READY et REVIEWED ; PUBLISHED et RH historiques intacts",async()=>{
    const f=await fixture(),pub=await f.published()
    const ownReady=await f.service.accept(f.hr,(await f.submit()).id,2)
    const second=await f.submit(),accepted=await f.service.accept(f.hr,second.id,second.version)
    const ownReviewed=await f.service.review(f.hr,accepted.id,{employeeId:f.employeeA,category:"OTHER",period:"2026-11",title:"Synthetic certificate",key:randomUUID(),expectedVersion:accepted.version})
    assert.equal(ownReady.status,"READY");assert.equal(ownReviewed.status,"REVIEWED")
    assert.ok((await f.service.download(f.a,ownReady.id)).bytes.length>0,"espace actif : lecture de son dépôt")
    delete process.env.HR_DOCUMENT_PRIVATE_SPACE_ENABLED
    try{
      await assert.rejects(f.service.download(f.a,ownReady.id),/NOT_FOUND/)
      await assert.rejects(f.service.download(f.a,ownReviewed.id),/NOT_FOUND/)
      assert.ok((await f.service.download(f.a,pub.id)).bytes.length>0)
      assert.ok((await f.service.download(f.hr,ownReady.id)).bytes.length>0)
      assert.ok((await f.service.download(f.hr,ownReviewed.id)).bytes.length>0)
      assert.ok((await f.service.download(f.reader,ownReviewed.id)).bytes.length>0)
      assert.deepEqual(ids(await f.service.list(f.a)),ids([pub]))
      await assert.rejects(f.service.resumeSubmission(f.a,ownReady.id,ownReady.version,pdf("x")),/DISABLED/)
    }finally{process.env.HR_DOCUMENT_PRIVATE_SPACE_ENABLED="true"}
  })
  it("concurrence réelle (verrou consultatif) : deux réponses simultanées à la même demande aboutissent, demande close une fois",async()=>{
    const f=await fixture()
    const request=await f.service.post(f.hr,{employeeId:f.employeeA,kind:"REQUEST",body:"Pièce synthétique demandée.",key:randomUUID()})
    // Les deux dépôts réservent (demande OPEN pour chacun) avant que l'un d'eux n'atteigne la clôture.
    f.drive.holdPuts(2)
    const results=await Promise.allSettled([f.submit(f.a,{requestId:request.id},"race-1"),f.submit(f.a,{requestId:request.id},"race-2")])
    assert.deepEqual(results.map(r=>r.status),["fulfilled","fulfilled"],JSON.stringify(results.map(r=>r.status==="rejected"?String(r.reason):"ok")))
    for(const r of results)if(r.status==="fulfilled")assert.equal(r.value.status,"RECEIVED")
    assert.equal((await db.hrMessage.findUniqueOrThrow({where:{id:request.id}})).requestStatus,"DONE")
    const events=await db.hrDocumentEvent.findMany({where:{companyId:f.companyId,action:{in:["SUBMISSION_RESERVED","SUBMITTED"]}}})
    assert.equal(events.filter(e=>e.action==="SUBMISSION_RESERVED").length,2);assert.equal(events.filter(e=>e.action==="SUBMITTED").length,2)
  })
  it("C2 v5 : reprise d'un dépôt répondant à une demande ancienne suivie de plus de 500 demandes ultérieures du même salarié",async()=>{
    const f=await fixture(),n=`${run}-${seq}`,total=Math.max(520,REQUEST_SCAN_PAGE*2+20)
    // Reproduit l'ancienne limite (500 plus récentes par date) : la cible est la plus ANCIENNE par date, suivie de `total` (> 500)
    // demandes ultérieures de A ; son identifiant est trié APRÈS tous les autres pour forcer aussi le parcours de toutes les pages.
    const row=(id:string,employeeId:string)=>({id,companyId:f.companyId,employeeId,authorId:f.hr.userId,authorSide:"HR",kind:"REQUEST",
      body:"Demande synthétique.",requestStatus:"DONE",createKey:randomUUID()})
    const target=`rq-${n}-a-9999`,old=new Date("2020-01-01T00:00:00.000Z"),later=(i:number)=>new Date(Date.UTC(2026,0,1)+i*1000)
    await db.hrMessage.create({data:{...row(target,f.employeeA),requestStatus:"OPEN",createdAt:old}})
    await db.hrMessage.createMany({data:Array.from({length:total},(_,i)=>({...row(`rq-${n}-a-${String(i).padStart(4,"0")}`,f.employeeA),createdAt:later(i)}))})
    await db.hrMessage.createMany({data:Array.from({length:5},(_,i)=>row(`rq-${n}-z-${i}`,f.employeeB))})
    assert.ok(total>500)
    assert.equal(await db.hrMessage.count({where:{companyId:f.companyId,employeeId:f.employeeA,kind:"REQUEST",createdAt:{gt:old}}}),total)
    const newest500=await db.hrMessage.findMany({where:{companyId:f.companyId,employeeId:f.employeeA,kind:"REQUEST"},orderBy:[{createdAt:"desc"},{id:"desc"}],take:500,select:{id:true}})
    assert.ok(!newest500.some(r=>r.id===target),"la cible est hors des 500 plus récentes (ancien comportement en échec)")
    const allIds=(await db.hrMessage.findMany({where:{companyId:f.companyId,employeeId:f.employeeA,kind:"REQUEST"},orderBy:{id:"asc"},select:{id:true}})).map(r=>r.id)
    assert.equal(allIds[allIds.length-1],target,"la cible est la dernière par identifiant (dernière page)")
    f.drive.failPut=true
    await assert.rejects(f.submit(f.a,{requestId:target,title:"Synthetic late answer"},"c2-late"),/DRIVE_UNAVAILABLE/)
    f.drive.failPut=false
    const pending=(await f.service.list(f.a)).find(d=>d.status==="RECEIVING")!
    const done=await f.service.resumeSubmission(f.a,pending.id,pending.version,pdf("c2-late"))
    assert.equal(done.status,"RECEIVED")
    assert.equal((await db.hrMessage.findUniqueOrThrow({where:{id:target}})).requestStatus,"DONE","demande retrouvée au-delà de la première page")
  })
})
