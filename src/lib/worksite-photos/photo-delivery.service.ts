import { createHash } from "node:crypto"
import { readBoundedBodyBytes } from "@/lib/http/bounded-body"
import type { PhotoStoragePort } from "./photo-storage.port"
import { WorksitePhotoDomainError } from "./photo.domain"

export const MAX_DELIVERY_PHOTOS = 100
// Leave room for base64 and MIME overhead in the provider's 40 MB email limit.
export const MAX_DELIVERY_BYTES = 24 * 1024 * 1024

export interface DeliveryPhoto {
  id: string
  driveFileId: string
  mimeType: string
  sizeBytes: number
  sha256: string
  deliveryClaim: string | null
}

export interface DeliveryBatch {
  worksiteName: string
  recipients: Array<{ label: string | null; email: string }>
  photos: DeliveryPhoto[]
}

export interface DeliveryMessage {
  to: string[]
  subject: string
  text: string
  attachments: Array<{ filename: string; content: string }>
}

export interface DeliveryDeps {
  storage: Pick<PhotoStoragePort, "download">
  claim(snapshot: string): Promise<string>
  send(message: DeliveryMessage, claim: string): Promise<{ acceptedId: string } | { rejected: true }>
  release(claim: string): Promise<void>
  finish(claim: string, recipients: string[], acceptedId: string): Promise<void>
}

export function deliverySnapshot(batch: DeliveryBatch): string {
  return createHash("sha256").update(JSON.stringify([
    batch.worksiteName,
    batch.recipients.map(({ label, email }) => [label, email]),
    batch.photos.map(({ id, deliveryClaim }) => [id, deliveryClaim]),
  ])).digest("hex")
}

export function deliveryBlock(batch: DeliveryBatch): string | null {
  if (batch.photos.some(({ deliveryClaim }) => deliveryClaim)) return "DELIVERY_PENDING"
  if (!batch.recipients.length) return "DELIVERY_NO_RECIPIENTS"
  if (!batch.photos.length) return "DELIVERY_NO_PHOTOS"
  if (batch.photos.length > MAX_DELIVERY_PHOTOS ||
      batch.photos.reduce((sum, photo) => sum + photo.sizeBytes, 0) > MAX_DELIVERY_BYTES) {
    return "DELIVERY_TOO_LARGE"
  }
  return null
}

export function assertDeliverySnapshot(batch: DeliveryBatch, expected: string): void {
  if (expected !== deliverySnapshot(batch)) throw new WorksitePhotoDomainError("DELIVERY_CHANGED", 409)
  const block = deliveryBlock(batch)
  if (block) throw new WorksitePhotoDomainError(block, 409)
}

export async function deliverWorksitePhotos(
  companyId: string,
  batch: DeliveryBatch,
  expected: string,
  deps: DeliveryDeps,
): Promise<{ photoCount: number }> {
  assertDeliverySnapshot(batch, expected)
  const attachments: DeliveryMessage["attachments"] = []

  for (const [index, photo] of batch.photos.entries()) {
    const download = await deps.storage.download(companyId, photo.driveFileId)
    const bytes = await readBoundedBodyBytes(new Request("https://local.invalid", {
      method: "POST", body: download.stream, duplex: "half",
    } as RequestInit), photo.sizeBytes, {
      sizeCode: "PHOTO_CHECKSUM_MISMATCH",
    })
    if (bytes.length !== photo.sizeBytes || createHash("sha256").update(bytes).digest("hex") !== photo.sha256) {
      throw new WorksitePhotoDomainError("PHOTO_CHECKSUM_MISMATCH", 409)
    }
    attachments.push({
      filename: `photo-${index + 1}.${photo.mimeType === "image/png" ? "png" : "jpg"}`,
      content: Buffer.from(bytes).toString("base64"),
    })
  }

  // Revalidate the reviewed batch after reading Drive. The durable claim survives a timeout or lost provider response.
  const claim = await deps.claim(expected)
  const recipients = batch.recipients.map(({ email }) => email)
  let receipt: Awaited<ReturnType<DeliveryDeps["send"]>>
  try {
    receipt = await deps.send({
      to: recipients,
      subject: `Photos du chantier — ${batch.worksiteName.replace(/[\r\n]+/g, " ")}`,
      text: `Bonjour,\n\nVous trouverez en pièces jointes les photos validées du chantier ${batch.worksiteName}.\n\nCordialement,\nGALYA Events`,
      attachments,
    }, claim)
  } catch {
    throw new WorksitePhotoDomainError("DELIVERY_PENDING", 409)
  }

  if ("rejected" in receipt) {
    await deps.release(claim)
    throw new WorksitePhotoDomainError("DELIVERY_REJECTED", 502)
  }
  try {
    await deps.finish(claim, recipients, receipt.acceptedId)
  } catch {
    throw new WorksitePhotoDomainError("DELIVERY_PENDING", 409)
  }
  return { photoCount: attachments.length }
}
