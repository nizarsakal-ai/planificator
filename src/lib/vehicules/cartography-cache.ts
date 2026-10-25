import { createHash } from "node:crypto"
import type { Prisma, PrismaClient } from "@prisma/client"
import { MileageDomainError } from "./mileage-domain"
import { importGeocodeEndpoint, importGeocodePort } from "./import-geocode-adapter"
import { reserveImportProvider } from "./import-provider-quota"
import type { GeocodePort, GeocodeResult } from "../geo/geocode.port"
/** Atomic admission and database clock apply across every application instance and tenant. */
export async function cachedImportGeocode(db:PrismaClient,companyId:string,address:string,port:GeocodePort=importGeocodePort,authorize?:(tx:Prisma.TransactionClient)=>Promise<unknown>):Promise<GeocodeResult>{
 if(process.env.PLANIFICATOR_VEHICLE_GEOCODING_ENABLED!=="true"||process.env.PLANIFICATOR_GEOCODING_PROVIDER!=="IGN")throw new MileageDomainError("GEOCODING_NOT_CONFIGURED",503)
 const normalized=address.trim().normalize("NFC").replace(/\s+/g," ").toLocaleLowerCase("fr-FR")
 const key=createHash("sha256").update(JSON.stringify([companyId,"IGN",importGeocodeEndpoint().href,normalized])).digest("hex")
 const hit=await db.$queryRaw<{value:GeocodeResult}[]>`SELECT "value" FROM "vehicle_cartography_cache" WHERE "key"=${key} AND "companyId"=${companyId} AND "expiresAt">clock_timestamp()`
 if(hit.length)return hit[0].value
 await db.$transaction(async tx=>{
 const admitted=await tx.$queryRaw<{provider:string}[]>`INSERT INTO "vehicle_cartography_admission" ("provider","nextAllowedAt") VALUES ('IGN_GEOCODING',clock_timestamp()+interval '1 second') ON CONFLICT ("provider") DO UPDATE SET "nextAllowedAt"=clock_timestamp()+interval '1 second' WHERE "vehicle_cartography_admission"."nextAllowedAt"<=clock_timestamp() RETURNING "provider"`
 if(!admitted.length)throw new MileageDomainError("GEOCODING_BUSY",429)
 if(authorize)await authorize(tx)
 await reserveImportProvider(tx,companyId,"GEOCODING")
 },{maxWait:5000,timeout:15000})
 let value:GeocodeResult
 try{value=await port.geocodeAddress(address)}catch(error){await db.$executeRaw`UPDATE "vehicle_cartography_admission" SET "nextAllowedAt"=greatest("nextAllowedAt",clock_timestamp()+interval '60 seconds') WHERE "provider"='IGN_GEOCODING'`;throw error}
 const seconds=value?86400:300
 await db.$executeRaw`INSERT INTO "vehicle_cartography_cache" ("key","companyId","value","expiresAt") VALUES (${key},${companyId},${JSON.stringify(value)}::jsonb,clock_timestamp()+${seconds}*interval '1 second') ON CONFLICT ("key") DO UPDATE SET "value"=EXCLUDED."value","expiresAt"=EXCLUDED."expiresAt"`
 await db.$executeRaw`DELETE FROM "vehicle_cartography_cache" WHERE "key" IN (SELECT "key" FROM "vehicle_cartography_cache" WHERE "expiresAt"<clock_timestamp() LIMIT 100)`
 return value
}
