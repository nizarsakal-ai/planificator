import {test} from 'node:test'
import assert from 'node:assert/strict'
import {PrismaClient} from '@prisma/client'
import {fixture} from './pg/fixtures'
import {cachedImportGeocode} from '../../src/lib/vehicules/cartography-cache'
const url=process.env.CARTOGRAPHY_TEST_DATABASE_URL;if(!url)throw Error('CARTOGRAPHY_TEST_DATABASE_URL required');const u=new URL(url);if(u.hostname!=='127.0.0.1'||u.port!=='55433'||u.pathname!=='/v3_cartography_test'||u.username!=='vehicule_test'||u.search||u.hash)throw Error('Only isolated local cartography test permitted')
test('PG cartography: persistent cache, tenant isolation, global admission, expiry and shared failure cooldown',async()=>{
 const a=new PrismaClient({datasources:{db:{url}}}),b=new PrismaClient({datasources:{db:{url}}});const old={enabled:process.env.PLANIFICATOR_VEHICLE_GEOCODING_ENABLED,provider:process.env.PLANIFICATOR_GEOCODING_PROVIDER};process.env.PLANIFICATOR_VEHICLE_GEOCODING_ENABLED='true';process.env.PLANIFICATOR_GEOCODING_PROVIDER='IGN'
 try{
  const f=await fixture(a);await a.$executeRaw`UPDATE vehicle_cartography_admission SET "nextAllowedAt"=clock_timestamp()-interval '1 second' WHERE provider='IGN_GEOCODING'`
  let calls=0;const port={geocodeAddress:async()=>{calls++;return{latitude:43.604354,longitude:1.443054}}}
  const first=await cachedImportGeocode(a,f.company.id,'Place du Capitole 31000 Toulouse',port)
  assert.deepEqual(await cachedImportGeocode(b,f.company.id,'  PLACE DU CAPITOLE 31000 Toulouse  ',port),first);assert.equal(calls,1)
  await a.$executeRaw`UPDATE vehicle_cartography_admission SET "nextAllowedAt"=clock_timestamp()+interval '30 seconds' WHERE provider='IGN_GEOCODING'`
  const blocked=await Promise.allSettled([cachedImportGeocode(a,f.company.id,'Autre adresse 75001 Paris',port),cachedImportGeocode(b,f.otherCompany.id,'Place du Capitole 31000 Toulouse',port)])
  assert.ok(blocked.every(x=>x.status==='rejected'&&/GEOCODING_BUSY/.test(x.reason.message)));assert.equal(calls,1)
  const quota=await a.$queryRaw<any[]>`SELECT count FROM vehicle_import_provider_windows WHERE "companyId"=${f.company.id} AND provider='GEOCODING'`;assert.equal(quota[0].count,1)
  const rows=await a.$queryRaw<any[]>`SELECT "key","value",("expiresAt">clock_timestamp()+interval '23 hours') AS valid FROM vehicle_cartography_cache WHERE "companyId"=${f.company.id}`;assert.equal(rows.length,1);assert.match(rows[0].key,/^[a-f0-9]{64}$/);assert.equal(rows[0].valid,true);assert.deepEqual(rows[0].value,first)
  await a.$executeRaw`UPDATE vehicle_cartography_cache SET "expiresAt"=clock_timestamp()-interval '1 second' WHERE "companyId"=${f.company.id}`
  await assert.rejects(cachedImportGeocode(a,f.company.id,'Place du Capitole 31000 Toulouse',port),/GEOCODING_BUSY/)
  await a.$executeRaw`UPDATE vehicle_cartography_admission SET "nextAllowedAt"=clock_timestamp()-interval '1 second' WHERE provider='IGN_GEOCODING'`
  await assert.rejects(cachedImportGeocode(a,f.company.id,'Place du Capitole 31000 Toulouse',{geocodeAddress:async()=>{throw Error('simulated provider failure')}}),/simulated provider failure/)
  const cooldown=await a.$queryRaw<any[]>`SELECT "nextAllowedAt">clock_timestamp()+interval '55 seconds' AS active FROM vehicle_cartography_admission WHERE provider='IGN_GEOCODING'`;assert.equal(cooldown[0].active,true)
  await assert.rejects(cachedImportGeocode(b,f.otherCompany.id,'Place de la République Paris',port),/GEOCODING_BUSY/)
 }finally{for(const[k,v]of Object.entries({PLANIFICATOR_VEHICLE_GEOCODING_ENABLED:old.enabled,PLANIFICATOR_GEOCODING_PROVIDER:old.provider})){if(v===undefined)delete process.env[k];else process.env[k]=v}await Promise.all([a.$disconnect(),b.$disconnect()])}
})
