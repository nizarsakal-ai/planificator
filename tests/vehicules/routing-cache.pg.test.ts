import {test} from 'node:test'
import assert from 'node:assert/strict'
import {PrismaClient} from '@prisma/client'
import {fixture} from './pg/fixtures'
import {cachedRouteEstimate} from '../../src/lib/vehicules/routing-cache'
import {MileageDomainError} from '../../src/lib/vehicules/mileage-domain'
const url=process.env.CARTOGRAPHY_TEST_DATABASE_URL;if(!url)throw Error('CARTOGRAPHY_TEST_DATABASE_URL required');const u=new URL(url);if(u.hostname!=='127.0.0.1'||u.port!=='55433'||u.pathname!=='/v3_reprise_20261025'||u.username!=='vehicule_test'||u.search||u.hash)throw Error('Only isolated local routing test permitted')
test('PG routing: shared cache, tenant/graph isolation, atomic quota, authority rollback and failure cooldown',async()=>{
 const a=new PrismaClient({datasources:{db:{url}}}),b=new PrismaClient({datasources:{db:{url}}})
 process.env.PLANIFICATOR_ROUTING_ENABLED='true';process.env.PLANIFICATOR_ROUTING_PROVIDER='GRAPHHOPPER';process.env.PLANIFICATOR_ROUTING_GRAPHHOPPER_URL='https://routing.example.test';process.env.PLANIFICATOR_ROUTING_TOKEN='synthetic-test-token-32-characters-only';process.env.PLANIFICATOR_ROUTING_GRAPH_VERSION='test-v1'
 const input={points:[{latitude:48.869,longitude:2.331},{latitude:45.75,longitude:4.85}],coordinatesConfirmed:true}
 const value={estimatedKm:470,segmentsKm:[470],provider:'GRAPHHOPPER' as const,profile:'driving' as const,estimatedAt:new Date().toISOString(),label:'synthetic'}
 const reset=()=>a.$executeRaw`UPDATE vehicle_cartography_admission SET "nextAllowedAt"=clock_timestamp()-interval '1 second' WHERE provider='PRIVATE_ROUTING'`
 try{
  const f=await fixture(a);await reset();let calls=0;const estimate=async()=>{calls++;return value},authorize=async()=>{}
  assert.deepEqual(await cachedRouteEstimate(a,f.company.id,input,authorize,estimate),value)
  assert.deepEqual(await cachedRouteEstimate(b,f.company.id,input,authorize,estimate),value);assert.equal(calls,1)
  await assert.rejects(cachedRouteEstimate(b,f.company.id,input,async()=>{throw new MileageDomainError('FORBIDDEN',403)},estimate),/FORBIDDEN/)
  await a.$executeRaw`UPDATE vehicle_cartography_admission SET "nextAllowedAt"=clock_timestamp()+interval '30 seconds' WHERE provider='PRIVATE_ROUTING'`
  await assert.rejects(cachedRouteEstimate(b,f.otherCompany.id,input,authorize,estimate),/ROUTING_BUSY/)
  const rows=await a.$queryRaw<any[]>`SELECT count FROM vehicle_import_provider_windows WHERE "companyId"=${f.company.id} AND provider='ROUTING'`;assert.equal(rows[0].count,1)
  process.env.PLANIFICATOR_ROUTING_GRAPH_VERSION='test-v2';await assert.rejects(cachedRouteEstimate(a,f.company.id,input,authorize,estimate),/ROUTING_BUSY/)
  await reset();await assert.rejects(cachedRouteEstimate(a,f.company.id,input,async()=>{throw new MileageDomainError('FORBIDDEN',403)},estimate),/FORBIDDEN/)
  const outcomes=await Promise.allSettled([cachedRouteEstimate(a,f.company.id,input,authorize,estimate),cachedRouteEstimate(b,f.otherCompany.id,input,authorize,estimate)]);assert.equal(outcomes.filter(x=>x.status==='fulfilled').length,1);assert.equal(calls,2)
  await reset();process.env.PLANIFICATOR_ROUTING_GRAPH_VERSION='test-fail';await assert.rejects(cachedRouteEstimate(a,f.company.id,input,authorize,async()=>{throw new MileageDomainError('ROUTING_UNAVAILABLE',503)}),/ROUTING_UNAVAILABLE/)
  const cooldown=await a.$queryRaw<any[]>`SELECT "nextAllowedAt">clock_timestamp()+interval '25 seconds' AS active FROM vehicle_cartography_admission WHERE provider='PRIVATE_ROUTING'`;assert.equal(cooldown[0].active,true)
  await assert.rejects(cachedRouteEstimate(b,f.otherCompany.id,input,authorize,estimate),/ROUTING_BUSY/)
  await reset();process.env.PLANIFICATOR_ROUTING_GRAPH_VERSION='test-busy';await assert.rejects(cachedRouteEstimate(a,f.company.id,input,authorize,async()=>{throw new MileageDomainError('ROUTING_BUSY',429)}),/ROUTING_BUSY/)
  const noCooldown=await a.$queryRaw<any[]>`SELECT "nextAllowedAt"<clock_timestamp()+interval '5 seconds' AS active FROM vehicle_cartography_admission WHERE provider='PRIVATE_ROUTING'`;assert.equal(noCooldown[0].active,true)
  await assert.rejects(cachedRouteEstimate(a,f.company.id,{...input,coordinatesConfirmed:false},authorize,estimate),/CONFIRMED/)
 }finally{await Promise.all([a.$disconnect(),b.$disconnect()])}
})
