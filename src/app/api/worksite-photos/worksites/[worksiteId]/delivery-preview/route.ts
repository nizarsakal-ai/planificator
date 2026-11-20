import { randomUUID } from "node:crypto"
import { Prisma } from "@prisma/client"
import { Resend } from "resend"
import { z } from "zod"
import { readBoundedBodyBytes } from "@/lib/http/bounded-body"
import { canReadPhotoRecipients } from "@/lib/chantiers/photo-recipients-access"
import { prisma } from "@/lib/prisma"
import { photoJson, photoRoute } from "@/lib/worksite-photos/photo.api"
import { productionPhotoDeps } from "@/lib/worksite-photos/photo.deps"
import { resolveSuperAdmin } from "@/lib/worksite-photos/photo-review.service"
import { WorksitePhotoDomainError } from "@/lib/worksite-photos/photo.domain"
import {
  assertDeliverySnapshot, deliverWorksitePhotos, deliveryBlock, deliverySnapshot, MAX_DELIVERY_PHOTOS,
  type DeliveryPhoto,
} from "@/lib/worksite-photos/photo-delivery.service"

const worksiteIdSchema = z.string().min(1).max(64)
const confirmation = z.object({ snapshot: z.string().regex(/^[a-f0-9]{64}$/) }).strict()

function sendEnabled() {
  return process.env.WORKSITE_PHOTOS_BATCH_SEND_ENABLED === "true" && Boolean(process.env.RESEND_API_KEY?.trim())
}

async function loadBatch(db: Prisma.TransactionClient, companyId: string, worksiteId: string, lock = false) {
  if (lock) {
    await db.$queryRaw`SELECT "id" FROM "worksites"
      WHERE "companyId" = ${companyId} AND "id" = ${worksiteId} FOR UPDATE`
  }
  const worksite = await db.worksite.findFirst({
    where: { id: worksiteId, companyId },
    select: {
      name: true,
      photoRecipients: {
        where: { active: true },
        orderBy: [{ position: "asc" }, { id: "asc" }],
        select: { label: true, email: true },
      },
    },
  })
  if (!worksite) throw new WorksitePhotoDomainError("WORKSITE_NOT_FOUND", 404)
  const photos = await db.$queryRaw<DeliveryPhoto[]>`
    SELECT "id", "driveFileId", "mimeType", "sizeBytes", "sha256", "deliveryClaim"
    FROM "worksite_truck_photos"
    WHERE "companyId" = ${companyId} AND "worksiteId" = ${worksiteId}
      AND "status" = 'PENDING' AND "approvedAt" IS NOT NULL
      AND "rejectRequestedAt" IS NULL AND "trashRequestedAt" IS NULL
    ORDER BY "id" LIMIT ${MAX_DELIVERY_PHOTOS + 1} ${lock ? Prisma.sql`FOR UPDATE` : Prisma.empty}
  `
  const count = photos.length <= MAX_DELIVERY_PHOTOS ? photos.length : await db.worksiteTruckPhoto.count({
    where: { companyId, worksiteId, status: "PENDING", approvedAt: { not: null }, rejectRequestedAt: null, trashRequestedAt: null },
  })
  return { worksiteName: worksite.name, recipients: worksite.photoRecipients, photos, count }
}

async function authorize(params: Promise<{ worksiteId: string }>, deps: ReturnType<typeof productionPhotoDeps>) {
  const session = await deps.auth()
  if (!session?.user?.id) throw new WorksitePhotoDomainError("UNAUTHENTICATED", 401)
  if (!await canReadPhotoRecipients(prisma, session)) throw new WorksitePhotoDomainError("FORBIDDEN", 403)
  if (!deps.reviewDb) throw new WorksitePhotoDomainError("SERVER_ERROR", 500)
  const admin = await resolveSuperAdmin(session, { reviewDb: deps.reviewDb, storage: deps.storage })
  const id = worksiteIdSchema.safeParse((await params).worksiteId)
  if (!id.success) throw new WorksitePhotoDomainError("WORKSITE_NOT_FOUND", 404)
  return { admin, worksiteId: id.data }
}

export async function GET(request: Request, context: { params: Promise<{ worksiteId: string }> }) {
  const deps = productionPhotoDeps()
  return photoRoute(request, deps, async () => {
    const { admin, worksiteId } = await authorize(context.params, deps)
    const batch = await loadBatch(prisma, admin.companyId, worksiteId)
    return photoJson({
      worksiteName: batch.worksiteName,
      recipients: batch.recipients,
      photoCount: batch.count,
      snapshot: deliverySnapshot(batch),
      blocked: deliveryBlock(batch),
      enabled: sendEnabled(),
    })
  })
}

