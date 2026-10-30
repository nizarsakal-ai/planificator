import { prisma } from "@/lib/prisma"
import { auth } from "@/auth"
import { handleDriveOAuthCallback, type DriveOAuthDb } from "@/lib/worksite-photos/drive/drive-oauth"

// SPEC-WORKSITE-PHOTOS-001 Lot 2 — callback OAuth Google Drive : state signé, échange du code, stockage chiffré.
export async function GET(request: Request): Promise<Response> {
  return handleDriveOAuthCallback(request, { auth, db: prisma as unknown as DriveOAuthDb })
}
