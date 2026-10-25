import { readImportBoundedBody } from "./import-bounded-body"
import { v2 as cloudinary } from "cloudinary"
import { createHash, randomUUID } from "node:crypto"
import { MileageDomainError } from "./mileage-domain"
import { ensureCloudinaryConfigured } from "./cloudinary-config"
/** Triplet CLOUDINARY_* ou CLOUDINARY_URL (même règle que l'adaptateur documents) ; 503 sinon, avant tout octet. */
function configure(){ensureCloudinaryConfigured("SOURCE_STORAGE_NOT_CONFIGURED")}
export async function storeImportSource(bytes:Buffer,companyId:string,truckId:string){configure();const opaque=(v:string)=>createHash("sha256").update(v).digest("hex").slice(0,24);const id=`vehicle-imports/${opaque(companyId)}/${opaque(truckId)}/${randomUUID()}`;await new Promise<void>((resolve,reject)=>{cloudinary.uploader.upload_stream({public_id:id,resource_type:"raw",type:"authenticated",overwrite:false,timeout:10000},(e,r)=>e||!r?reject(new MileageDomainError("SOURCE_STORAGE_FAILED",503)):resolve()).end(bytes)});return id}
export async function readImportSource(id:string,fetchFn:typeof fetch=fetch){configure();if(!/^vehicle-imports\/[a-f0-9]{24}\/[a-f0-9]{24}\/[a-z0-9-]{36}$/.test(id))throw new MileageDomainError("SOURCE_UNAVAILABLE",503);const url=cloudinary.utils.private_download_url(id,"",{resource_type:"raw",type:"authenticated",expires_at:Math.floor(Date.now()/1000)+300,attachment:false});const res=await fetchFn(url,{cache:"no-store",redirect:"error",signal:AbortSignal.timeout(10000)});if(!res.ok)throw new MileageDomainError("SOURCE_UNAVAILABLE",503);return readImportBoundedBody(res,{decodedContent:true,maxBytes:4*1024*1024,timeoutMs:10000,limitCode:"SOURCE_SIZE_LIMIT",invalidStatus:502})}
