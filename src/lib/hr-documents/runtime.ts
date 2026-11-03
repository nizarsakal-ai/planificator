import { PrismaClient } from "@prisma/client"
import { auth } from "@/auth"
import { serverlessDatasources } from "@/lib/database-url"
import { getValidDriveAccessToken, type DriveConnectionDb } from "@/lib/worksite-photos/drive/drive-connection.client"
import { capabilitiesFor, digest, HrError, requireCapability, type Identity,type Capability } from "./domain"
import { GooglePrivateDrive } from "./drive"
import { PrismaHrRepository } from "./repository"
import { HrDocumentsService } from "./service"

export function hrDocumentsEnabled(env:NodeJS.ProcessEnv=process.env){return env.HR_DOCUMENTS_ENABLED==="true"}
export function hrEmployeePortalEnabled(env:NodeJS.ProcessEnv=process.env){return env.HR_DOCUMENT_EMPLOYEE_PORTAL_ENABLED==="true"}
// A separate singleton explicitly disables SQL logging (the legacy development client logs query parameters).
const holder=globalThis as unknown as {hrDocumentsDb?:PrismaClient}
export function hrDb(){return holder.hrDocumentsDb??=(new PrismaClient({...serverlessDatasources(),log:[]}))}
export async function hrIdentity():Promise<Identity>{
  if(!hrDocumentsEnabled())throw new HrError("DISABLED",404)
  const user=(await auth())?.user
  if(!user?.id||!user.companyId)throw new HrError("FORBIDDEN",403)
  const identity={userId:user.id,companyId:user.companyId}
  if(!hrEmployeePortalEnabled()&&!capabilitiesFor(process.env.HR_DOCUMENT_OPERATORS,identity).length)throw new HrError("DISABLED",404)
  return identity
}
export async function hrOperator(identity:Identity,capability:Capability){
  return new PrismaHrRepository(hrDb()).run(identity,async(_,actor)=>{
    requireCapability(actor,capability)
    if(capability!=="CONFIGURE")requireCapability(actor,"READ")
  })
}
export function hrService(){
  const db=hrDb()
  return new HrDocumentsService(new PrismaHrRepository(db),async(companyId)=>{
    // Reuse only the transport credential, never Photos rootFolderId, events, purges or authorization.
    // Explicit account bindings: no production identity is hardcoded in the repository.
    let bindings:unknown
    try{bindings=JSON.parse(process.env.HR_DOCUMENT_DRIVE_ACCOUNTS??"{}")}catch{throw new HrError("STORAGE_NOT_READY",409)}
    if(!bindings||typeof bindings!=="object"||Array.isArray(bindings))throw new HrError("STORAGE_NOT_READY",409)
    const expected=(bindings as Record<string,unknown>)[companyId]
    if(typeof expected!=="string"||!expected.includes("@"))throw new HrError("STORAGE_NOT_READY",409)
    const connection=await db.worksitePhotoDriveConnection.findUnique({where:{companyId}})
    if(!connection||connection.status!=="ACTIVE"||connection.accountEmail.toLowerCase()!==expected.toLowerCase())throw new HrError("STORAGE_NOT_READY",409)
    const generation=digest(connection.refreshToken)
    // Pin the generation for refresh: a Photos reconnection to another account cannot leak its token into RH.
    const adapter:DriveConnectionDb={worksitePhotoDriveConnection:{
      findUnique:async()=>{
        const current=await db.worksitePhotoDriveConnection.findUnique({where:{companyId}})
        return current&&current.accountEmail===connection.accountEmail&&current.refreshToken===connection.refreshToken?current:null
      },
      update:async()=>{throw new HrError("FORBIDDEN",403)},upsert:async()=>{throw new HrError("FORBIDDEN",403)},
      updateMany:async(args)=>db.worksitePhotoDriveConnection.updateMany(args),
    }}
    const token=await getValidDriveAccessToken(companyId,{db:adapter})
    return {drive:new GooglePrivateDrive(token,expected.toLowerCase()),generation,accountEmail:expected.toLowerCase()}
  })
}
