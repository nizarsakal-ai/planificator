/** Independent review: real SQL, synthetic data, dedicated disposable DB only. */
import { describe, it, after } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { PrismaClient } from '@prisma/client'
import { AcquisitionAttachmentRepository } from '@/lib/acquisition/attachments/acquisition-attachment.repository'
import { ImportDraftConversionService } from '@/lib/acquisition/conversion/conversion.service'

const url = process.env.TEST_ACQUISITION_DATABASE_URL
if (url && (!url.includes('127.0.0.1:54335/pgtest_consultation_pj'))) throw new Error('Disposable lot DB required')
const db = new PrismaClient({ datasources: { db: { url: url ?? 'postgresql://unused@127.0.0.1:54335/unused' } } })
const rivals: PrismaClient[] = []
const fixed = new Date('2026-10-01T00:00:00Z')
const update = { sha256: 'a'.repeat(64), storageUrl: 'https://example.invalid/test.pdf', storagePublicId: 'synthetic/test', storedAt: fixed, sizeBytes: 10, mimeType: 'application/pdf' }
async function bounded<T>(p: Promise<T>, ms=8000): Promise<T> { let timer: ReturnType<typeof setTimeout>; try { return await Promise.race([p,new Promise<T>((_,reject)=>{timer=setTimeout(()=>reject(new Error('Barrier deadline exceeded')),ms)})]) } finally {clearTimeout(timer!)} }
function gate() { let release!: () => void; const promise = new Promise<void>(r => { release = r }); return { promise, release } }
function heldClient(client: PrismaClient, model: string, operation: string) {
  const entered = gate(), proceed = gate()
  let once = true
  const wrapped = new Proxy(client, { get(target, key) {
    if (key !== '$transaction') { const value = Reflect.get(target,key); return typeof value === 'function' ? value.bind(target) : value }
    return (callback: (tx: any) => unknown, options: any) => target.$transaction(async tx => callback(new Proxy(tx, { get(t, k) {
      const delegate = Reflect.get(t,k)
      if (k !== model) return typeof delegate === 'function' ? delegate.bind(t) : delegate
      return new Proxy(delegate, { get(d, op) { const fn = Reflect.get(d,op); if (op !== operation) return typeof fn === 'function' ? fn.bind(d) : fn
        return async (...args: any[]) => { const result = await fn.apply(d,args); if (once) { once = false; entered.release(); await proceed.promise } return result }
      } })
    } })), { ...options, timeout: 12000 })
  } })
  return { wrapped, entered, proceed }
}
function rival(name: string) { const u = new URL(url!); u.searchParams.set('application_name', name); const c = new PrismaClient({datasources:{db:{url:u.toString()}}}); rivals.push(c); return c }
async function blocked(name: string) {
  const end = Date.now()+3000
  while (Date.now()<end) {
    const rows = await db.$queryRaw<{n:bigint}[]>`SELECT count(*) AS n FROM pg_stat_activity WHERE application_name=${name} AND cardinality(pg_blocking_pids(pid))>0`
    if (Number(rows[0].n)>0) return
    await new Promise(r=>setTimeout(r,30))
  }
  throw new Error('No real SQL lock wait observed')
}
async function fixture() {
  const s = randomUUID()
  const company = await db.company.create({data:{name:'Synthetic attachment review',slug:`pj-${s}`}})
  const user = await db.user.create({data:{name:'Synthetic reviewer',email:`${s}@example.invalid`,password:'unused-synthetic',role:'ADMIN',companyId:company.id}})
  const client = await db.client.create({data:{name:'Synthetic customer',companyId:company.id}})
  const message = await db.acquisitionMessage.create({data:{companyId:company.id,source:'GMAIL',externalMessageId:s,senderEmail:'test@example.invalid',senderDomain:'example.invalid',subject:'Synthetic',receivedAt:fixed}})
  const draft = await db.worksiteImportDraft.create({data:{companyId:company.id,acquisitionMessageId:message.id,status:'APPROVED',version:3,proposedWorksiteName:`Synthetic ${s}`,proposedStartDate:new Date('2026-11-01'),proposedEndDate:new Date('2026-11-20')}})
  const attachment = await db.acquisitionAttachment.create({data:{companyId:company.id,acquisitionMessageId:message.id,attachmentKey:'ext:synthetic',filename:'synthetic.pdf',mimeType:'application/pdf',sizeBytes:10,category:'PLAN',status:'PENDING_DOWNLOAD'}})
  const ctx = {companyId:company.id,actorUserId:user.id,actorRole:'ADMIN' as const}
  const input = {draftId:draft.id,expectedVersion:3,clientMode:'EXISTING',existingClientId:client.id}
  return {company, draft, attachment, ctx, input}
}
function convert(f: Awaited<ReturnType<typeof fixture>>, client=db) { return new ImportDraftConversionService({db:client,now:()=>fixed,log:()=>{}}).convertImportDraft(f.ctx,f.input) }
function store(f: Awaited<ReturnType<typeof fixture>>, client=db) {return new AcquisitionAttachmentRepository(client,()=>{}).markStored(f.company.id,f.attachment.id,update)}
async function one(f: Awaited<ReturnType<typeof fixture>>) { const docs=await db.document.findMany({where:{sourceAcquisitionAttachmentId:f.attachment.id}}); assert.equal(docs.length,1); assert.equal(docs[0].type,'PLAN'); return docs[0] }

