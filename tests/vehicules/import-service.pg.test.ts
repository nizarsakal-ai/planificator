import {test} from "node:test"
import assert from "node:assert/strict"
import {PrismaClient} from "@prisma/client"
import {randomUUID} from "node:crypto"
import {fixture} from "./pg/fixtures"
import {createImport,listImports,reviewImport,consumeApprovedImportInTransaction} from "../../src/lib/vehicules/import-service"
import {extractAddressLines,hashSource} from "../../src/lib/vehicules/import-domain"
import {reserveImportProvider} from "../../src/lib/vehicules/import-provider-quota"
const value=process.env.IMPORTS_TEST_DATABASE_URL;if(!value)throw Error("IMPORTS_TEST_DATABASE_URL required");const u=new URL(value);if(u.hostname!=="127.0.0.1"||u.port!=="55433"||u.pathname!=="/v3_imports_test"||u.username!=="vehicule_test"||u.search||u.hash)throw Error("Only isolated v3_imports_test permitted")
const db=new PrismaClient({datasources:{db:{url:value}}})
test("PG: tenant authority, human version approval, concurrent review/consume, immutable source, persistent provider quota",async()=>{process.env.PLANIFICATOR_VEHICLES_V3_ENABLED="true";try{const f=await fixture(db);const candidates=extractAddressLines("12 rue Victor Hugo 75001 Paris");const row=await db.vehicleAddressImport.create({data:{companyId:f.company.id,truckId:f.truck.id,createdById:f.user.id,filename:"source.txt",mime:"text/plain",sourceHash:hashSource(Buffer.from("original")),storageId:randomUUID(),candidates,warnings:[]}})
 const scope={companyId:f.company.id,truckId:f.truck.id,userId:f.user.id,consumptionKey:"tour-one"};const consume=(revision:number,key="tour-one")=>db.$transaction(tx=>consumeApprovedImportInTransaction(tx,{...scope,consumptionKey:key},row.id,revision))
 await assert.rejects(consume(0),/IMPORT_NOT_APPROVED/)
 await assert.rejects(reviewImport(f.truck.id,row.id,{expectedRevision:0,approve:true,candidates},f.deps()),/HUMAN_CONFIRMATION_REQUIRED/)
 await assert.rejects(listImports(f.truck.id,f.deps(f.session(f.otherCompany.id))),/TRUCK_NOT_FOUND/)
 const deps={...f.deps(),readSource:async()=>Buffer.from("original")};
 await assert.rejects(reviewImport(f.truck.id,row.id,{expectedRevision:0,approve:true,candidates:candidates.map(c=>({...c,confirmed:true}))},{...deps,readSource:async()=>Buffer.from("tampered")}),/SOURCE_CHANGED/);
 await assert.rejects(reviewImport(f.truck.id,row.id,{expectedRevision:0,approve:true,candidates:candidates.map(c=>({...c,address:"Lyon",confirmed:true}))},deps),/INVALID_REVIEW/)
 const draft=await db.vehicleAddressImport.findUniqueOrThrow({where:{id:row.id}});assert.equal(draft.status,"DRAFT");assert.equal(draft.revision,0)
 const raw={expectedRevision:0,approve:true,candidates:candidates.map(c=>({...c,confirmed:true}))};const concurrent=await Promise.allSettled([reviewImport(f.truck.id,row.id,raw,deps),reviewImport(f.truck.id,row.id,raw,deps)]);assert.equal(concurrent.filter(r=>r.status==="fulfilled").length,1)
 await assert.rejects(consume(0),/IMPORT_NOT_APPROVED/);await assert.rejects(db.vehicleAddressImport.update({where:{id:row.id},data:{status:"DRAFT"}}));
 await assert.rejects(db.vehicleAddressImport.update({where:{id:row.id},data:{status:"PROCESSING"}}));
 await assert.rejects(db.vehicleAddressImport.update({where:{id:row.id},data:{status:"FAILED"}}));
 const consumed=await Promise.all([consume(1),consume(1)]);assert.deepEqual(consumed[0],consumed[1]);await assert.rejects(consume(1,"tour-two"),/ALREADY_CONSUMED/);
 for(const status of ["DRAFT","PROCESSING","APPROVED","FAILED"])await assert.rejects(db.vehicleAddressImport.update({where:{id:row.id},data:{status}}));
 await assert.rejects(db.$transaction(async tx=>{await tx.vehicleAddressImport.update({where:{id:row.id},data:{status:"PROCESSING"}});await tx.vehicleAddressImport.update({where:{id:row.id},data:{sourceHash:"changed",candidates:[]}})}));
 const still=await db.vehicleAddressImport.findUniqueOrThrow({where:{id:row.id}});assert.equal(still.status,"CONSUMED");assert.equal(still.revision,1);assert.equal(still.sourceHash,hashSource(Buffer.from("original")));assert.equal((still.candidates as any[]).length,1)
 await assert.rejects(db.vehicleAddressImport.update({where:{id:row.id},data:{sourceHash:"b".repeat(64)}}));await assert.rejects(db.vehicleAddressImport.update({where:{id:row.id},data:{candidates:[]}}))
 await assert.rejects(db.vehicleAddressImport.create({data:{companyId:f.otherCompany.id,truckId:f.truck.id,createdById:f.user.id,filename:"cross",mime:"text/plain",sourceHash:"a",storageId:randomUUID(),candidates:[],warnings:[]}}))
 for(let i=0;i<59;i++)await db.$transaction(tx=>reserveImportProvider(tx,f.company.id,"ROUTING"));const admitted=await Promise.allSettled([db.$transaction(tx=>reserveImportProvider(tx,f.company.id,"ROUTING")),db.$transaction(tx=>reserveImportProvider(tx,f.company.id,"ROUTING"))]);assert.equal(admitted.filter(r=>r.status==="fulfilled").length,1);await assert.rejects(db.$transaction(tx=>reserveImportProvider(tx,f.company.id,"ROUTING")),/PROVIDER_HOURLY_QUOTA/)
 await db.employee.updateMany({where:{userId:f.user.id,companyId:f.company.id},data:{active:false}});await assert.rejects(listImports(f.truck.id,f.deps()),/FORBIDDEN/)
 }finally{delete process.env.PLANIFICATOR_VEHICLES_V3_ENABLED;await db.$disconnect()}})

