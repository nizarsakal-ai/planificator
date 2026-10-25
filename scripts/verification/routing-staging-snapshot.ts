import {PrismaClient} from '@prisma/client'
import {writeFileSync} from 'node:fs'
const url=process.env.ROUTING_STAGE_URL!,u=new URL(url);if(u.hostname!=='ep-plain-unit-a2hicszi-pooler.eu-central-1.aws.neon.tech'||u.pathname!=='/planificator_staging')throw Error('Dedicated staging database required')
const companyId='cmvn3rpmp0000pi3jjedpfdmc',truckId='cmvn3rq7l0005pi3jublnikw1'
async function main(){const db=new PrismaClient({datasources:{db:{url}}});try{
 const quota=await db.$queryRaw<{count:number}[]>`SELECT coalesce(sum(count),0)::int AS count FROM vehicle_import_provider_windows WHERE "companyId"=${companyId} AND provider='ROUTING'`
 const cache=await db.$queryRaw<{count:number}[]>`SELECT count(*)::int AS count FROM vehicle_cartography_cache WHERE "companyId"=${companyId}`
 const truck=await db.truck.findUniqueOrThrow({where:{id:truckId},select:{companyId:true,currentMileage:true,mileageRevision:true}});if(truck.companyId!==companyId)throw Error('Synthetic company required')
 const data={routingQuota:quota[0].count,cacheRows:cache[0].count,currentMileage:truck.currentMileage,mileageRevision:truck.mileageRevision,mileageEntries:await db.mileageEntry.count({where:{companyId,truckId}}),tours:await db.vehicleTour.count({where:{companyId,truckId}}),expenses:await db.vehicleExpense.count({where:{companyId,truckId}})}
 writeFileSync(process.argv[2],JSON.stringify(data,null,2));console.log(JSON.stringify(data))
}finally{await db.$disconnect()}}
main().catch(e=>{console.error(e instanceof Error?e.message:'Snapshot failed');process.exitCode=1})
