import { randomUUID } from "node:crypto"
import { NextResponse } from "next/server"
import { auth } from "@/auth"
import { cloudinaryAttachmentStorage } from "@/lib/acquisition/attachments/attachment-storage.port"

const ALLOWED_COMPANY_ID = "cmpqqqyfy0001f5x2blt5qjkh"
const REQUIRED_PREFIX = "planificator-staging"

export async function POST(): Promise<Response> {
  const session = await auth()

  if (!session?.user?.id) {
    return new NextResponse("Non autorisé", { status: 401 })
  }

  if (session.user.role !== "SUPER_ADMIN") {
    return new NextResponse("Interdit", { status: 403 })
  }

  if (
    session.user.companyId !== ALLOWED_COMPANY_ID ||
    process.env.VERCEL_ENV !== "preview" ||
    process.env.ACQUISITION_ATTACHMENT_CLOUDINARY_FOLDER_PREFIX !== REQUIRED_PREFIX
  ) {
    return new NextResponse("Environnement de test refusé", { status: 403 })
  }

  const testId = randomUUID()
  const expectedPrefix = `${REQUIRED_PREFIX}/${session.user.companyId}/acquisition/`

  const stored = await cloudinaryAttachmentStorage.store({
    companyId: session.user.companyId,
    acquisitionMessageId: `cloudinary-test-${testId}`,
    attachmentId: `attachment-${testId}`,
    buffer: Buffer.from("planificator-staging-cloudinary-prefix-test", "utf8"),
    mimeType: "text/plain",
    generatedFilename: `probe-${testId}.txt`,
  })

  if (!stored.created) {
    return NextResponse.json(
      {
        ok: false,
        reason: "UNEXPECTED_COLLISION",
        storagePublicId: stored.storagePublicId,
      },
      { status: 409 }
    )
  }

  const prefixValid = stored.storagePublicId.startsWith(expectedPrefix)

  try {
    await cloudinaryAttachmentStorage.destroy({
      storagePublicId: stored.storagePublicId,
    })
  } catch {
    return NextResponse.json(
      {
        ok: false,
        prefixValid,
        cleanup: "FAILED",
        storagePublicId: stored.storagePublicId,
      },
      { status: 500 }
    )
  }

  return NextResponse.json({
    ok: prefixValid,
    prefixValid,
    cleanup: "OK",
    storagePublicId: stored.storagePublicId,
  })
}
