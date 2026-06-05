import { NextResponse } from "next/server"
import { auth } from "@/auth"
import { prisma } from "@/lib/prisma"
import { v2 as cloudinary } from "cloudinary"

/**
 * Extrait le resource_type et le public_id depuis une URL Cloudinary.
 * Ex: https://res.cloudinary.com/{cloud}/raw/upload/v1234/{folder}/{file}.pdf
 *  → { resourceType: "raw", publicId: "{folder}/{file}.pdf" }
 */
function parseCloudinaryUrl(url: string): {
  resourceType: "image" | "video" | "raw"
  publicId: string
} | null {
  let resourceType: "image" | "video" | "raw" = "raw"
  if (url.includes("/image/upload/")) resourceType = "image"
  else if (url.includes("/video/upload/")) resourceType = "video"

  // Capturer tout ce qui suit /upload/ ou /upload/vXXX/
  const match = url.match(/\/upload\/(?:v\d+\/)?(.+)$/)
  if (!match) return null

  return { resourceType, publicId: match[1] }
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth()
  if (!session?.user) {
    return new NextResponse("Non autorisé", { status: 401 })
  }

  const { id } = await params

  const doc = await prisma.document.findFirst({
    where: { id, worksite: { companyId: session.user.companyId! } },
    select: { url: true, name: true },
  })

  if (!doc) {
    return new NextResponse("Document introuvable", { status: 404 })
  }

  // Pour les URLs non-Cloudinary, redirection directe
  if (!doc.url.includes("cloudinary.com")) {
    return NextResponse.redirect(doc.url)
  }

  const parts = parseCloudinaryUrl(doc.url)
  if (!parts) {
    return NextResponse.redirect(doc.url)
  }

  // URL signée avec fl_attachment — le navigateur télécharge directement depuis Cloudinary
  // La signature garantit l'accès même pour les fichiers raw (PDF, DOCX, XLSX)
  const signedUrl = cloudinary.url(parts.publicId, {
    resource_type: parts.resourceType,
    secure: true,
    sign_url: true,
    flags: "attachment",
  })

  return NextResponse.redirect(signedUrl)
}
