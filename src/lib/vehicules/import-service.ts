import { randomUUID } from "node:crypto"
import type { Prisma, PrismaClient } from "@prisma/client"
import { requireMileageSession, type MileageSession } from "./mileage-access"
import { authorizeVehicleLocked } from "./vehicle-authority"
import { MileageDomainError } from "./mileage-domain"
import { assessCandidates, verifyBytes, hashSource, candidatesSchema, validateReview } from "./import-domain"
import { extractImport } from "./import-extraction"
import { readImportSource, storeImportSource } from "./import-storage"
const importTransactionOptions={maxWait:5000,timeout:15000}
export type ImportDeps={auth:()=>Promise<MileageSession|null>;db:PrismaClient;readSource?:(id:string)=>Promise<Buffer>}
export async function importScope(deps:ImportDeps){if(process.env.PLANIFICATOR_VEHICLES_V3_ENABLED!=="true")throw new MileageDomainError("FEATURE_DISABLED",404);const s=requireMileageSession(await deps.auth());if(!["ADMIN","SUPER_ADMIN"].includes(s.role))throw new MileageDomainError("FORBIDDEN",403);return s}
export async function preauthorizeImport(truckId:string,deps:ImportDeps){const scope=await importScope(deps);await deps.db.$transaction(tx=>authorizeVehicleLocked(tx,truckId,scope,"CORRECTION"),importTransactionOptions);return scope}
export async function listImports(truckId:string,deps:ImportDeps){const s=await importScope(deps);return deps.db.$transaction(async tx=>{await authorizeVehicleLocked(tx,truckId,s,"CORRECTION");return tx.vehicleAddressImport.findMany({where:{companyId:s.companyId,truckId},orderBy:{createdAt:"desc"},take:30,select:{id:true,filename:true,sourceHash:true,revision:true,candidates:true,warnings:true,status:true,reviewedAt:true,createdAt:true}})},importTransactionOptions)}
export async function createImport(truckId:string,input:{bytes:Buffer;mime:string;filename:string;ocrConsent:boolean},deps:ImportDeps){const s=await importScope(deps);verifyBytes(input.bytes,input.mime)
 const reserved=await deps.db.$transaction(async tx=>{await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${"vehicle-import:"+s.companyId}))`;const {truck}=await authorizeVehicleLocked(tx,truckId,s,"CORRECTION");if(truck.archivedAt)throw new MileageDomainError("TRUCK_ARCHIVED",409);const count=await tx.vehicleAddressImport.count({where:{companyId:s.companyId,createdAt:{gte:new Date(Date.now()-86400000)}}});if(count>=20)throw new MileageDomainError("DAILY_IMPORT_QUOTA",429)
 return tx.vehicleAddressImport.create({data:{companyId:s.companyId,truckId,createdById:s.userId,filename:input.filename.replace(/[\x00-\x1f]/g,"").slice(0,200)||"document",mime:input.mime,sourceHash:hashSource(input.bytes),storageId:"pending/"+randomUUID(),candidates:[],warnings:["TRAITEMENT_EN_COURS"],status:"PROCESSING"}})},importTransactionOptions)
 let uploadedStorageId:string|undefined
 try {const result=await extractImport(input.bytes,input.mime,input.ocrConsent);const storageId=await storeImportSource(input.bytes,s.companyId,truckId);uploadedStorageId=storageId
 return await deps.db.$transaction(async tx=>{const {truck}=await authorizeVehicleLocked(tx,truckId,s,"CORRECTION");if(truck.archivedAt)throw new MileageDomainError("TRUCK_ARCHIVED",409);return tx.vehicleAddressImport.update({where:{id:reserved.id},data:{storageId,candidates:result.candidates,warnings:[...result.warnings,...assessCandidates(result.candidates)],status:"DRAFT"}})},importTransactionOptions)
 }catch(error){await deps.db.vehicleAddressImport.updateMany({where:{id:reserved.id,status:"PROCESSING"},data:{...(uploadedStorageId?{storageId:uploadedStorageId}:{}),status:"FAILED",warnings:["IMPORT_FAILED_RETRY_NEW_SOURCE"]}});throw error}
}
export async function reviewImport(truckId:string,id:string,raw:unknown,deps:ImportDeps){const s=await importScope(deps);const r=validateReview(raw)
 const source=await deps.db.$transaction(async tx=>{await authorizeVehicleLocked(tx,truckId,s,"CORRECTION");const row=await tx.vehicleAddressImport.findFirst({where:{id,truckId,companyId:s.companyId,status:"DRAFT",revision:r.expectedRevision}});if(!row)throw new MileageDomainError("IMPORT_STALE_OR_UNAVAILABLE",409);return row},importTransactionOptions)
 const bytes=await (deps.readSource??readImportSource)(source.storageId);if(hashSource(bytes)!==source.sourceHash)throw new MileageDomainError("SOURCE_CHANGED",409)
 return deps.db.$transaction(async tx=>{const {truck}=await authorizeVehicleLocked(tx,truckId,s,"CORRECTION");if(truck.archivedAt)throw new MileageDomainError("TRUCK_ARCHIVED",409);const updated=await tx.vehicleAddressImport.updateMany({where:{id,truckId,companyId:s.companyId,revision:r.expectedRevision,status:"DRAFT",sourceHash:source.sourceHash},data:{candidates:r.candidates,warnings:assessCandidates(r.candidates),status:"APPROVED",reviewedById:s.userId,reviewedAt:new Date(),revision:{increment:1}}});if(updated.count!==1)throw new MileageDomainError("IMPORT_STALE_OR_UNAVAILABLE",409);return {id,revision:r.expectedRevision+1}},importTransactionOptions)}
export async function consumeApprovedImportInTransaction(tx:Prisma.TransactionClient,scope:{companyId:string;truckId:string;userId:string;consumptionKey:string},importId:string,revision:number){
 await tx.$queryRaw`SELECT "id" FROM "vehicle_address_imports" WHERE "id"=${importId} AND "companyId"=${scope.companyId} AND "truckId"=${scope.truckId} FOR UPDATE`
 const row=await tx.vehicleAddressImport.findFirst({where:{id:importId,companyId:scope.companyId,truckId:scope.truckId}})
 if(!row||row.revision!==revision||!row.reviewedById||!row.reviewedAt||!["APPROVED","CONSUMED"].includes(row.status))throw new MileageDomainError("IMPORT_NOT_APPROVED",409)
 if(row.consumptionKey&&row.consumptionKey!==scope.consumptionKey)throw new MileageDomainError("IMPORT_ALREADY_CONSUMED",409)
 const candidates=candidatesSchema.parse(row.candidates);if(!candidates.length||candidates.some(c=>!c.confirmed))throw new MileageDomainError("IMPORT_NOT_APPROVED",409)
 await tx.vehicleAddressImport.update({where:{id:row.id},data:{status:"CONSUMED",consumptionKey:scope.consumptionKey}})
 return candidates.map(({label,address,latitude,longitude})=>({label,address,latitude,longitude}))
}
