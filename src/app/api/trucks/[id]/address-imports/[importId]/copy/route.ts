import { auth } from "@/auth"
import { prisma } from "@/lib/prisma"
import { handleImportCopy } from "@/lib/vehicules/import-api"
export async function POST(req:Request,c:{params:Promise<{id:string;importId:string}>}){const p=await c.params;return handleImportCopy(req,p.id,p.importId,{auth,db:prisma})}