test("PG: real import reservation accepts the void advisory lock and records storage failure without losing its source hash",async()=>{
 const keys=["PLANIFICATOR_VEHICLES_V3_ENABLED","CLOUDINARY_URL","CLOUDINARY_CLOUD_NAME","CLOUDINARY_API_KEY","CLOUDINARY_API_SECRET"] as const
 const previous=Object.fromEntries(keys.map(k=>[k,process.env[k]]));const client=new PrismaClient({datasources:{db:{url:value}}})
 try{
  for(const k of keys)delete process.env[k];process.env.PLANIFICATOR_VEHICLES_V3_ENABLED="true"
  const f=await fixture(client),bytes=Buffer.from("12 rue Victor Hugo 75001 Paris")
  await assert.rejects(createImport(f.truck.id,{bytes,mime:"text/plain",filename:"reservation-regression.txt",ocrConsent:false},f.deps()),/SOURCE_STORAGE_NOT_CONFIGURED/)
  const rows=await client.vehicleAddressImport.findMany({where:{companyId:f.company.id,truckId:f.truck.id}})
  assert.equal(rows.length,1);assert.equal(rows[0].status,"FAILED");assert.equal(rows[0].sourceHash,hashSource(bytes));assert.match(rows[0].storageId,/^pending\//)
  assert.deepEqual(rows[0].warnings,["IMPORT_FAILED_RETRY_NEW_SOURCE"])
 }finally{for(const k of keys){if(previous[k]===undefined)delete process.env[k];else process.env[k]=previous[k]}await client.$disconnect()}
})
