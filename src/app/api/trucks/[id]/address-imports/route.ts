import { auth } from "@/auth"
import { prisma } from "@/lib/prisma"
import { importFailure, importHeaders, handleImportUpload } from "@/lib/vehicules/import-api"
import { listImports } from "@/lib/vehicules/import-service"
export async function GET(_req:Request,c:{params:Promise<{id:string}>}){try{return Response.json(await listImports((await c.params).id,{auth,db:prisma}),{headers:importHeaders})}catch(e){return importFailure(e)}}
export async function POST(req:Request,c:{params:Promise<{id:string}>}){return handleImportUpload(req,(await c.params).id,{auth,db:prisma})}
