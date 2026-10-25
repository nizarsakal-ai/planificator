import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { test } from "node:test"
import { PrismaClient, type Prisma } from "@prisma/client"
import { fixture } from "./pg/fixtures"
import { archiveVehicleDocument, updateVehicleDocumentMetadata, updateReminderSettings, openVehicleDocumentFile, replaceVehicleDocument, runVehicleDocumentReminders, uploadVehicleDocument, verifyVehicleDocumentVersion, type DocumentServiceDeps } from "../../src/lib/vehicules/v3/document-service"
import type { DocumentStoragePort } from "../../src/lib/vehicules/v3/document-storage.port"
const value = process.env.V3_DOCFIX_DATABASE_URL
if (!value) throw new Error("V3_DOCFIX_DATABASE_URL required; no fallback")
const url = new URL(value)
if (url.hostname !== "127.0.0.1" || url.port !== "55433" || url.pathname !== "/v3_docfix_test" || url.username !== "vehicule_test" || url.search || url.hash) throw new Error("Refusing non-disposable docfix DB")
const db = new PrismaClient({ datasources: { db: { url: value } } })
const bytes = Buffer.from("%PDF-1.4\n%%EOF\n"), file = { filename: "assurance.pdf", declaredMimeType: "application/pdf", bytes }
const body = { category: "INSURANCE", title: "Assurance", validFrom: "2020-01-01", validUntil: "2020-01-20" }
const clock = () => new Date("2020-01-15T12:00:00Z")
function storageFixture() {
 const objects = new Map<string, Uint8Array>(), destroyed: string[] = []
 const storage: DocumentStoragePort = { provider: "cloudinary", async store(location, content) { const key = `private-${location.versionId}`; objects.set(key, content); return { storageKey: key, created: true } }, async destroy(key) { destroyed.push(key); objects.delete(key) }, async createSignedUrl(key) { return `https://private.invalid/${key}` } }
 const fetchSigned: DocumentServiceDeps["fetchSigned"] = async signed => { const content = objects.get(new URL(signed).pathname.slice(1))!; return { ok: !!content, status: content ? 200 : 404, contentLength: content?.length ?? null, body: content ? new ReadableStream({ start(c) { c.enqueue(content); c.close() } }) : null } }
 return { storage, objects, destroyed, fetchSigned }
}
// Simulate a lost commit acknowledgement after the real transaction has committed.
const wrappedDb = (after:(n:number)=>Promise<void>) => {let calls=0;return {$transaction:async(fn:(tx:Prisma.TransactionClient)=>Promise<unknown>,options?:any)=>{const n=++calls,result=await db.$transaction(fn,options);await after(n);return result}} as unknown as Pick<PrismaClient,"$transaction">}
// Mutate after all company plans, immediately before the first delivery row lock.
const beforeReminderDeliveryDb = (after: (n: number) => Promise<void>) => {
 let triggered=false
 return {$transaction:async(fn:(tx:Prisma.TransactionClient)=>Promise<unknown>,options?:any)=>db.$transaction(async tx=>{
  const guarded=new Proxy(tx,{get(target,property,receiver){
   if(property!=="$queryRaw")return Reflect.get(target,property,receiver)
   return async(query:any,...values:any[])=>{
    const statement=Array.isArray(query)?query.join(" "):String(query?.sql??"")
    if(!triggered&&statement.includes('FROM "trucks"')&&statement.includes("FOR UPDATE")){triggered=true;await after(1)}
    return (target.$queryRaw as any).apply(target,[query,...values])
   }
  }})
  return fn(guarded)
 },options)} as unknown as Pick<PrismaClient,"$transaction">
}

