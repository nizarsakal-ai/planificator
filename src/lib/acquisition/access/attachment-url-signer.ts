import { v2 as cloudinary } from "cloudinary"
import type { AttachmentUrlSignerPort } from "@/lib/acquisition/access/attachment-access.port"
import type { CreateSignedUrlInput, SignedUrlResult } from "@/lib/acquisition/access/attachment-access.types"

/** Signature Cloudinary authenticated/raw — aucune URL journalisée. */
export class CloudinaryAttachmentUrlSigner implements AttachmentUrlSignerPort {
  async createSignedUrl(input: CreateSignedUrlInput): Promise<SignedUrlResult> {
    const expiresAtUnix = Math.floor(input.expiresAt.getTime() / 1000)
    try {
      const url = cloudinary.utils.private_download_url(
        input.storagePublicId,
        "",
        {
          resource_type: "raw",
          type: "authenticated",
          expires_at: expiresAtUnix,
          attachment: false,
        }
      )
      return { url }
    } catch {
      throw new Error("ATTACHMENT_ACCESS_SIGN_FAILED")
    }
  }
}

export const cloudinaryAttachmentUrlSigner = new CloudinaryAttachmentUrlSigner()
