import { assertMutationOrigin } from "./request-origin"
import { readImportBoundedBody } from "./import-bounded-body"
import { MileageDomainError } from "./mileage-domain"
export const importHeaders={"Cache-Control":"private, no-store", "X-Content-Type-Options":"nosniff"}
export function importFailure(error:unknown){return Response.json({code:error instanceof MileageDomainError?error.code:"IMPORT_FAILED",error:"Opération indisponible ou refusée"},{status:error instanceof MileageDomainError?error.status:500,headers:importHeaders})}
export function assertImportOrigin(request:Request){
  assertMutationOrigin(request, "ORIGIN_FORBIDDEN")
}
export async function limitedJson(request:Request){
 const bytes=await readImportBoundedBody(request,{maxBytes:100000})
 try{return JSON.parse(bytes.toString("utf8"))}catch{throw new MileageDomainError("INVALID_JSON",400)}
}
export async function limitedImportForm(request:Request){
 const contentType=request.headers.get("content-type")??""
 if(contentType.length>256||!/^multipart\/form-data;\s*boundary=/i.test(contentType))throw new MileageDomainError("INVALID_CONTENT_TYPE",415)
 const bytes=await readImportBoundedBody(request,{maxBytes:4300000,limitCode:"IMPORT_SIZE_LIMIT"})
 try{return await new Response(new Uint8Array(bytes),{headers:{"Content-Type":contentType}}).formData()}catch{throw new MileageDomainError("INVALID_FORM_DATA",400)}
}

// Keep admission before body consumption. Services revalidate the same authority
// again after IO and inside their final transaction.
export async function handleImportUpload(request:Request,truckId:string,deps:import("./import-service").ImportDeps){
 try{
  assertImportOrigin(request)
  const {preauthorizeImport,createImport}=await import("./import-service")
  await preauthorizeImport(truckId,deps)
  const form=await limitedImportForm(request),file=form.get("file")
  if(!(file instanceof File)||file.size>4194304)throw new MileageDomainError("INVALID_FILE",400)
  const result=await createImport(truckId,{bytes:Buffer.from(await file.arrayBuffer()),mime:file.type,filename:file.name,ocrConsent:form.get("ocrConsent")==="true"},deps)
  return Response.json({id:result.id},{status:201,headers:importHeaders})
 }catch(error){return importFailure(error)}
}
export async function handleImportReview(request:Request,truckId:string,importId:string,deps:import("./import-service").ImportDeps){
 try{
  assertImportOrigin(request)
  const {preauthorizeImport,reviewImport}=await import("./import-service")
  await preauthorizeImport(truckId,deps)
  return Response.json(await reviewImport(truckId,importId,await limitedJson(request),deps),{headers:importHeaders})
 }catch(error){return importFailure(error)}
}
