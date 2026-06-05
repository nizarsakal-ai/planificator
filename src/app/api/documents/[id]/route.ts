import { NextResponse } from "next/server"
import { auth } from "@/auth"
import { prisma } from "@/lib/prisma"

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
    where: {
      id,
      worksite: { companyId: session.user.companyId! },
    },
    select: { url: true, name: true },
  })

  if (!doc) {
    return new NextResponse("Document introuvable", { status: 404 })
  }

  // Rediriger vers Cloudinary avec fl_attachment pour forcer le téléchargement
  // Cloudinary gère lui-même le Content-Disposition, pas besoin de proxy
  const downloadUrl = doc.url.replace("/upload/", "/upload/fl_attachment/")
  return NextResponse.redirect(downloadUrl)
}
