/**
 * PLAN-ACQ-V2 R2 — Chargement bytes PJ pour extraction texte PDF.
 * Échec non fatal — retourne null.
 */

import { cloudinaryAttachmentUrlSigner } from "@/lib/acquisition/access/attachment-url-signer"

export type AttachmentBytesRef = {
  filename: string
  mimeType: string
  storagePublicId: string | null
  status: string
}

export type AttachmentBytesLoader = (
  att: AttachmentBytesRef
) => Promise<Buffer | null>

const FETCH_TIMEOUT_MS = 8_000

export const defaultAttachmentBytesLoader: AttachmentBytesLoader = async (att) => {
  if (att.status !== "STORED" || !att.storagePublicId) return null
  try {
    const expiresAt = new Date(Date.now() + 60_000)
    const signed = await cloudinaryAttachmentUrlSigner.createSignedUrl({
      storagePublicId: att.storagePublicId,
      expiresAt,
    })
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
    try {
      const res = await fetch(signed.url, { signal: controller.signal })
      if (!res.ok) return null
      const ab = await res.arrayBuffer()
      return Buffer.from(ab)
    } finally {
      clearTimeout(timer)
    }
  } catch {
    return null
  }
}
