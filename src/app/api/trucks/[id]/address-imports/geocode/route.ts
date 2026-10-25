import { auth } from "@/auth"
import { prisma } from "@/lib/prisma"
import { z } from "zod"
import { preauthorizeImport } from "@/lib/vehicules/import-service"
import { authorizeVehicleLocked } from "@/lib/vehicules/vehicle-authority"
import { assertImportOrigin, importFailure, importHeaders, limitedJson } from "@/lib/vehicules/import-api"
import { cachedImportGeocode } from "@/lib/vehicules/cartography-cache"
import { MileageDomainError } from "@/lib/vehicules/mileage-domain"
export async function POST(req:Request,c:{params:Promise<{id:string}>}){try{assertImportOrigin(req);const s=await preauthorizeImport((await c.params).id,{auth,db:prisma});if(process.env.PLANIFICATOR_VEHICLE_GEOCODING_ENABLED!=="true")throw new MileageDomainError("GEOCODING_NOT_CONFIGURED",503);const v=z.object({address:z.string().trim().min(12).max(500),consent:z.literal(true)}).strict().safeParse(await limitedJson(req));if(!v.success)throw new MileageDomainError("GEOCODING_CONSENT_REQUIRED",400);const id=(await c.params).id;const coordinates=await cachedImportGeocode(prisma,s.companyId,v.data.address,undefined,tx=>authorizeVehicleLocked(tx,id,s,"CORRECTION"));return Response.json({coordinates,warning:"Coordonnées proposées : confirmez sur la source. Le géocodage ne valide pas une adresse."},{headers:importHeaders})}catch(e){return importFailure(e)}}
