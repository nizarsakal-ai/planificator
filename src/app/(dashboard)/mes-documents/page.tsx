import { notFound } from "next/navigation"
import { Documents } from "@/components/hr-documents/Documents"
import { HrPrivateSpace } from "@/components/hr-documents/EmployeeHrFolder"
import { hrDocumentsEnabled,hrEmployeePortalEnabled,hrIdentity,hrDb } from "@/lib/hr-documents/runtime"
import { PrismaHrRepository } from "@/lib/hr-documents/repository"
import { imagesEnabled,privateSpaceEnabled } from "@/lib/hr-documents/domain"
import { availableCategories } from "@/lib/hr-documents/catalog"
export const dynamic="force-dynamic"
export default async function MyDocuments(){
  if(!hrDocumentsEnabled()||!hrEmployeePortalEnabled())notFound()
  const identity=await hrIdentity()
  const actor=await new PrismaHrRepository(hrDb()).run(identity,async(_,a)=>a)
  // Espace privé seulement pour un salarié rattaché à la société ; sinon la page historique, inchangée.
  if(!privateSpaceEnabled()||!actor.employeeId)return <Documents/>
  return <section className="mx-auto max-w-5xl space-y-5">
    <header><h1 className="text-2xl font-semibold text-slate-900">Mes documents</h1>
      <p className="mt-2 text-sm text-slate-600">Vos documents RH, vos pièces transmises et vos échanges privés avec les RH. Aucun document d’un autre salarié n’est accessible.</p></header>
    <HrPrivateSpace mode="employee" categories={availableCategories().map(({code,label,family})=>({code,label,family}))} images={imagesEnabled()}/>
  </section>
}
