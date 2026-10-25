import test from "node:test"
import assert from "node:assert/strict"
import { estimateRoute, routingCacheKey } from "../../src/lib/vehicules/route-estimate-service"
const input={points:[{latitude:43.7384,longitude:7.4246},{latitude:43.7329,longitude:7.4204},{latitude:43.7384,longitude:7.4246}],coordinatesConfirmed:true}
function configure(version:string){process.env.PLANIFICATOR_ROUTING_ENABLED="true";process.env.PLANIFICATOR_ROUTING_PROVIDER="GRAPHHOPPER";process.env.PLANIFICATOR_ROUTING_GRAPHHOPPER_URL="https://routing.example.test";process.env.PLANIFICATOR_ROUTING_TOKEN="synthetic-test-token-32-characters-only";process.env.PLANIFICATOR_ROUTING_GRAPH_VERSION=version}
function response(){return {paths:[{distance:3043.158,details:{leg_distance:[[0,1,1420.031],[1,2,1623.127]]},snapped_waypoints:{coordinates:input.points.map(p=>[p.longitude,p.latitude])}}]}}
test("private GraphHopper uses lat/lon, header authentication, ordered legs and graph-version key",async()=>{
 configure("success");let calls=0
 const fake:typeof fetch=async(url,init)=>{calls++;const u=new URL(String(url));assert.equal(u.searchParams.getAll("point")[0],"43.7384,7.4246");assert.equal(u.searchParams.get("profile"),"car");assert.equal(u.searchParams.get("details"),"leg_distance");assert.equal((init!.headers as any).Authorization,`Bearer ${process.env.PLANIFICATOR_ROUTING_TOKEN}`);assert.equal(init?.redirect,"error");return Response.json(response())}
 const r=await estimateRoute(input,fake);assert.equal(r.provider,"GRAPHHOPPER");assert.equal(r.estimatedKm,3.043158);assert.equal(r.segmentsKm.length,2);assert.match(r.label,/poids lourds/);assert.match(r.label,/OpenStreetMap/)
 await estimateRoute(input,fake);assert.equal(calls,2)
 const key=routingCacheKey(input,"a");assert.notEqual(key,routingCacheKey(input,"b"));configure("success-newgraph");assert.notEqual(key,routingCacheKey(input,"a"));await estimateRoute(input,fake);assert.equal(calls,3)
})
test("GraphHopper fails closed on malformed, truncated, remote snap and inconsistent distances",async()=>{
 for(const [name,mutate,code] of [
  ["missing",(d:any)=>delete d.paths[0].details.leg_distance,"ROUTE_NOT_FOUND"],
  ["mismatch",(d:any)=>d.paths[0].distance=8000,"INVALID_ROUTE_DISTANCE"],
  ["negative",(d:any)=>d.paths[0].details.leg_distance[0][2]=-1,"INVALID_ROUTE_DISTANCE"],
  ["remote",(d:any)=>d.paths[0].snapped_waypoints.coordinates[0]=[2,48],"ROUTE_POINT_TOO_FAR"],
  ["zero",(d:any)=>{d.paths[0].details.leg_distance[0][2]=0;d.paths[0].distance=1623.127},"AMBIGUOUS_ZERO_DISTANCE"],
 ] as const){configure(name);const d=response();mutate(d);await assert.rejects(estimateRoute(input,async()=>Response.json(d)),new RegExp(code))}
 configure("null");await assert.rejects(estimateRoute(input,async()=>Response.json(null)),/INVALID_ROUTE_RESPONSE/)
 for(const status of [400,401,429,500]){configure("http"+status);await assert.rejects(estimateRoute(input,async()=>new Response("{}",{status})),status===400?/ROUTE_NOT_FOUND/:status===429?/ROUTING_BUSY/:/ROUTING_UNAVAILABLE/)}
 configure("large");await assert.rejects(estimateRoute(input,async()=>new Response("x".repeat(100001))),/ROUTING_RESPONSE_LIMIT/)
 configure("json");await assert.rejects(estimateRoute(input,async()=>new Response("{invalid")),/INVALID_ROUTE_RESPONSE/)
 configure("network");await assert.rejects(estimateRoute(input,async()=>{throw Error("private detail")}),/ROUTING_UNAVAILABLE/)
})
test("unconfirmed, disabled and insecure configuration never contact the provider",async()=>{
 configure("guards");let calls=0;const fake:typeof fetch=async()=>{calls++;return Response.json(response())}
 await assert.rejects(estimateRoute({...input,coordinatesConfirmed:false},fake),/CONFIRMED/)
 process.env.PLANIFICATOR_ROUTING_ENABLED="false";await assert.rejects(estimateRoute(input,fake),/NOT_CONFIGURED/)
 configure("insecure");process.env.PLANIFICATOR_ROUTING_GRAPHHOPPER_URL="http://routing.example.test";await assert.rejects(estimateRoute(input,fake),/CONFIG_INVALID/)
 configure("token");delete process.env.PLANIFICATOR_ROUTING_TOKEN;await assert.rejects(estimateRoute(input,fake),/CONFIG_INVALID/);assert.equal(calls,0)
})
