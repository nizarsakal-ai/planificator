import { NextResponse } from "next/server"
import { auth } from "@/auth"
import { prisma } from "@/lib/prisma"
import { v2 as cloudinary } from "cloudinary"

function parseCloudinaryUrl(url: string): {
  resourceType: "image" | "video" | "raw"
  publicId: string
} | null {
  let resourceType: "image" | "video" | "raw" = "raw"
  if (url.includes("/image/upload/")) resourceType = "image"
  else if (url.includes("/video/upload/")) resourceType = "video"

  // Capture tout après /upload/ (avec ou sans version v1234567/)
  const match = url.match(/\/upload\/(?:v\d+\/)?(.+)$/)
  if (!match) return null

  return { resourceType, publicId: match[1] }
}

function getMimeType(stored: string | null, filename: string): string {
  if (stored && stored !== "application/octet-stream") return stored
  const lower = filename.toLowerCase()
  if (lower.endsWith(".pdf"))  return "application/pdf"
  if (lower.endsWith(".docx")) return "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  if (lower.endsWith(".xlsx")) return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  if (lower.endsWith(".doc"))  return "application/msword"
  if (lower.endsWith(".xls"))  return "application/vnd.ms-excel"
  if (lower.endsWith(".png"))  return "image/png"
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg"
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
    select: { url: true, name: true, mimeType: true },
  })

  if (!doc) {
    return new NextResponse("Document introuvable", { status: 404 })
  }

  if (!doc.url.includes("cloudinary.com")) {
    return NextResponse.redirect(doc.url)
  }

  const parts = parseCloudinaryUrl(doc.url)
  if (!parts) {
    return NextResponse.redirect(doc.url)
  }

  // private_download_url génère une URL API Cloudinary signée (api.cloudinary.com)
  // avec api_key + timestamp + signature dans les query params.
  // Contrairement au CDN (res.cloudinary.com), cette URL API accepte toujours
  // les requêtes authentifiées, même pour les fichiers raw/restreints.
  const signedApiUrl = cloudinary.utils.private_download_url(
    parts.publicId,
    "", // format vide : pour les raw files, l'extension est déjà dans le publicId
    {
      resource_type: parts.resourceType,
      type: "upload",
      attachment: false, // on gère Content-Disposition nous-mêmes
    }
  )

  let response: Response
  try {
    response = await fetch(signedApiUrl)
  } catch (err) {
    console.error("[documents] fetch error:", err)
    return new NextResponse("Impossible de récupérer le fichier", { status: 502 })
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "")
    console.error("[documents] Cloudinary API error:", response.status, body)
    return new NextResponse(`Erreur Cloudinary: ${response.status}`, { status: 502 })
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
