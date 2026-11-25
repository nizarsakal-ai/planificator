"use server"

import { v2 as cloudinary } from "cloudinary"
import { auth } from "@/auth"
import { prisma } from "@/lib/prisma"
import { cloudinaryPublicIdFromUrl, deleteOwnAccountImpl, type AccountDeletionResult } from "@/lib/account/account-deletion.core"
import { prismaAccountDeletionDeps } from "@/lib/account/account-deletion.prisma"

// Lot 2b juridique : « Supprimer mon compte » depuis le profil (règles : account-deletion.core.ts ; base :
// account-deletion.prisma.ts).

async function deleteAvatarsFromCloudinary(urls: string[]) {
  for (const url of urls) {
    const publicId = cloudinaryPublicIdFromUrl(url)
    if (!publicId) continue
    const result = await cloudinary.uploader.destroy(publicId, { resource_type: "image", invalidate: true })
    if (result?.result !== "ok" && result?.result !== "not found") throw new Error("AVATAR_DESTROY_FAILED")
  }
}

export async function deleteOwnAccount(formData: FormData): Promise<AccountDeletionResult> {
  return deleteOwnAccountImpl(
    {
      password: String(formData.get("password") ?? ""),
      confirmation: String(formData.get("confirmation") ?? ""),
    },
    prismaAccountDeletionDeps(prisma, async () => (await auth())?.user?.id ?? null, deleteAvatarsFromCloudinary),
  )
}
