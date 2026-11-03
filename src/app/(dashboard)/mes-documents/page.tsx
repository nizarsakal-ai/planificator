import { notFound } from "next/navigation"
import { Documents } from "@/components/hr-documents/Documents"
import { hrDocumentsEnabled,hrEmployeePortalEnabled,hrIdentity,hrDb } from "@/lib/hr-documents/runtime"
import { PrismaHrRepository } from "@/lib/hr-documents/repository"
export const dynamic="force-dynamic"
export default async function MyDocuments(){
  if(!hrDocumentsEnabled()||!hrEmployeePortalEnabled())notFound()
  const identity=await hrIdentity()
  await new PrismaHrRepository(hrDb()).run(identity,async()=>undefined)
  return <Documents/>
}
