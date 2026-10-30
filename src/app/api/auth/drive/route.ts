import { auth } from "@/auth"
import { prisma } from "@/lib/prisma"
import { handleDriveConnectStart, type DriveOAuthDb } from "@/lib/worksite-photos/drive/drive-oauth"

// SPEC-WORKSITE-PHOTOS-001 Lot 2 — démarrage OAuth Google Drive (administrateurs). Wrapper fin : métier dans drive-oauth.ts.
export async function GET(request: Request): Promise<Response> {
  return handleDriveConnectStart(request, { auth, db: prisma as unknown as DriveOAuthDb })
}
