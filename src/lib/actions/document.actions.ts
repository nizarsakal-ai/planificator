"use server"

import { auth } from "@/auth"
import { prisma } from "@/lib/prisma"
import { revalidatePath } from "next/cache"
import { v2 as cloudinary } from "cloudinary"
import { DocumentType } from "@prisma/client"

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
})

export async function uploadDocument(formData: FormData) {
  const session = await auth()
  if (!session?.user || !["ADMIN", "SUPER_ADMIN"].includes(session.user.role)) {
    return { error: "Non autorisé" }
  }

  const worksiteId = formData.get("worksiteId") as string
  const type       = formData.get("type") as DocumentType
  const file       = formData.get("file") as File

  if (!file || !worksiteId) return { error: "Fichier manquant" }

  const worksite = await prisma.worksite.findFirst({
    where: { id: worksiteId, companyId: session.user.companyId! },
  })
  if (!worksite) return { error: "Chantier introuvable" }

  const bytes  = await file.arrayBuffer()
  const buffer = Buffer.from(bytes)

  // Upload vers Cloudinary
  const result = await new Promise<{ secure_url: string; public_id: string }>((resolve, reject) => {
    cloudinary.uploader.upload_stream(
      {
        folder:        `planificator/${session.user.companyId}/${worksiteId}`,
        resource_type: "auto",
        use_filename:  true,
        unique_filename: true,
      },
      (err, res) => {
        if (err || !res) return reject(err ?? new Error("Upload failed"))
        resolve(res as { secure_url: string; public_id: string })
      }
    ).end(buffer)
  })

  await prisma.document.create({
    data: {
      worksiteId,
      name:     file.name,
      url:      result.secure_url,
      size:     file.size,
      mimeType: file.type,
      type:     type || DocumentType.DOCUMENT,
      // On stocke le public_id dans metadata si on veut supprimer plus tard
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
      id:      documentId,
      worksite: { companyId: session.user.companyId! },
    },
  })
  if (!doc) return { error: "Document introuvable" }

  // Supprimer sur Cloudinary si l'URL est cloudinary
  if (doc.url.includes("cloudinary.com")) {
    try {
      // Extraire le public_id depuis l'URL Cloudinary
      const matches = doc.url.match(/\/v\d+\/(.+)\.[a-z]+$/)
      if (matches?.[1]) {
        await cloudinary.uploader.destroy(matches[1], { resource_type: "auto" })
      }
    } catch {
      // On continue même si la suppression Cloudinary échoue
    }
  }

  await prisma.document.delete({ where: { id: documentId } })
  revalidatePath(`/chantiers/${worksiteId}`)
  return { success: true }
}
