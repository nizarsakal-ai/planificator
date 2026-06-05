import { NextResponse } from "next/server"
import { auth } from "@/auth"
import { prisma } from "@/lib/prisma"

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

  console.log("[documents] Fetching:", doc.url)

  // Fetch direct depuis l'URL Cloudinary stockée en base.
  // Les fichiers uploadés en mode "upload" (défaut) sont publics.
  let response: Response
  try {
    response = await fetch(doc.url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; Planificator/1.0)",
        "Accept": "*/*",
      },
    })
  } catch (err) {
    console.error("[documents] fetch error:", err)
    return new NextResponse("Impossible de récupérer le fichier", { status: 502 })
  }

  if (!response.ok) {
    console.error("[documents] HTTP error:", response.status, "URL:", doc.url)
    return new NextResponse(`Erreur ${response.status} lors de la récupération`, { status: 502 })
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
