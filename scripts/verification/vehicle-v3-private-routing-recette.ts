import assert from 'node:assert/strict'
import {writeFileSync} from 'node:fs'
import {estimateRoute} from '../../src/lib/vehicules/route-estimate-service'
async function main(){
 const paris={latitude:48.8566,longitude:2.3522},lyon={latitude:45.764,longitude:4.8357},bastia={latitude:42.6973,longitude:9.4509},ajaccio={latitude:41.9192,longitude:8.7386}
 const cases=[{name:'Paris-Lyon',points:[paris,lyon],min:350,max:650},{name:'Paris-Lyon-Paris',points:[paris,lyon,paris],min:700,max:1300},{name:'Bastia-Ajaccio',points:[bastia,ajaccio],min:100,max:250}]
 const results=[]
 for(const c of cases){let value;for(let attempt=0;attempt<3;attempt++){try{value=await estimateRoute({coordinatesConfirmed:true,points:c.points});break}catch(e){if(!(e instanceof Error)||e.message!=='ROUTING_BUSY'||attempt===2)throw e;await new Promise(r=>setTimeout(r,1100))}}
  assert.ok(value);assert.equal(value.provider,'GRAPHHOPPER');assert.equal(value.segmentsKm.length,c.points.length-1);assert.ok(value.estimatedKm>c.min&&value.estimatedKm<c.max);assert.ok(Math.abs(value.estimatedKm-value.segmentsKm.reduce((a,b)=>a+b,0))<.0001);results.push({name:c.name,...value});await new Promise(r=>setTimeout(r,1100))
 }
 const report={status:'PASS',at:new Date().toISOString(),scope:'Real private HTTPS routing through application adapter; public city-centre points only; no customer data',graphVersion:process.env.PLANIFICATOR_ROUTING_GRAPH_VERSION,results}
 if(process.argv[2])writeFileSync(process.argv[2],JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report))
}
main().catch(e=>{console.error(e instanceof Error?e.message:'Routing recipe failed');process.exitCode=1})
