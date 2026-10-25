import { auth } from "@/auth"
import { prisma } from "@/lib/prisma"
import { handleImportReview } from "@/lib/vehicules/import-api"
export async function POST(req:Request,c:{params:Promise<{id:string;importId:string}>}){const p=await c.params;return handleImportReview(req,p.id,p.importId,{auth,db:prisma})}