export async function POST(request: Request, context: { params: Promise<{ worksiteId: string }> }) {
  const deps = productionPhotoDeps()
  return photoRoute(request, deps, async () => {
    const { admin, worksiteId } = await authorize(context.params, deps)
    const apiKey = process.env.RESEND_API_KEY?.trim()
    if (!sendEnabled() || !apiKey) throw new WorksitePhotoDomainError("DELIVERY_DISABLED", 409)
    const bytes = await readBoundedBodyBytes(request, 1024)
    let input: unknown
    try {
      input = JSON.parse(new TextDecoder().decode(bytes))
    } catch {
      throw new WorksitePhotoDomainError("INVALID_JSON", 400)
    }
    const parsed = confirmation.safeParse(input)
    if (!parsed.success) throw new WorksitePhotoDomainError("INVALID_PAYLOAD", 400)

    const { companyId, userId, displayName } = admin
    const batch = await loadBatch(prisma, companyId, worksiteId)
    const resend = new Resend(apiKey)
    const from = process.env.WORKSITE_PHOTOS_FROM_EMAIL?.trim() || "GALYA Events <noreply@galyaevents.fr>"
    const result = await deliverWorksitePhotos(companyId, batch, parsed.data.snapshot, {
      storage: deps.storage,
      async claim(snapshot) {
        return prisma.$transaction(async (tx) => {
          await tx.$queryRaw`SELECT "id" FROM "users" WHERE "id" = ${userId} FOR SHARE`
          await tx.$queryRaw`SELECT "id" FROM "companies" WHERE "id" = ${companyId} FOR SHARE`
          const user = await tx.user.findFirst({ where: { id: userId, active: true, role: "SUPER_ADMIN" }, select: { id: true } })
          const company = await tx.company.findFirst({ where: { id: companyId, active: true }, select: { id: true } })
          if (!user || !company) throw new WorksitePhotoDomainError("FORBIDDEN", 403)
          const current = await loadBatch(tx, companyId, worksiteId, true)
          assertDeliverySnapshot(current, snapshot)
          const claim = randomUUID()
          const photoIds = current.photos.map(({ id }) => id)
          const reserved = await tx.$executeRaw`UPDATE "worksite_truck_photos" SET "deliveryClaim" = ${claim}::uuid
            WHERE "companyId" = ${companyId} AND "worksiteId" = ${worksiteId}
              AND "id" IN (${Prisma.join(photoIds)})`
          if (reserved !== photoIds.length) throw new Error("Delivery batch changed")
          await tx.worksitePhotoEvent.create({ data: {
            companyId, worksiteId, action: "DELIVERY_REQUESTED", actorKind: "USER", actorId: userId,
            actorNameSnapshot: displayName, outcome: "DONE", detail: { claim, photoCount: current.photos.length },
          } })
          return claim
        })
      },
      async send(message, claim) {
        const response = await resend.emails.send({ from, ...message, tags: [{ name: "photo_batch", value: claim }] }, { idempotencyKey: `worksite-photos/${claim}` })
        if (response.data?.id) return { acceptedId: response.data.id }
        if (response.error?.name === "validation_error") return { rejected: true }
        throw new Error("Delivery result unconfirmed")
      },
      async release(claim) {
        await prisma.$executeRaw`UPDATE "worksite_truck_photos" SET "deliveryClaim" = NULL
          WHERE "deliveryClaim" = ${claim}::uuid AND "companyId" = ${companyId} AND "worksiteId" = ${worksiteId}`
      },
      async finish(claim, recipients, acceptedId) {
        await prisma.$transaction(async (tx) => {
          const count = await tx.$executeRaw`UPDATE "worksite_truck_photos"
            SET "deliveryClaim" = NULL, "status" = 'SENT', "sentAt" = clock_timestamp(),
                "sentByAgent" = ${`user:${userId}`}, "sentTo" = ${recipients.join(", ")},
                "sentMessageId" = ${acceptedId}, "sentTransportKind" = 'provider:resend',
                "sentTransportRef" = ${acceptedId}
            WHERE "deliveryClaim" = ${claim}::uuid AND "companyId" = ${companyId} AND "worksiteId" = ${worksiteId}`
          if (count !== batch.photos.length) throw new Error("Delivery claim changed")
          await tx.worksitePhotoEvent.create({ data: {
            companyId, worksiteId, action: "SENT", actorKind: "USER", actorId: userId,
            actorNameSnapshot: displayName, outcome: "DONE", detail: { claim, photoCount: count, recipientCount: recipients.length },
          } })
        })
      },
    })
    return photoJson(result)
  })
}
