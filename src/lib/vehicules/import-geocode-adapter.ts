import type { GeocodePort, GeocodeResult } from "../geo/geocode.port"
import { MileageDomainError } from "./mileage-domain"
import { readImportBoundedBody } from "./import-bounded-body"
export function importGeocodeEndpoint(){
 let url:URL;try{url=new URL(process.env.PLANIFICATOR_GEOCODING_IGN_URL||"https://data.geopf.fr/geocodage/search")}catch{throw new MileageDomainError("GEOCODING_NOT_CONFIGURED",503)}
 if(url.protocol!=="https:"||url.username||url.password||url.search||url.hash)throw new MileageDomainError("GEOCODING_NOT_CONFIGURED",503)
 return url
}
/** IGN/BAN for V3; acquisition's separate adapter is unchanged. */
export function boundedImportGeocodePort(fetchFn:typeof fetch=fetch):GeocodePort{return {async geocodeAddress(address:string):Promise<GeocodeResult>{
 if(process.env.PLANIFICATOR_VEHICLE_GEOCODING_ENABLED!=="true"||process.env.PLANIFICATOR_GEOCODING_PROVIDER!=="IGN")throw new MileageDomainError("GEOCODING_NOT_CONFIGURED",503)
 const q=address.trim();if(q.length<12||q.length>500)throw new MileageDomainError("GEOCODING_CONSENT_REQUIRED",400)
 const url=importGeocodeEndpoint();url.searchParams.set("q",q);url.searchParams.set("index","address");url.searchParams.set("limit","1")
 try{
  const response=await fetchFn(url,{cache:"no-store",redirect:"error",headers:{"Accept":"application/json","User-Agent":"Planificator/3.0 (+https://www.galyaevents.fr)"},signal:AbortSignal.timeout(5000)})
  if(response.status===429)throw new MileageDomainError("GEOCODING_BUSY",429)
  if(!response.ok)throw new MileageDomainError("GEOCODING_UNAVAILABLE",503)
  const bytes=await readImportBoundedBody(response,{decodedContent:true,maxBytes:100000,timeoutMs:5000,invalidStatus:502,limitCode:"GEOCODING_RESPONSE_LIMIT"})
  let data:any;try{data=JSON.parse(bytes.toString("utf8"))}catch{throw new MileageDomainError("INVALID_GEOCODING_RESULT",502)}
  if(data?.type!=="FeatureCollection"||!Array.isArray(data.features))throw new MileageDomainError("INVALID_GEOCODING_RESULT",502)
  if(!data.features.length)return null
  const f=data.features[0],c=f?.geometry?.coordinates,score=f?.properties?.score
  if(f?.geometry?.type!=="Point"||!Array.isArray(c)||c.length!==2||!c.every(Number.isFinite)||Math.abs(c[0])>180||Math.abs(c[1])>90||!Number.isFinite(score)||score<0||score>1)throw new MileageDomainError("INVALID_GEOCODING_RESULT",502)
  if(score<0.6)return null
  return {longitude:c[0],latitude:c[1]}
 }catch(error){if(error instanceof MileageDomainError)throw error;throw new MileageDomainError("GEOCODING_UNAVAILABLE",503)}
}}}
export const importGeocodePort=boundedImportGeocodePort()
