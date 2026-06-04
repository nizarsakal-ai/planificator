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
    select: { url: true, name: true, mimeType: true },
  })

  if (!doc) {
    return new NextResponse("Document introuvable", { status: 404 })
  }

  // Récupérer le fichier depuis Cloudinary
  const response = await fetch(doc.url)
  if (!response.ok) {
    return new NextResponse("Erreur lors du chargement du fichier", { status: 502 })
  }

  const buffer = await response.arrayBuffer()

  // Déterminer le Content-Type
  const contentType = doc.mimeType ?? "application/octet-stream"

  // Pour les PDFs : inline (ouvrir dans le navigateur)
  // Pour les autres : attachment (télécharger)
  const disposition = contentType === "application/pdf"
    ? `inline; filename="${encodeURIComponent(doc.name)}"`
    : `attachment; filename="${encodeURIComponent(doc.name)}"`

  return new NextResponse(buffer, {
    headers: {
      "Content-Type":        contentType,
      "Content-Disposition": disposition,
      "Cache-Control":       "private, max-age=3600",
    },
  })
}
