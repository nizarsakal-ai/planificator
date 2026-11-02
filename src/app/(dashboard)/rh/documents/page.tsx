import { notFound } from "next/navigation"
import { Documents } from "@/components/hr-documents/Documents"
import { hrDocumentsEnabled,hrIdentity,hrDb } from "@/lib/hr-documents/runtime"
import { PrismaHrRepository } from "@/lib/hr-documents/repository"
export const dynamic="force-dynamic"
export default async function HrDocuments(){
  if(!hrDocumentsEnabled())notFound()
  const identity=await hrIdentity()
  const actor=await new PrismaHrRepository(hrDb()).run(identity,async(_,a)=>a)
  if(!actor.capabilities.includes("READ"))notFound()
  return <Documents manage configure={actor.capabilities.includes("CONFIGURE")} canImport={actor.capabilities.includes("IMPORT")} canPublish={actor.capabilities.includes("PUBLISH")} mailEnabled={process.env.HR_DOCUMENT_MAIL_ENABLED==="true"}/>
}
