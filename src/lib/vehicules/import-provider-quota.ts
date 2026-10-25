import type { Prisma } from "@prisma/client"
import { MileageDomainError } from "./mileage-domain"
/** Persistent company-wide admission before an optional provider call. Never an unlimited per-instance budget. */
export async function reserveImportProvider(tx:Prisma.TransactionClient,companyId:string,provider:"ROUTING"|"GEOCODING",now=new Date()){
 const windowStart=new Date(Math.floor(now.getTime()/3600000)*3600000)
 const rows=await tx.$queryRaw<{count:number}[]>`INSERT INTO "vehicle_import_provider_windows" ("companyId","provider","windowStart","count") VALUES (${companyId},${provider},${windowStart},1) ON CONFLICT ("companyId","provider","windowStart") DO UPDATE SET "count"="vehicle_import_provider_windows"."count"+1 WHERE "vehicle_import_provider_windows"."count"<60 RETURNING "count"`
 if(!rows.length)throw new MileageDomainError("PROVIDER_HOURLY_QUOTA",429)
 await tx.$executeRaw`DELETE FROM "vehicle_import_provider_windows" WHERE "companyId"=${companyId} AND "windowStart"<${new Date(now.getTime()-48*3600000)}`
}
