import { NextResponse } from "next/server"
import { auth } from "@/auth"
import { prisma } from "@/lib/prisma"
import { v2 as cloudinary } from "cloudinary"

/**
 * Extrait le resource_type et le public_id depuis une URL Cloudinary.
 * Pour les raw uploads, le public_id inclut l'extension (ex: "folder/file.pdf").
 */
function parseCloudinaryUrl(url: string): {
  resourceType: "image" | "video" | "raw"
  publicId: string
} | null {
  let resourceType: "image" | "video" | "raw" = "raw"
  if (url.includes("/image/upload/")) resourceType = "image"
  else if (url.includes("/video/upload/")) resourceType = "video"

  // Capturer tout ce qui suit /upload/ en ignorant la version optionnelle (v1234567/)
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

  if (!doc.url.includes("cloudinary.com")) {
    return NextResponse.redirect(doc.url)
  }

  const parts = parseCloudinaryUrl(doc.url)
  if (!parts) {
    return NextResponse.redirect(doc.url)
  }

  // private_download_url génère une URL signée via l'API Cloudinary (pas le CDN).
  // La signature (api_key + timestamp + secret) est incluse dans les paramètres →
  // le navigateur peut y accéder directement sans passer par notre serveur.
  // attachment:true force Content-Disposition: attachment → téléchargement immédiat.
  const downloadUrl = cloudinary.utils.private_download_url(
    parts.publicId,
    "",  // format vide : le publicId des raw files inclut déjà l'extension
    {
      resource_type: parts.resourceType,
      attachment: true,
    }
  )

  return NextResponse.redirect(downloadUrl, 302)
}
