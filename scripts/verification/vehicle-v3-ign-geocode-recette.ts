import{readFileSync,writeFileSync}from'node:fs'
import{PrismaClient}from'@prisma/client'
import{cachedImportGeocode}from'../../src/lib/vehicules/cartography-cache'
import{boundedImportGeocodePort}from'../../src/lib/vehicules/import-geocode-adapter'
async function main(){
 const cfg=JSON.parse(readFileSync(process.argv[2],'utf8')),fixture=JSON.parse(readFileSync(process.argv[3],'utf8')),u=new URL(cfg.uri)
 if(u.hostname.replace('-pooler.','.')!=='ep-plain-unit-a2hicszi.eu-central-1.aws.neon.tech'||u.pathname!=='/planificator_staging')throw Error('Staging target required')
 const db=new PrismaClient({datasources:{db:{url:cfg.uri}}}),other=new PrismaClient({datasources:{db:{url:cfg.uri}}})
 try{
  const company=await db.company.findFirst({where:{id:fixture.companyId,slug:{startsWith:'recette-v3-'}}});if(!company)throw Error('Synthetic company required')
  process.env.PLANIFICATOR_VEHICLE_GEOCODING_ENABLED='true';process.env.PLANIFICATOR_GEOCODING_PROVIDER='IGN'
  let calls=0;const real=boundedImportGeocodePort(),port={geocodeAddress:async(a:string)=>{calls++;return real.geocodeAddress(a)}}
  const a=await cachedImportGeocode(db,fixture.companyId,'Place du Capitole, 31000 Toulouse, France',port),b=await cachedImportGeocode(other,fixture.companyId,'PLACE DU CAPITOLE, 31000 TOULOUSE, FRANCE',port)
  const pass=!!a&&a.latitude>43&&a.latitude<44&&a.longitude>1&&a.longitude<2&&a?.latitude===b?.latitude&&a?.longitude===b?.longitude&&calls===1
  const report={status:pass?'PASS':'FAIL',provider:'IGN/Geoplateforme BAN',coordinates:a,actualNetworkCalls:calls,persistentCacheAcrossClients:a?.latitude===b?.latitude&&a?.longitude===b?.longitude,scope:'Public square only; synthetic staging tenant; no customer data'}
  writeFileSync(process.argv[4],JSON.stringify(report,null,2));console.log(JSON.stringify(report));if(!pass)process.exitCode=1
 }finally{await Promise.all([db.$disconnect(),other.$disconnect()])}
}
main().catch(e=>{console.log({status:'FAIL',kind:e?.constructor?.name,code:e?.code});process.exitCode=1})
