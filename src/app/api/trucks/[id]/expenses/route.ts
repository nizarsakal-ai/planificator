import { validateVehicleExpenseDocument } from "@/lib/vehicules/v3/integration-bridges"
import { auth } from "@/auth"
import { prisma } from "@/lib/prisma"
import { expenseGet, expensePost } from "@/lib/vehicules/v3/expense-api"
export const dynamic = "force-dynamic"
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) { return expenseGet(request, (await context.params).id, { auth, db: prisma, validateDocumentVersion: validateVehicleExpenseDocument }) }
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) { return expensePost(request, (await context.params).id, { auth, db: prisma, validateDocumentVersion: validateVehicleExpenseDocument }) }
