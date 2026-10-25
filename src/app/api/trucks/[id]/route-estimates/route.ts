import { cachedRouteEstimate } from "@/lib/vehicules/routing-cache"
import { auth } from "@/auth"
import { prisma } from "@/lib/prisma"
import { assertImportOrigin, importFailure, importHeaders, limitedJson } from "@/lib/vehicules/import-api"
import { importScope } from "@/lib/vehicules/import-service"
import { authorizeVehicleLocked } from "@/lib/vehicules/vehicle-authority"
export async function POST(req:Request,c:{params:Promise<{id:string}>}){try{assertImportOrigin(req);const s=await importScope({auth,db:prisma});const id=(await c.params).id;await prisma.$transaction(tx=>authorizeVehicleLocked(tx,id,s,"CORRECTION"));return Response.json(await cachedRouteEstimate(prisma,s.companyId,await limitedJson(req),tx=>authorizeVehicleLocked(tx,id,s,"CORRECTION")),{headers:importHeaders})}catch(e){return importFailure(e)}}