test("PostgreSQL document fixes: refused audit committed, role recheck after fetch, compensation ambiguity and reminders stale state", { timeout: 55000 }, async () => {
 try {
  // Two transactions read the same revision before either write; exactly one may commit.
  const settingsFixture = await fixture(db)
  const raceSettings = async (expectedRevision: number) => {
    let arrived = 0, release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const synchronized = { $transaction: (fn: (tx: Prisma.TransactionClient) => Promise<unknown>, options?: any) => db.$transaction(async tx => {
      const model = new Proxy(tx.vehicleDocumentReminderSetting, { get(target, property, receiver) {
        if (property !== "findFirst") return Reflect.get(target, property, receiver)
        return async (args: any) => { const row = await target.findFirst(args); if (++arrived === 2) release(); await gate; return row }
      } })
      return fn(new Proxy(tx, { get(target, property, receiver) { return property === "vehicleDocumentReminderSetting" ? model : Reflect.get(target, property, receiver) } }))
    }, options) } as unknown as Pick<PrismaClient, "$transaction">
    const results = await Promise.allSettled([[40, 8], [50, 9]].map(thresholdsDays => updateReminderSettings({ expectedRevision, thresholdsDays }, { ...settingsFixture.deps(), storage: storageFixture().storage, db: synchronized })))
    assert.equal(results.filter(result => result.status === "fulfilled").length, 1)
    const rejected = results.find(result => result.status === "rejected") as PromiseRejectedResult
    assert.match(String(rejected.reason), /REMINDER_SETTINGS_CONFLICT/)
    assert.equal((await db.vehicleDocumentReminderSetting.findUniqueOrThrow({ where: { companyId: settingsFixture.company.id } })).revision, expectedRevision + 1)
    assert.equal(await db.vehicleAuditLog.count({ where: { companyId: settingsFixture.company.id, action: "REMINDER_SETTINGS_UPDATE" } }), expectedRevision + 1)
  }
  await raceSettings(0)
  await raceSettings(1)
  const f = await fixture(db), memory = storageFixture()
  const deps: DocumentServiceDeps = { ...f.deps(), ...memory }
  const registration = await uploadVehicleDocument(f.truck.id, { category: "REGISTRATION", title: "Carte grise" }, file, randomUUID(), deps)
  const employee = await db.employee.findFirstOrThrow({ where: { userId: f.user.id, companyId: f.company.id } })
  await db.employee.update({ where: { id: employee.id }, data: { role: "TEAM_LEADER" } })
  const team = await db.team.create({ data: { name: "Docfix team", companyId: f.company.id, leaderId: employee.id } })
  await db.truck.update({ where: { id: f.truck.id }, data: { teamId: team.id } })
  const leaderDeps = { ...deps, auth: async () => f.session(f.company.id, f.user.id, "TEAM_LEADER") }
  await assert.rejects(openVehicleDocumentFile(f.truck.id, registration.receipt.documentId, registration.receipt.versionId, "VIEW", leaderDeps), /DOCUMENT_NOT_FOUND/)
  assert.equal(await db.vehicleAuditLog.count({ where: { companyId: f.company.id, outcome: "DENIED", action: "DOCUMENT_VIEW" } }), 1)
  await db.employee.update({ where: { id: employee.id }, data: { role: "ADMIN" } })
  const insurance = await uploadVehicleDocument(f.truck.id, body, file, randomUUID(), deps)
  const revoked: DocumentServiceDeps = { ...deps, fetchSigned: async signed => { await db.employee.update({ where: { id: employee.id }, data: { active: false } }); return memory.fetchSigned!(signed) } }
  await assert.rejects(openVehicleDocumentFile(f.truck.id, insurance.receipt.documentId, insurance.receipt.versionId, "DOWNLOAD", revoked), /FORBIDDEN/)
  await db.employee.update({ where: { id: employee.id }, data: { active: true } })
  const opened = await openVehicleDocumentFile(f.truck.id, insurance.receipt.documentId, insurance.receipt.versionId, "DOWNLOAD", deps)
  assert.equal(opened.contentLength, bytes.length)
  assert.equal(await new Response(opened.stream).text(), bytes.toString())

  // Accusé de commit perdu : la version rattachée doit survivre à la compensation.
  const before = await db.vehicleDocumentVersion.count({ where: { companyId: f.company.id } })
  const ambiguous = { ...deps, db: wrappedDb(async n => { if (n === 2) throw new Error("commit acknowledgement lost") }) }
  await assert.rejects(uploadVehicleDocument(f.truck.id, { ...body, title: "Commit incertain" }, file, randomUUID(), ambiguous))
  assert.equal(await db.vehicleDocumentVersion.count({ where: { companyId: f.company.id } }), before + 1)
  assert.equal(memory.destroyed.length, 0)

  // Si la vérification DB après échec est impossible, conserver l'orphelin potentiel.
  let calls = 0
  const unavailable = { ...deps, db: { $transaction: async (fn: (tx: Prisma.TransactionClient) => Promise<unknown>, options?: any) => { calls++; if (calls >= 2) throw new Error("database unavailable"); return db.$transaction(fn, options) } } as unknown as Pick<PrismaClient, "$transaction"> }
  await assert.rejects(uploadVehicleDocument(f.truck.id, { ...body, title: "Orphelin à rapprocher" }, file, randomUUID(), unavailable))
  assert.equal(memory.destroyed.length, 0)

  // Course de replay : l'objet perdant est détruit après la transaction, jamais sous verrou.
  const pf = await fixture(db), pm = storageFixture()
  let entered = 0, release!: () => void, activeTransactions = 0
  const gate = new Promise<void>(resolve => { release = resolve })
  const raceStorage: DocumentStoragePort = { ...pm.storage, async store(location, content) { const result = await pm.storage.store(location, content); if (++entered === 2) release(); await gate; return result }, async destroy(key) { assert.equal(activeTransactions, 0); await pm.storage.destroy(key) } }
  const raceDb = { $transaction: async (fn: (tx: Prisma.TransactionClient) => Promise<unknown>, options?: any) => { activeTransactions++; try { return await db.$transaction(fn, options) } finally { activeTransactions-- } } } as unknown as Pick<PrismaClient, "$transaction">
  const raceDeps = { ...pf.deps(), db: raceDb, storage: raceStorage }, replayKey = randomUUID()
  const replayResults = await Promise.all([uploadVehicleDocument(pf.truck.id, body, file, replayKey, raceDeps), uploadVehicleDocument(pf.truck.id, body, file, replayKey, raceDeps)])
  assert.equal(replayResults[0].receipt.versionId, replayResults[1].receipt.versionId)
  assert.deepEqual(replayResults.map(r => r.replayed).sort(), [false, true])
  assert.equal(pm.destroyed.length, 1)

  // SUPER_ADMIN dans le contexte société reçoit les rappels ; membre ADMIN inactif sans fallback exclu.
  const rf = await fixture(db), remindersStorage = storageFixture(), rdeps = { ...rf.deps(), ...remindersStorage }
  const rdoc = await uploadVehicleDocument(rf.truck.id, body, file, randomUUID(), rdeps)
  await db.user.update({ where: { id: rf.global.id }, data: { companyId: rf.company.id } })
  const rmember = await db.employee.findFirstOrThrow({ where: { userId: rf.user.id, companyId: rf.company.id } })
  await db.user.update({ where: { id: rf.user.id }, data: { role: "ADMIN" } })
  await db.employee.update({ where: { id: rmember.id }, data: { active: false } })
  await runVehicleDocumentReminders({ db, clock })
  assert.equal(await db.vehicleDocumentReminder.count({ where: { versionId: rdoc.receipt.versionId, recipientUserId: rf.global.id } }), 2)
  assert.equal(await db.vehicleDocumentReminder.count({ where: { versionId: rdoc.receipt.versionId, recipientUserId: rf.user.id } }), 0)
  const countBeforeReplay = await db.vehicleDocumentReminder.count()
  await runVehicleDocumentReminders({ db, clock }); assert.equal(await db.vehicleDocumentReminder.count(), countBeforeReplay)

  // Plan calculé puis remplacement concurrent avant création : aucune ancienne alerte nouvelle.
  const sf = await fixture(db), sm = storageFixture(), sdeps = { ...sf.deps(), ...sm }
  const stale = await uploadVehicleDocument(sf.truck.id, body, file, randomUUID(), sdeps)
  const changesBetweenPlanAndSend = beforeReminderDeliveryDb(async n => { if (n === 1) await replaceVehicleDocument(sf.truck.id, stale.receipt.documentId, { expectedRevision: 1, validFrom: "2020-01-01", validUntil: "2021-01-01" }, file, randomUUID(), sdeps) })
  await runVehicleDocumentReminders({ db: changesBetweenPlanAndSend, clock })
  assert.equal(await db.vehicleDocumentReminder.count({ where: { versionId: stale.receipt.versionId } }), 0)

  // Entreprise désactivée après calcul : pas de notification.
  const cf = await fixture(db), cm = storageFixture(), cdeps = { ...cf.deps(), ...cm }
  const cdoc = await uploadVehicleDocument(cf.truck.id, body, file, randomUUID(), cdeps)
  await runVehicleDocumentReminders({ db: beforeReminderDeliveryDb(async n => { if (n === 1) await db.company.update({ where: { id: cf.company.id }, data: { active: false } }) }), clock })
  assert.equal(await db.vehicleDocumentReminder.count({ where: { versionId: cdoc.receipt.versionId } }), 0)

  // Rôle retiré après le plan : pas de notification au destinataire devenu EMPLOYEE.
  const uf = await fixture(db), um = storageFixture(), udoc = await uploadVehicleDocument(uf.truck.id, body, file, randomUUID(), { ...uf.deps(), ...um })
  await runVehicleDocumentReminders({ db: beforeReminderDeliveryDb(async n => { if (n === 1) await db.employee.updateMany({ where: { userId: uf.user.id, companyId: uf.company.id }, data: { role: "EMPLOYEE" } }) }), clock })
  assert.equal(await db.vehicleDocumentReminder.count({ where: { versionId: udoc.receipt.versionId, recipientUserId: uf.user.id } }), 0)
 } finally { await db.$disconnect() }
})

