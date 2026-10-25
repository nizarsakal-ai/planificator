import { readImportBoundedBody } from "./import-bounded-body"
import { z } from "zod"
import { createHash } from "node:crypto"
import { MileageDomainError } from "./mileage-domain"
export const routeInput=z.object({points:z.array(z.object({latitude:z.number().min(-90).max(90),longitude:z.number().min(-180).max(180)}).strict()).min(2).max(40),coordinatesConfirmed:z.literal(true)}).strict()
export type RouteEstimate={estimatedKm:number;segmentsKm:number[];provider:"OSRM"|"GRAPHHOPPER";profile:"driving";estimatedAt:string;label:string}
export function routingConfiguration(){
 const provider=process.env.PLANIFICATOR_ROUTING_PROVIDER??"OSRM"
 const endpoint=provider==="GRAPHHOPPER"?process.env.PLANIFICATOR_ROUTING_GRAPHHOPPER_URL:process.env.PLANIFICATOR_ROUTING_OSRM_URL
 if(process.env.PLANIFICATOR_ROUTING_ENABLED!=="true"||!endpoint)throw new MileageDomainError("ROUTING_NOT_CONFIGURED",503)
 let url:URL;try{url=new URL(endpoint)}catch{throw new MileageDomainError("ROUTING_CONFIG_INVALID",503)}
 if(!["OSRM","GRAPHHOPPER"].includes(provider)||!["http:","https:"].includes(url.protocol)||url.username||url.password||url.search||url.hash||["router.project-osrm.org","routing.openstreetmap.de"].includes(url.hostname))throw new MileageDomainError("ROUTING_CONFIG_INVALID",503)
 const token=process.env.PLANIFICATOR_ROUTING_TOKEN,version=process.env.PLANIFICATOR_ROUTING_GRAPH_VERSION??"legacy"
 if(provider==="GRAPHHOPPER"&&(url.protocol!=="https:"||!token||token.length<32||version==="legacy"))throw new MileageDomainError("ROUTING_CONFIG_INVALID",503)
 return {provider:provider as RouteEstimate["provider"],endpoint:url.href.replace(/\/$/,""),token,version}
}
export function routingCacheKey(raw:unknown,companyId=""){const input=routeInput.parse(raw),c=routingConfiguration();return createHash("sha256").update(JSON.stringify([companyId,c.provider,c.endpoint,c.version,"driving",input.points])).digest("hex")}
function distance(value:unknown){if(typeof value!=="number"||!Number.isFinite(value)||value<0||value>50000000)throw new MileageDomainError("INVALID_ROUTE_DISTANCE",502);return value/1000}
export async function estimateRoute(raw:unknown,fetchFn:typeof fetch=fetch):Promise<RouteEstimate>{
 const parsed=routeInput.safeParse(raw);if(!parsed.success)throw new MileageDomainError("CONFIRMED_COORDINATES_REQUIRED",400)
 const c=routingConfiguration()
 const points=parsed.data.points;let requestUrl:string
 if(c.provider==="GRAPHHOPPER"){
  const url=new URL(c.endpoint+"/route");for(const p of points)url.searchParams.append("point",`${p.latitude},${p.longitude}`)
  // Simplification affects returned geometry only. Keep each leg boundary for distance validation.
  for(const [k,v] of Object.entries({profile:"car",instructions:"false",calc_points:"true",points_encoded:"false",details:"leg_distance",elevation:"false",way_point_max_distance:"1000000"}))url.searchParams.set(k,v)
  requestUrl=url.href
 }else requestUrl=`${c.endpoint}/route/v1/driving/${points.map(p=>`${p.longitude},${p.latitude}`).join(";")}?overview=false&steps=false`
 let res:Response;try{res=await fetchFn(requestUrl,{cache:"no-store",redirect:"error",signal:AbortSignal.timeout(5000),headers:c.provider==="GRAPHHOPPER"?{"Authorization":`Bearer ${c.token}`}:{}})}catch{throw new MileageDomainError("ROUTING_UNAVAILABLE",503)}
 if(res.status===429)throw new MileageDomainError("ROUTING_BUSY",429)
 if(!res.ok)throw new MileageDomainError(res.status===400?"ROUTE_NOT_FOUND":"ROUTING_UNAVAILABLE",res.status===400?422:503)
 let data:any;try{data=JSON.parse((await readImportBoundedBody(res,{decodedContent:true,maxBytes:100000,timeoutMs:5000,limitCode:"ROUTING_RESPONSE_LIMIT",invalidStatus:502})).toString("utf8"))}catch(e){if(e instanceof MileageDomainError)throw e;throw new MileageDomainError("INVALID_ROUTE_RESPONSE",502)}
 if(!data||typeof data!=="object"||Array.isArray(data))throw new MileageDomainError("INVALID_ROUTE_RESPONSE",502)
 let segmentsKm:number[]
 if(c.provider==="GRAPHHOPPER"){
  const path=data.paths?.[0],legs=path?.details?.leg_distance,snaps=path?.snapped_waypoints?.coordinates
  if(!path||!Array.isArray(legs)||legs.length!==points.length-1||!Array.isArray(snaps)||snaps.length!==points.length)throw new MileageDomainError("ROUTE_NOT_FOUND",422)
  for(let i=0;i<points.length;i++){
   const s=snaps[i],p=points[i];if(!Array.isArray(s)||s.length!==2||!s.every((v:unknown)=>typeof v==="number"&&Number.isFinite(v))||Math.abs(s[0])>180||Math.abs(s[1])>90)throw new MileageDomainError("INVALID_ROUTE_RESPONSE",502)
   const rad=Math.PI/180,a=Math.sin((s[1]-p.latitude)*rad/2)**2+Math.cos(p.latitude*rad)*Math.cos(s[1]*rad)*Math.sin((s[0]-p.longitude)*rad/2)**2
   if(6371000*2*Math.asin(Math.sqrt(Math.min(1,a)))>1000)throw new MileageDomainError("ROUTE_POINT_TOO_FAR",422)
  }
  segmentsKm=legs.map((l:unknown)=>{if(!Array.isArray(l)||l.length!==3)throw new MileageDomainError("INVALID_ROUTE_RESPONSE",502);return distance(l[2])})
  if(Math.abs(distance(path.distance)-segmentsKm.reduce((a,b)=>a+b,0))>0.01)throw new MileageDomainError("INVALID_ROUTE_DISTANCE",502)
 }else{
  const route=data.routes?.[0];if(data.code!=="Ok"||!route||!Array.isArray(route.legs)||route.legs.length!==points.length-1)throw new MileageDomainError("ROUTE_NOT_FOUND",422)
  segmentsKm=route.legs.map((l:{distance:number})=>distance(l.distance))
 }
 if(segmentsKm.some((km,i)=>km===0&&(points[i].latitude!==points[i+1].latitude||points[i].longitude!==points[i+1].longitude)))throw new MileageDomainError("AMBIGUOUS_ZERO_DISTANCE",422)
 const value:RouteEstimate={estimatedKm:segmentsKm.reduce((a,b)=>a+b,0),segmentsKm,provider:c.provider,profile:"driving",estimatedAt:new Date().toISOString(),label:"Distance routière estimée en France métropolitaine, profil voiture (restrictions poids lourds non garanties) — jamais un kilométrage réel. Départ et retour uniquement si inclus dans les points. © OpenStreetMap contributors."}
 return value
}
export interface RoutingPort { estimate(input:unknown):Promise<RouteEstimate> }
export class OsrmRoutingAdapter implements RoutingPort { constructor(private readonly fetchFn:typeof fetch=fetch){} estimate(input:unknown){return estimateRoute(input,this.fetchFn)} }
export class GraphHopperRoutingAdapter implements RoutingPort { constructor(private readonly fetchFn:typeof fetch=fetch){} estimate(input:unknown){return estimateRoute(input,this.fetchFn)} }
