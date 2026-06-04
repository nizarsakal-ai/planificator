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
  let response: Response
  try {
    response = await fetch(doc.url, { headers: { "User-Agent": "Planificator/1.0" } })
  } catch (err) {
    console.error("[documents] fetch error:", err)
    return new NextResponse("Impossible de récupérer le fichier", { status: 502 })
  }

  if (!response.ok) {
    console.error("[documents] Cloudinary response:", response.status, doc.url)
    return new NextResponse(`Cloudinary: ${response.status}`, { status: 502 })
  }

  const buffer = await response.arrayBuffer()

  // Détecter le Content-Type : depuis la DB, puis depuis la réponse Cloudinary, puis depuis l'extension
  let contentType = doc.mimeType ?? response.headers.get("content-type") ?? ""
  if (!contentType || contentType === "application/octet-stream") {
    const lower = doc.name.toLowerCase()
    if (lower.endsWith(".pdf"))  contentType = "application/pdf"
    else if (lower.endsWith(".docx")) contentType = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    else if (lower.endsWith(".xlsx")) contentType = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    else contentType = "application/octet-stream"
  }

  const isPdf = contentType.includes("pdf")
  const disposition = isPdf
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
