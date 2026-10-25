import { auth } from "@/auth"
import { prisma } from "@/lib/prisma"
import { costGet } from "@/lib/vehicules/v3/expense-api"
export const dynamic = "force-dynamic"
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) { return costGet(request, (await context.params).id, { auth, db: prisma }) }
