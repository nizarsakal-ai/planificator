import type { Prisma, PrismaClient } from "@prisma/client"
import { MileageDomainError } from "./mileage-domain"
import { reserveImportProvider } from "./import-provider-quota"
import { estimateRoute, routeInput, routingCacheKey, type RouteEstimate } from "./route-estimate-service"
/** Tenant cache and global admission survive Vercel cold starts. No network inside a transaction. */
export async function cachedRouteEstimate(db:PrismaClient,companyId:string,raw:unknown,authorize:(tx:Prisma.TransactionClient)=>Promise<unknown>,estimate=estimateRoute):Promise<RouteEstimate>{
 const parsed=routeInput.safeParse(raw);if(!parsed.success)throw new MileageDomainError("CONFIRMED_COORDINATES_REQUIRED",400)
 const key=routingCacheKey(parsed.data,companyId)
 await db.$transaction(tx=>authorize(tx),{maxWait:5000,timeout:15000})
 const hit=await db.$queryRaw<{value:RouteEstimate}[]>`SELECT "value" FROM "vehicle_cartography_cache" WHERE "key"=${key} AND "companyId"=${companyId} AND "expiresAt">clock_timestamp()`
 if(hit.length)return hit[0].value
 await db.$transaction(async tx=>{
  await authorize(tx)
  const admitted=await tx.$queryRaw<{provider:string}[]>`INSERT INTO "vehicle_cartography_admission" ("provider","nextAllowedAt") VALUES ('PRIVATE_ROUTING',clock_timestamp()+interval '1 second') ON CONFLICT ("provider") DO UPDATE SET "nextAllowedAt"=clock_timestamp()+interval '1 second' WHERE "vehicle_cartography_admission"."nextAllowedAt"<=clock_timestamp() RETURNING "provider"`
  if(!admitted.length)throw new MileageDomainError("ROUTING_BUSY",429)
  await reserveImportProvider(tx,companyId,"ROUTING")
 },{maxWait:5000,timeout:15000})
 let value:RouteEstimate
 try{value=await estimate(parsed.data)}catch(e){if(e instanceof MileageDomainError&&e.status>=500)await db.$executeRaw`UPDATE "vehicle_cartography_admission" SET "nextAllowedAt"=greatest("nextAllowedAt",clock_timestamp()+interval '30 seconds') WHERE "provider"='PRIVATE_ROUTING'`;throw e}
 await db.$executeRaw`INSERT INTO "vehicle_cartography_cache" ("key","companyId","value","expiresAt") VALUES (${key},${companyId},${JSON.stringify(value)}::jsonb,clock_timestamp()+interval '1 hour') ON CONFLICT ("key") DO UPDATE SET "value"=EXCLUDED."value","expiresAt"=EXCLUDED."expiresAt"`
 await db.$executeRaw`DELETE FROM "vehicle_cartography_cache" WHERE "key" IN (SELECT "key" FROM "vehicle_cartography_cache" WHERE "expiresAt"<clock_timestamp() LIMIT 100)`
 return value
}
