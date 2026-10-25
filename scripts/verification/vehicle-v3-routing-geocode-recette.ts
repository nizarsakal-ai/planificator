import {writeFileSync} from 'node:fs'
import {estimateRoute} from '../../src/lib/vehicules/route-estimate-service'
import {boundedImportGeocodePort} from '../../src/lib/vehicules/import-geocode-adapter'
const report:{[key:string]:unknown}={at:new Date().toISOString(),scope:'Public demonstration coordinates only; no customer data; optional production flags unchanged'}
async function main(){
 process.env.PLANIFICATOR_ROUTING_ENABLED='true' // Endpoint must be supplied explicitly; never default to a public demonstration service.
 try{const value=await estimateRoute({coordinatesConfirmed:true,points:[{longitude:2.3522,latitude:48.8566},{longitude:4.8357,latitude:45.764}]});report.routing={status:value.estimatedKm>350&&value.estimatedKm<650&&value.segmentsKm.length===1?'PASS':'FAIL',...value,endpoint:'Explicitly configured private routing endpoint; this recipe does not activate production'}}catch(error){report.routing={status:'FAIL',kind:error instanceof Error?error.name:'Error'}}
 process.env.PLANIFICATOR_VEHICLE_GEOCODING_ENABLED='true';process.env.PLANIFICATOR_GEOCODING_PROVIDER='IGN'
 try{const value=await boundedImportGeocodePort().geocodeAddress('Place du Capitole, 31000 Toulouse, France');report.geocoding={status:value&&value.latitude>43&&value.latitude<44&&value.longitude>1&&value.longitude<2?'PASS':'FAIL',coordinates:value,requests:1,policy:'https://cartes.gouv.fr/cgu/',provider:'IGN/BAN'}}catch(error){report.geocoding={status:'FAIL',kind:error instanceof Error?error.name:'Error'}}
 delete process.env.PLANIFICATOR_VEHICLE_GEOCODING_ENABLED;delete process.env.PLANIFICATOR_GEOCODING_PROVIDER;delete process.env.PLANIFICATOR_ROUTING_ENABLED;delete process.env.PLANIFICATOR_ROUTING_OSRM_URL
 writeFileSync('../../outputs/recette-routage-geocodage-20261025.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));if((report.routing as any)?.status!=='PASS'||(report.geocoding as any)?.status!=='PASS')process.exitCode=1
}
main().catch(()=>{process.exitCode=1})
