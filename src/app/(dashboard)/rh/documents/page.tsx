import { auth } from "@/auth"
import { notFound } from "next/navigation"
import { Documents } from "@/components/hr-documents/Documents"
import { hrDocumentsEnabled,hrIdentity,hrDb } from "@/lib/hr-documents/runtime"
import { PrismaHrRepository } from "@/lib/hr-documents/repository"
import { employeeDraftsEnabled, employeeSelectionSchema, HrError, imagesEnabled, recognitionEnabled, type Identity } from "@/lib/hr-documents/domain"
import { availableCategories } from "@/lib/hr-documents/catalog"
export const dynamic="force-dynamic"
export default async function HrDocuments({searchParams}:{searchParams:Promise<{employeeId?:string|string[]}>}){
  if(!hrDocumentsEnabled())notFound()
  let identity:Identity
  try{identity=await hrIdentity()}catch(error){
    if(error instanceof HrError&&(error.status===403||error.status===404))notFound()
    throw error
  }
  const actor=await new PrismaHrRepository(hrDb()).run(identity,async(_,a)=>a)
  if(!actor.capabilities.includes("READ"))notFound()
  const selected=employeeSelectionSchema.safeParse((await searchParams).employeeId)
  if(!selected.success)notFound()
  let employeeContext:{id:string;firstName:string;lastName:string}|undefined
  if(selected.data){
    const employee=await new PrismaHrRepository(hrDb()).run(identity,(tx,a)=>tx.employee(a.companyId,selected.data!))
    if(!employee)notFound()
    employeeContext={id:employee.id,firstName:employee.firstName??"",lastName:employee.lastName??""}
  }
  const session=await auth()
  const canReturnToEmployee=["ADMIN","SUPER_ADMIN"].includes(session?.user?.role??"")
  return <Documents key={selected.data??"all"} employeeId={selected.data} employeeContext={employeeContext} canReturnToEmployee={canReturnToEmployee} manage configure={actor.capabilities.includes("CONFIGURE")} canImport={actor.capabilities.includes("IMPORT")} canPublish={actor.capabilities.includes("PUBLISH")} mailEnabled={process.env.HR_DOCUMENT_MAIL_ENABLED==="true"} categories={availableCategories().map(({code,label,family})=>({code,label,family}))} recognition={recognitionEnabled()} images={imagesEnabled()} drafts={employeeDraftsEnabled()}/>
}
