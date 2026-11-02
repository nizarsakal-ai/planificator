import { hrDocumentsEnabled,hrIdentity,hrDb } from "./runtime"
import { PrismaHrRepository } from "./repository"
export async function resolveHrDocumentNavigation(){
  const hidden={hrDocumentsNavVisible:false,hrDocumentsManageNavVisible:false}
  if(!hrDocumentsEnabled())return hidden
  try{
    return await new PrismaHrRepository(hrDb()).run(await hrIdentity(),async(_,a)=>({
      hrDocumentsNavVisible:!!a.employeeId,hrDocumentsManageNavVisible:a.capabilities.includes("READ"),
    }))
  }catch{return hidden}
}