test("PostgreSQL document receipts: reject stale verification and different archive reason without extra writes", { timeout: 30000 }, async () => {
 try {
  const f = await fixture(db), memory = storageFixture()
  const deps: DocumentServiceDeps = { ...f.deps(), ...memory }
  const first = (await uploadVehicleDocument(f.truck.id, body, file, randomUUID(), deps)).receipt
  const verified = await verifyVehicleDocumentVersion(f.truck.id, first.documentId, { expectedRevision: 1, versionId: first.versionId }, deps)
  assert.equal(verified.replayed, false)
  assert.equal((await verifyVehicleDocumentVersion(f.truck.id, first.documentId, { expectedRevision: 1, versionId: first.versionId }, deps)).replayed, true)
  await replaceVehicleDocument(f.truck.id, first.documentId, { expectedRevision: 2 }, file, randomUUID(), deps)
  await assert.rejects(verifyVehicleDocumentVersion(f.truck.id, first.documentId, { expectedRevision: 2, versionId: first.versionId }, deps), /DOCUMENT_VERSION_NOT_CURRENT/)
  await archiveVehicleDocument(f.truck.id, first.documentId, { expectedRevision: 3, reason: "Contrat résilié" }, deps)
  const auditBefore = await db.vehicleAuditLog.count({ where: { companyId: f.company.id } })
  await assert.rejects(verifyVehicleDocumentVersion(f.truck.id, first.documentId, { expectedRevision: 3, versionId: first.versionId }, deps), /DOCUMENT_ARCHIVED/)
  await assert.rejects(archiveVehicleDocument(f.truck.id, first.documentId, { expectedRevision: 3, reason: "Autre motif" }, deps), /DOCUMENT_ARCHIVED/)
  assert.equal((await archiveVehicleDocument(f.truck.id, first.documentId, { expectedRevision: 3, reason: "Contrat résilié" }, deps)).replayed, true)
  const saved = await db.vehicleDocument.findUniqueOrThrow({ where: { id: first.documentId } })
  assert.equal(saved.revision, 4)
  assert.equal(saved.archiveReason, "Contrat résilié")
  assert.equal(await db.vehicleAuditLog.count({ where: { companyId: f.company.id } }), auditBefore)
 } finally { await db.$disconnect() }
})


