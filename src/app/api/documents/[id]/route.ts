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

  const match = url.match(/\/upload\/(?:v\d+\/)?(.+)$/)
  if (!match) return null

  return { resourceType, publicId: match[1] }
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

  // URL signée CDN Cloudinary — accessible directement par le navigateur.
  // sign_url:true intègre la signature dans l'URL → fonctionne même pour les fichiers
  // en accès restreint. fl_attachment force le téléchargement si ?dl=1.
  const signedUrl = cloudinary.url(parts.publicId, {
    resource_type: parts.resourceType,
    secure: true,
    sign_url: true,
    ...(forceDownload ? { flags: "attachment" } : {}),
  })

  return NextResponse.redirect(signedUrl, 302)
}
