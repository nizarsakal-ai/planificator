import { NextResponse } from "next/server"
import { auth } from "@/auth"
import { prisma } from "@/lib/prisma"
import { v2 as cloudinary } from "cloudinary"

/**
 * Parse une URL Cloudinary pour extraire resourceType, publicId et format.
 *
 * - image/video : l'extension dans l'URL est le FORMAT, pas dans le public_id
 *   ex: .../image/upload/v123/folder/file.pdf → publicId="folder/file", format="pdf"
 *
 * - raw : l'extension fait partie du public_id
 *   ex: .../raw/upload/v123/folder/file.pdf → publicId="folder/file.pdf", format=""
 */
function parseCloudinaryUrl(url: string): {
  resourceType: "image" | "video" | "raw"
  publicId: string
  format: string
} | null {
  let resourceType: "image" | "video" | "raw" = "raw"
  if (url.includes("/image/upload/")) resourceType = "image"
  else if (url.includes("/video/upload/")) resourceType = "video"

  const match = url.match(/\/upload\/(?:v\d+\/)?(.+)$/)
  if (!match) return null

  let publicId = match[1]
  let format = ""

  // Pour image et video, l'extension est le format — elle ne fait PAS partie du public_id
  if (resourceType !== "raw") {
    const extMatch = publicId.match(/^(.+)\.([^.]+)$/)
    if (extMatch) {
      publicId = extMatch[1]
      format = extMatch[2]
    }
  }

  return { resourceType, publicId, format }
}

function getMimeType(stored: string | null, filename: string): string {
  if (stored && stored !== "application/octet-stream") return stored
  const lower = filename.toLowerCase()
  if (lower.endsWith(".pdf"))  return "application/pdf"
  if (lower.endsWith(".docx")) return "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  if (lower.endsWith(".xlsx")) return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  if (lower.endsWith(".doc"))  return "application/msword"
  if (lower.endsWith(".xls"))  return "application/vnd.ms-excel"
  return "application/octet-stream"
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth()
  if (!session?.user) {
    return new NextResponse("Non autorisé", { status: 401 })
  }

  const { id } = await params
  const forceDownload = new URL(req.url).searchParams.get("dl") === "1"

  const doc = await prisma.document.findFirst({
    where: { id, worksite: { companyId: session.user.companyId! } },
    select: {
      url: true,
      name: true,
      mimeType: true,
      sourceAcquisitionAttachmentId: true,
    },
  })

  if (!doc) {
    return new NextResponse("Document introuvable", { status: 404 })
  }

  // PLAN-ACQ-005D — bridge : accès via route attachments (pas d’URL stockée)
  if (doc.sourceAcquisitionAttachmentId) {
    const dl = forceDownload ? "?dl=1" : ""
    return NextResponse.redirect(
      new URL(`/api/acquisition/attachments/${doc.sourceAcquisitionAttachmentId}${dl}`, req.url)
    )
  }

  if (!doc.url) {
    return new NextResponse("Document introuvable", { status: 404 })
  }

  if (!doc.url.includes("cloudinary.com")) {
    return NextResponse.redirect(doc.url)
  }

  const parts = parseCloudinaryUrl(doc.url)
  console.log("[documents] url:", doc.url)
  console.log("[documents] parsed:", parts)

  if (!parts) {
    return NextResponse.redirect(doc.url)
  }

  // private_download_url génère une URL signée via l'API Cloudinary (api.cloudinary.com).
  // Elle fonctionne même pour les fichiers "Blocked for delivery" car elle utilise
  // api_key + timestamp + signature — pas le CDN public.
  const apiDownloadUrl = cloudinary.utils.private_download_url(
    parts.publicId,
    parts.format, // "pdf" pour les PDFs image-type, "" pour les raw
    {
      resource_type: parts.resourceType,
      type: "upload",
      attachment: false,
    }
  )
  console.log("[documents] api url:", apiDownloadUrl)

  let response: Response
  try {
    response = await fetch(apiDownloadUrl)
  } catch (err) {
    console.error("[documents] fetch error:", err)
    return new NextResponse("Impossible de récupérer le fichier", { status: 502 })
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "")
    console.error("[documents] error:", response.status, body)
    return new NextResponse(`Erreur ${response.status}`, { status: 502 })
  }

  const buffer = await response.arrayBuffer()
  const contentType = getMimeType(doc.mimeType, doc.name)
  const disposition = forceDownload
    ? `attachment; filename="${encodeURIComponent(doc.name)}"`
    : `inline; filename="${encodeURIComponent(doc.name)}"`

  return new NextResponse(buffer, {
    headers: {
      "Content-Type":        contentType,
      "Content-Disposition": disposition,
      "Cache-Control":       "private, max-age=3600",
    },
  })
}