describe('atomic attachment bridge — actual PostgreSQL', {skip:!url},()=>{
  process.env.PLANIFICATOR_ACQUISITION_ENABLED='true'; process.env.ACQUISITION_CONVERSION_ENABLED='true'
  after(async()=>{await Promise.all(rivals.map(c=>c.$disconnect())); await db.$disconnect()})
  it('A: download owns draft, conversion actually waits, copies once',async()=>{
    const f=await fixture(); const hold=heldClient(db,'acquisitionAttachment','updateMany'); const download=store(f,hold.wrapped); let conversion: ReturnType<typeof convert>|undefined
    try {await bounded(hold.entered.promise); conversion=convert(f,rival('pj_order_a')); await blocked('pj_order_a')} finally {hold.proceed.release(); await Promise.allSettled([download,conversion].filter(Boolean))}
    const [s,c]=await Promise.all([download,conversion!]); assert.equal(s.status,'STORED'); assert.equal(c.ok,true); if(c.ok) assert.equal(c.documentCount,1); await one(f)
  })
  it('B: conversion owns draft, download actually waits, bridges once',async()=>{
    const f=await fixture(); const hold=heldClient(db,'worksite','create'); const conversion=convert(f,hold.wrapped); let download: ReturnType<typeof store>|undefined
    try {await bounded(hold.entered.promise); download=store(f,rival('pj_order_b')); await blocked('pj_order_b')} finally {hold.proceed.release(); await Promise.allSettled([download,conversion].filter(Boolean))}
    const [c,s]=await Promise.all([conversion,download!]); assert.equal(c.ok,true); if(c.ok){assert.equal(c.documentCount,0);assert.equal(c.skippedAttachmentCount,1)} assert.equal(s.status,'STORED'); await one(f)
  })
  it('concurrent conversion waits and returns the same existing worksite',async()=>{
    const f=await fixture(); const hold=heldClient(db,'worksite','create'); const first=convert(f,hold.wrapped); let second: ReturnType<typeof convert>|undefined
    try {await bounded(hold.entered.promise); second=convert(f,rival('pj_convert_twice')); await blocked('pj_convert_twice')} finally {hold.proceed.release(); await Promise.allSettled([first,second].filter(Boolean))}
    const [a,b]=await Promise.all([first,second!]); assert.ok(a.ok); assert.ok(b.ok); assert.equal(a.outcome,'CONVERTED'); assert.equal(b.outcome,'ALREADY_CONVERTED'); assert.equal(a.worksiteId,b.worksiteId); assert.equal(await db.worksite.count({where:{companyId:f.company.id}}),1)
  })
  it('two winning attempts produce STORED + ALREADY_STORED, one document',async()=>{
    const f=await fixture(); assert.equal((await convert(f)).ok,true)
    const result=await Promise.all([store(f),store(f,rival('pj_duplicate'))]); assert.deepEqual(result.map(r=>r.status).sort(),['ALREADY_STORED','STORED']); await one(f)
  })
  it('real SQL trigger failure rolls back STORED, retry succeeds',async()=>{
    const f=await fixture(); assert.equal((await convert(f)).ok,true)
    await db.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION pj_review_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW."sourceAcquisitionAttachmentId" = '${f.attachment.id}' THEN RAISE EXCEPTION 'SYNTHETIC_BRIDGE_FAILURE'; END IF; RETURN NEW; END $$`)
    await db.$executeRawUnsafe('CREATE TRIGGER pj_review_fail BEFORE INSERT ON documents FOR EACH ROW EXECUTE FUNCTION pj_review_fail()')
    try {assert.equal((await store(f)).status,'FAILED'); assert.equal((await db.acquisitionAttachment.findUniqueOrThrow({where:{id:f.attachment.id}})).status,'PENDING_DOWNLOAD'); assert.equal(await db.document.count({where:{sourceAcquisitionAttachmentId:f.attachment.id}}),0)} finally {await db.$executeRawUnsafe('DROP TRIGGER pj_review_fail ON documents'); await db.$executeRawUnsafe('DROP FUNCTION pj_review_fail()')}
    assert.equal((await store(f)).status,'STORED'); await one(f)
  })
  it('deleted document is never resurrected by repeated markStored',async()=>{
    const f=await fixture(); await convert(f); await store(f); const doc=await one(f); await db.document.delete({where:{id:doc.id}}); assert.equal((await store(f)).status,'ALREADY_STORED'); assert.equal(await db.document.count({where:{sourceAcquisitionAttachmentId:f.attachment.id}}),0)
  })
  it('foreign company cannot transition or bridge attachment',async()=>{
    const f=await fixture(); const other=await fixture(); await convert(f); assert.equal((await new AcquisitionAttachmentRepository(db,()=>{}).markStored(other.company.id,f.attachment.id,update)).status,'FAILED'); assert.equal((await db.acquisitionAttachment.findUniqueOrThrow({where:{id:f.attachment.id}})).status,'PENDING_DOWNLOAD'); assert.equal(await db.document.count({where:{sourceAcquisitionAttachmentId:f.attachment.id}}),0)
  })
  it('removed worksite allows storage without dangling document',async()=>{
    const f=await fixture(); const c=await convert(f); assert.ok(c.ok); await db.worksite.delete({where:{id:c.worksiteId}}); assert.equal((await store(f)).status,'STORED'); assert.equal(await db.document.count({where:{sourceAcquisitionAttachmentId:f.attachment.id}}),0)
  })
  it('actual lock timeout leaves attachment pending and permits retry',async()=>{
    const f=await fixture(); const entered=gate(), release=gate()
    const holder=db.$transaction(async tx=>{await tx.$queryRaw`SELECT id FROM worksite_import_drafts WHERE id=${f.draft.id} FOR UPDATE`;entered.release();await release.promise},{timeout:10000})
    try {await bounded(entered.promise); const start=Date.now(); assert.equal((await store(f,rival('pj_timeout'))).status,'FAILED'); assert.ok(Date.now()-start>=3500); assert.ok(Date.now()-start<6500); assert.equal((await db.acquisitionAttachment.findUniqueOrThrow({where:{id:f.attachment.id}})).status,'PENDING_DOWNLOAD')}finally{release.release();await holder}
    assert.equal((await store(f)).status,'STORED')
  })
})
