import { hrDocumentsEnabled,hrEmployeePortalEnabled,hrIdentity,hrDb } from "./runtime"
import { PrismaHrRepository } from "./repository"
import { availableCategories } from "./catalog"
import { imagesEnabled, privateSpaceEnabled } from "./domain"
export async function resolveHrDocumentNavigation(){
  const hidden={hrDocumentsNavVisible:false,hrDocumentsManageNavVisible:false}
  if(!hrDocumentsEnabled())return hidden
  try{
    return await new PrismaHrRepository(hrDb()).run(await hrIdentity(),async(_,a)=>({
      hrDocumentsNavVisible:hrEmployeePortalEnabled()&&!!a.employeeId,hrDocumentsManageNavVisible:a.capabilities.includes("READ"),
    }))
  }catch{return hidden}
}
/**
 * Espace privé RH dans la fiche employé : visible seulement avec l'espace privé actif et l'habilitation READ
 * (capacités par utilisateur et société, jamais le seul rôle). Le serveur revérifie tout à chaque appel.
 */
export async function resolveEmployeeHrSpace(){
  if(!hrDocumentsEnabled()||!privateSpaceEnabled())return null
  try{
    return await new PrismaHrRepository(hrDb()).run(await hrIdentity(),async(_,a)=>a.capabilities.includes("READ")?{
      canAccept:a.capabilities.includes("IMPORT"),canWrite:a.capabilities.includes("IMPORT"),images:imagesEnabled(),
      categories:availableCategories().map(({code,label,family})=>({code,label,family})),
    }:null)
  }catch{return null}
}
