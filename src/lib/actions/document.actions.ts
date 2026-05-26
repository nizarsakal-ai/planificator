"use server"

import { auth } from "@/auth"
import { prisma } from "@/lib/prisma"
import { revalidatePath } from "next/cache"
import { writeFile, unlink } from "fs/promises"
import path from "path"
import { DocumentType } from "@prisma/client"

export async function uploadDocument(formData: FormData) {
  const session = await auth()
  if (!session?.user || !["ADMIN", "SUPER_ADMIN"].includes(session.user.role)) {
    return { error: "Non autorisé" }
  }

  const worksiteId = formData.get("worksiteId") as string
  const type = formData.get("type") as DocumentType
  const file = formData.get("file") as File

  if (!file || !worksiteId) return { error: "Fichier manquant" }

  // Vérifier que le chantier appartient à l'entreprise
  const worksite = await prisma.worksite.findFirst({
    where: { id: worksiteId, companyId: session.user.companyId! },
  })
  if (!worksite) return { error: "Chantier introuvable" }

  const bytes = await file.arrayBuffer()
  const buffer = Buffer.from(bytes)

  // Nom unique pour éviter les collisions
  const ext = path.extname(file.name)
  const uniqueName = `${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`
  const uploadPath = path.join(process.cwd(), "public", "uploads", uniqueName)

  await writeFile(uploadPath, buffer)

  await prisma.document.create({
    data: {
      worksiteId,
      name: file.name,
      url: `/uploads/${uniqueName}`,
      size: file.size,
      mimeType: file.type,
      type: type || DocumentType.DOCUMENT,
    },
  })

  revalidatePath(`/chantiers/${worksiteId}`)
  return { success: true }
}

export async function deleteDocument(documentId: string, worksiteId: string) {
  const session = await auth()
  if (!session?.user || !["ADMIN", "SUPER_ADMIN"].includes(session.user.role)) {
    return { error: "Non autorisé" }
  }

  const doc = await prisma.document.findFirst({
    where: {
      id: documentId,
      worksite: { companyId: session.user.companyId! },
    },
  })
  if (!doc) return { error: "Document introuvable" }

  // Supprimer le fichier physique
  try {
    const filePath = path.join(process.cwd(), "public", doc.url)
    await unlink(filePath)
  } catch {
    // Fichier déjà supprimé, on continue
  }

  await prisma.document.delete({ where: { id: documentId } })

  revalidatePath(`/chantiers/${worksiteId}`)
  return { success: true }
}
