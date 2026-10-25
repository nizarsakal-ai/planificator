import { createHash } from "node:crypto"
import { z } from "zod"
import { MileageDomainError } from "./mileage-domain"
export const MAX_IMPORT_BYTES = 4 * 1024 * 1024
export const candidateSchema = z.object({ label:z.string().trim().min(1).max(200), address:z.string().trim().min(1).max(500), excerpt:z.string().max(1000), page:z.number().int().min(1).max(20).nullable(), latitude:z.number().min(-90).max(90).nullable(), longitude:z.number().min(-180).max(180).nullable(), confirmed:z.boolean() }).strict()
export const candidatesSchema = z.array(candidateSchema).max(40)
export type ImportCandidate = z.infer<typeof candidateSchema>
export const reviewSchema=z.object({expectedRevision:z.number().int().min(0).max(10000), approve:z.literal(true), candidates:candidatesSchema.min(1)}).strict()
export const hashSource=(bytes:Buffer)=>createHash("sha256").update(bytes).digest("hex")
export function assessCandidates(candidates:ImportCandidate[]) {
 const seen=new Set<string>(); const warnings:string[]=[]
 candidates.forEach((c,i)=>{const k=c.address.toLocaleLowerCase().replace(/[^\p{L}\p{N}]/gu,"");if(seen.has(k))warnings.push(`DOUBLON_PROBABLE:${i+1}`);seen.add(k);if(!/\d/.test(c.address)||c.address.length<12)warnings.push(`ADRESSE_INCOMPLETE:${i+1}`)})
 return warnings
}
export function validateReview(raw:unknown) {const v=reviewSchema.safeParse(raw);if(!v.success)throw new MileageDomainError("INVALID_REVIEW",400);if(v.data.candidates.some(c=>c.address.length<5))throw new MileageDomainError("INVALID_REVIEW",400);if(v.data.candidates.some(c=>!c.confirmed))throw new MileageDomainError("HUMAN_CONFIRMATION_REQUIRED",400);return v.data}
export function extractAddressLines(text:string):ImportCandidate[] {return text.split(/\n|;/).map(s=>s.trim()).filter(s=>/\d/.test(s)&&/(rue|avenue|boulevard|route|chemin|place|allee|allée|impasse|\b[0-9]{5}\b)/i.test(s)).slice(0,40).map(s=>({label:s.slice(0,200),address:s.slice(0,500),excerpt:s.slice(0,1000),page:null,latitude:null,longitude:null,confirmed:false}))}
export function verifyBytes(bytes:Buffer,mime:string){if(!bytes.length||bytes.length>MAX_IMPORT_BYTES)throw new MileageDomainError("IMPORT_SIZE_LIMIT",413);const valid=mime==="text/plain"?!bytes.includes(0):mime==="application/pdf"?bytes.subarray(0,5).toString()==="%PDF-":mime==="image/png"?bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])):mime==="image/jpeg"?bytes[0]===255&&bytes[1]===216&&bytes[2]===255:false;if(!valid)throw new MileageDomainError("UNSUPPORTED_SOURCE",400)}
