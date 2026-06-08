import { NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"

// Endpoint temporaire pour test — supprime les messages traités et relance le scan
export async function GET(req: Request) {
  const authHeader = req.headers.get("authorization")
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const deleted = await prisma.processedGmailMessage.deleteMany({})

  return NextResponse.json({ ok: true, deleted: deleted.count })
}