test("PostgreSQL metadata editing: five categories, immutable prior evidence, verification reset, replay and revision race",{timeout:55000},async()=>{
 try{
  const f=await fixture(db),memory=storageFixture(),deps:DocumentServiceDeps={...f.deps(),...memory};
  for(const category of ["TECHNICAL_INSPECTION","REPAIR_MAINTENANCE","REGISTRATION","INSURANCE","EXPENSE_RECEIPT"] as const){
   const first=(await uploadVehicleDocument(f.truck.id,{category,title:"Avant modification",issuedOn:"2020-01-01",issuerName:"Émetteur initial"},file,randomUUID(),deps)).receipt;
   await verifyVehicleDocumentVersion(f.truck.id,first.documentId,{expectedRevision:1,versionId:first.versionId},deps);
   const before=await db.vehicleDocumentVersion.findUniqueOrThrow({where:{id:first.versionId}});
   const edit={expectedRevision:2,title:"Informations complétées",issuedOn:"2020-02-03",issuerName:"Émetteur corrigé",observations:"Correction explicite"},key=randomUUID();
   const result=await updateVehicleDocumentMetadata(f.truck.id,first.documentId,edit,key,deps);
   assert.equal(result.receipt.versionNumber,2);assert.equal(result.receipt.revision,3);
   const [old,current]=await Promise.all([db.vehicleDocumentVersion.findUniqueOrThrow({where:{id:first.versionId}}),db.vehicleDocumentVersion.findUniqueOrThrow({where:{id:result.receipt.versionId}})]);
   assert.equal(old.issuedOn?.toISOString().slice(0,10),"2020-01-01");assert.equal(old.issuerName,"Émetteur initial");assert.deepEqual(old.verifiedAt,before.verifiedAt);assert.ok(old.supersededAt);assert.equal(current.verifiedAt,null);assert.equal(current.verifiedById,null);assert.equal(current.issuerName,"Émetteur corrigé");assert.equal(current.sha256,before.sha256);assert.notEqual(current.storageKey,before.storageKey);assert.deepEqual(Buffer.from(memory.objects.get(current.storageKey)!),bytes);assert.deepEqual(Buffer.from(memory.objects.get(before.storageKey)!),bytes);
   const count=memory.objects.size;assert.equal((await updateVehicleDocumentMetadata(f.truck.id,first.documentId,edit,key,deps)).replayed,true);assert.equal(memory.objects.size,count);
   await assert.rejects(updateVehicleDocumentMetadata(f.truck.id,first.documentId,{...edit,title:"Divergent"},key,deps),/IDEMPOTENCY_CONFLICT/);
   await assert.rejects(db.vehicleDocumentVersion.update({where:{id:first.versionId},data:{issuerName:"Réécriture interdite"}}),/VEHICLES_V3: version immuable/);
  }
  const first=(await uploadVehicleDocument(f.truck.id,{category:"TECHNICAL_INSPECTION",title:"Course"},file,randomUUID(),deps)).receipt;
  const results=await Promise.allSettled([updateVehicleDocumentMetadata(f.truck.id,first.documentId,{expectedRevision:1,title:"A"},randomUUID(),deps),updateVehicleDocumentMetadata(f.truck.id,first.documentId,{expectedRevision:1,title:"B"},randomUUID(),deps)]);
  assert.equal(results.filter(r=>r.status==="fulfilled").length,1);assert.equal(await db.vehicleDocumentVersion.count({where:{documentId:first.documentId}}),2);assert.equal((await db.vehicleDocument.findUniqueOrThrow({where:{id:first.documentId}})).revision,2);assert.match(String((results.find(r=>r.status==="rejected") as PromiseRejectedResult).reason),/DOCUMENT_REVISION_CONFLICT/);
 }finally{await db.$disconnect()}
});
