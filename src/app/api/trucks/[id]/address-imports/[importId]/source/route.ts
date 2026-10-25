import { auth } from "@/auth"
import { prisma } from "@/lib/prisma"
import { assertImportOrigin, importFailure, importHeaders, limitedJson } from "@/lib/vehicules/import-api"
import { importScope } from "@/lib/vehicules/import-service"
import { authorizeVehicleLocked } from "@/lib/vehicules/vehicle-authority"
import { readImportSource } from "@/lib/vehicules/import-storage"
import { hashSource } from "@/lib/vehicules/import-domain"
import { MileageDomainError } from "@/lib/vehicules/mileage-domain"
export async function GET(_req:Request,c:{params:Promise<{id:string;importId:string}>}){try{const p=await c.params;const s=await importScope({auth,db:prisma});const row=await prisma.$transaction(async tx=>{await authorizeVehicleLocked(tx,p.id,s,"CORRECTION");return tx.vehicleAddressImport.findFirst({where:{id:p.importId,truckId:p.id,companyId:s.companyId}})});if(!row)throw new MileageDomainError("SOURCE_NOT_FOUND",404);const bytes=await readImportSource(row.storageId);if(hashSource(bytes)!==row.sourceHash)throw new MileageDomainError("SOURCE_CHANGED",409);await prisma.$transaction(tx=>authorizeVehicleLocked(tx,p.id,s,"CORRECTION"));return new Response(new Uint8Array(bytes),{headers:{...importHeaders,"Content-Type":row.mime,"Content-Disposition":"attachment; filename=source","Content-Security-Policy":"sandbox; default-src 'none'"}})}catch(e){return importFailure(e)}}
