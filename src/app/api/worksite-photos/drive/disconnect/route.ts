import { auth } from "@/auth"
import { prisma } from "@/lib/prisma"
import { handleDriveDisconnect, type DriveOAuthDb } from "@/lib/worksite-photos/drive/drive-oauth"

// SPEC-WORKSITE-PHOTOS-001 Lot 2 — déconnexion Drive LOCALE (D16) : aucune révocation Google, connexions Gmail intactes.
export async function POST(request: Request): Promise<Response> {
  return handleDriveDisconnect(request, { auth, db: prisma as unknown as DriveOAuthDb })
}
