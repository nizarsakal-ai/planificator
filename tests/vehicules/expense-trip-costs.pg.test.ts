import assert from "node:assert/strict"
import {randomUUID} from "node:crypto"
import {test} from "node:test"
import {PrismaClient} from "@prisma/client"
import {fixture} from "./pg/fixtures"
import {executeExpenseCommand,readExpenses} from "../../src/lib/vehicules/v3/expense-service"
import {readTripCosts,readVehicleCosts} from "../../src/lib/vehicules/v3/cost-service"
import {uploadVehicleDocument} from "../../src/lib/vehicules/v3/document-service"
import {executeMileageCommand} from "../../src/lib/vehicules/mileage-service"
const url=process.env.V3_COSTS_DATABASE_URL;if(!url)throw Error("V3_COSTS_DATABASE_URL required");const parsed=new URL(url);if(parsed.hostname!=="127.0.0.1"||parsed.port!=="55433"||parsed.pathname!=="/v3_costs_test"||parsed.username!=="vehicule_test"||parsed.search||parsed.hash)throw Error("Only isolated costs DB permitted")
const db=new PrismaClient({datasources:{db:{url}}})
process.env.PLANIFICATOR_VEHICLES_V3_ENABLED="true"
test("PG: corrections preserve receipt links, explicit two-trip costs, current source state, corrected distance, null zero/open",async()=>{try{
 const f=await fixture(db);const deps={...f.deps(),validateDocumentVersion:async(tx:any,s:any)=>!!await tx.vehicleDocumentVersion.findFirst({where:{id:s.versionId,companyId:s.companyId,truckId:s.truckId}})}
 const document=await uploadVehicleDocument(f.truck.id,{category:"EXPENSE_RECEIPT",title:"Facture privée"},{filename:"facture.pdf",declaredMimeType:"application/pdf",bytes:Buffer.from("%PDF-1.4\n%%EOF\n")},randomUUID(),{...deps,storage:{provider:"cloudinary",async store(location:any){return {storageKey:`private-${location.versionId}`,created:true}},async destroy(){},async createSignedUrl(key:string){return `https://private.invalid/${key}`}}})
 const privateVersionId=document.receipt.versionId
 const run=async(body:unknown)=>(await executeExpenseCommand(f.truck.id,body,randomUUID(),deps)).expense as any
 const mileage=(action:"READING"|"START"|"END"|"CORRECTION",body:unknown)=>executeMileageCommand(f.truck.id,action,body,randomUUID(),f.deps())
 const maintenance=await db.vehicleMaintenanceEntry.create({data:{companyId:f.company.id,truckId:f.truck.id,kind:"OIL_CHANGE",occurredAt:new Date("2020-01-01T00:00:00Z"),mileage:1000,createdById:f.user.id,createdByNameSnapshot:"Fixture",idempotencyKey:randomUUID(),requestHash:"a".repeat(64)}})
 const fields={category:"FUEL",occurredAt:"2020-01-15T00:00:00Z",amount:"100.00",currency:"EUR",litres:"50.000"}
 let expense=await run({action:"CREATE",data:{...fields,documentVersionId:privateVersionId,maintenanceEntryId:maintenance.id,receiptFingerprint:"b".repeat(64)}})
 expense=await run({action:"CORRECT",expenseId:expense.id,expectedRevision:expense.revision,reason:"Corriger notes uniquement",data:{...fields,notes:"Texte corrigé"}})
 assert.equal(expense.documentVersionId,privateVersionId);assert.equal(expense.maintenanceEntryId,maintenance.id);assert.equal(expense.receiptFingerprint,"b".repeat(64))
 await assert.rejects(run({action:"CREATE",data:{...fields,receiptFingerprint:"b".repeat(64)}}),/DUPLICATE/)
 expense=await run({action:"APPROVE",expenseId:expense.id,expectedRevision:expense.revision,reason:"Facture vérifiée"})
 await mileage("READING",{mileage:1000,expectedRevision:0,occurredAt:"2020-01-01T00:00:00Z"})
 const a=await mileage("START",{mileage:1000,expectedRevision:1,occurredAt:"2020-01-02T00:00:00Z"});await mileage("END",{mileage:1100,expectedRevision:2,occurredAt:"2020-01-03T00:00:00Z",tripId:a.receipt.tripId})
 const b=await mileage("START",{mileage:1100,expectedRevision:3,occurredAt:"2020-01-04T00:00:00Z"});await mileage("END",{mileage:1300,expectedRevision:4,occurredAt:"2020-01-05T00:00:00Z",tripId:b.receipt.tripId})
 expense=await run({action:"ALLOCATE",expenseId:expense.id,expectedRevision:expense.revision,reason:"Répartition partielle",allocations:[{mileageTripId:a.receipt.tripId,amount:"20.00"},{mileageTripId:b.receipt.tripId,amount:"30.00"},{mileageTripId:null,amount:"5.00"}]})
 let ca=await readTripCosts(f.truck.id,a.receipt.tripId!,"EUR",f.deps()),cb=await readTripCosts(f.truck.id,b.receipt.tripId!,"EUR",f.deps());assert.equal(ca.total,"20.00");assert.equal(cb.total,"30.00");assert.equal(ca.costPerKm,"0.2000");assert.equal(cb.costPerKm,"0.1500");assert.equal(ca.fuelAllocatedCostPerKm,"0.2000")
 const vehicle=await readVehicleCosts(f.truck.id,{from:"2020-01-01T00:00:00Z",to:"2020-02-01T00:00:00Z",currency:"EUR"},f.deps());assert.equal(vehicle.total,"100.00") // register counted once, never + allocations.
 await mileage("CORRECTION",{mileage:1010,expectedRevision:5,entryId:a.receipt.entryId,expectedEffectiveEntryId:a.receipt.entryId,reason:"Corriger départ"})
 ca=await readTripCosts(f.truck.id,a.receipt.tripId!,"EUR",f.deps());assert.equal(ca.actualKm,90);assert.equal(ca.costPerKm,"0.2222")
 const opened=await mileage("START",{mileage:1300,expectedRevision:6,occurredAt:"2020-01-06T00:00:00Z"});assert.equal((await readTripCosts(f.truck.id,opened.receipt.tripId!,"EUR",f.deps())).costPerKm,null)
 await mileage("END",{mileage:1300,expectedRevision:7,occurredAt:"2020-01-07T00:00:00Z",tripId:opened.receipt.tripId});assert.equal((await readTripCosts(f.truck.id,opened.receipt.tripId!,"EUR",f.deps())).costPerKm,null)
 const employee=await db.employee.findFirstOrThrow({where:{userId:f.user.id,companyId:f.company.id}})
 const source=await db.expenseReport.create({data:{companyId:f.company.id,employeeId:employee.id,date:new Date("2020-01-15T00:00:00Z"),amount:100,category:"TRANSPORT",description:"Source vérifiée",status:"APPROVED"}})
 expense=await run({action:"RECONCILE",expenseId:expense.id,expectedRevision:expense.revision,reason:"Rapprochement source",sourceExpenseReportId:source.id,confirmedAmount:"100.00",confirmedCurrency:"EUR"});expense=await run({action:"APPROVE",expenseId:expense.id,expectedRevision:expense.revision,reason:"Source vérifiée"});assert.equal((await readTripCosts(f.truck.id,a.receipt.tripId!,"EUR",f.deps())).total,"20.00")
 await db.expenseReport.update({where:{id:source.id},data:{status:"REJECTED"}});ca=await readTripCosts(f.truck.id,a.receipt.tripId!,"EUR",f.deps());assert.equal(ca.total,"0.00");assert.equal(ca.excludedSource,1)
 await db.expenseReport.delete({where:{id:source.id}});assert.equal((await readTripCosts(f.truck.id,a.receipt.tripId!,"EUR",f.deps())).excludedSource,1)
 const duplicateData={...fields,amount:"12.00",supplier:"Fournisseur témoin",reference:"Facture témoin"};const duplicateA=await run({action:"CREATE",data:duplicateData});const duplicateB=await run({action:"CREATE",data:duplicateData})
 const reusedReceiptA=await run({action:"CREATE",data:{...fields,amount:"17.00",documentVersionId:privateVersionId}})
 const reusedReceiptB=await run({action:"CREATE",data:{...fields,amount:"17.00",documentVersionId:privateVersionId}})
 const reusedList=await readExpenses(f.truck.id,f.deps())
 assert.ok(reusedList.expenses.find(e=>e.id===reusedReceiptA.id)!.duplicateCandidates.some(candidate=>candidate.id===reusedReceiptB.id))
 const list=await readExpenses(f.truck.id,f.deps());assert.equal(list.expenses.find(e=>e.id===duplicateA.id)!.duplicateCandidates[0].id,duplicateB.id);assert.match(list.expenses.find(e=>e.id===duplicateA.id)!.duplicateCandidates[0].label,/Facture témoin/);const selected=list.expenses.find(e=>e.id===expense.id)!;assert.equal(selected.allocations.length,3);assert.match(selected.allocations.find(x=>x.mileageTripId===a.receipt.tripId)!.label,/2020-01-02/);assert.ok(list.tripCandidates.some(t=>t.id===a.receipt.tripId));assert.equal(selected.sourceWarning,"SOURCE_MISSING")
 await assert.rejects(readTripCosts(f.otherTruck.id,a.receipt.tripId!,"EUR",f.deps()),/TRUCK_NOT_FOUND/)
 }finally{await db.$disconnect()}})
